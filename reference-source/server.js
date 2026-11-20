#!/usr/bin/env node
'use strict';

/**
 * 本地软件源 - VS Code Gallery 兼容 HTTP 服务
 *
 * 协议与官方软件源一致：
 *   POST /vscode/gallery/extensionquery   扩展查询（VS Code Gallery 协议）
 *   POST /api/nac/admin/list              应用商店首页列表
 *   GET  /vscode/gallery/asset/<id>       assets 重定向（兼容）
 *   GET  /vscode/item/vscode/<id>         扩展详情页
 *   GET  /plugins/...                     下载 .vsix
 *   GET  /assets/...                      图标 / README / LICENSE
 *
 * 用法：node repo/server.js
 *   REPO_PORT    监听端口，默认 3000
 *   REPO_HOST    监听地址，默认 0.0.0.0（局域网内所有机器均可访问）
 *   REPO_BASE_URL  对外暴露的基础地址；默认自动探测本机局域网 IP
 *
 * 返回给客户端的资源地址按「请求 Host」动态生成：局域网客户端访问时，
 * 图标 / README / VSIX 下载等 URL 自动指向服务器局域网地址，本机访问时
 * 自动回退 127.0.0.1，三个预置扩展（file-match-compare / markdown-commonmark-preview
 * / appstore-hub）在本机与局域网下均可正常浏览与下载。
 *
 * 高并发优化（30 人同时访问，详见 性能优化.md）：
 *   1. /api/nac/admin/list 结果按 metadata mtime 缓存，消除每请求同步磁盘 I/O；
 *   2. JSON/文本响应按客户端 Accept-Encoding 协商 gzip（内容寻址缓存压缩结果）；
 *   3. 静态资源（图标/README/VSIX）增加 ETag / Last-Modified / Cache-Control，
 *      支持 If-None-Match 命中返回 304；
 *   4. POST 请求体限制 1MB（超限 413），防止内存被恶意撑爆；
 *   5. extensionquery 过滤条件预计算索引（大小写、拼接、引擎版本），语义不变；
 *   6. metadata.json 变更（mtime 变化）自动热加载，解析失败回退上次有效数据。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const REPO_DIR = __dirname;
const ASSETS_DIR = path.join(REPO_DIR, 'assets');
const METADATA_FILE = path.join(REPO_DIR, 'metadata.json');
const PORT = Number(process.env.REPO_PORT || 3000);
const HOST = process.env.REPO_HOST || '0.0.0.0';

/** 探测本机第一个非回环 IPv4 地址，作为局域网访问入口 */
function detectLanIp() {
  try {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  return '127.0.0.1';
}

const DISPLAY_HOST = HOST === '0.0.0.0' || HOST === '::' ? detectLanIp() : HOST;
const BASE_URL = process.env.REPO_BASE_URL || `http://${DISPLAY_HOST}:${PORT}`;

const MIME = {
  '.vsix': 'application/octet-stream',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ============ gzip 压缩（F2） ============

/** 响应体小于该字节数不压缩（避免无谓 CPU）；文本类静态文件适用同一阈值 */
const GZIP_MIN_BYTES = 512;
/** 内容寻址 gzip 缓存上限：键为最终响应体字符串，命中直接复用，避免重复 gzipSync */
const GZIP_CACHE_MAX = 32;
const gzipCache = new Map();

/** 客户端是否接受 gzip（严格按 Accept-Encoding 逗号分隔匹配） */
function acceptsGzip(req) {
  const ae = req && req.headers && req.headers['accept-encoding'];
  return typeof ae === 'string' && /(^|,)\s*gzip\s*(,|$)/i.test(ae);
}

/** 内容寻址 gzip：相同响应体只压缩一次，命中直接返回缓存结果 */
function gzipWithCache(buf, body) {
  let gz = gzipCache.get(body);
  if (!gz) {
    gz = zlib.gzipSync(buf);
    if (gzipCache.size >= GZIP_CACHE_MAX) {
      gzipCache.clear();
    }
    gzipCache.set(body, gz);
  }
  return gz;
}

// ============ metadata 加载与热更新（F6）+ 过滤索引（F5） ============

let meta = null; // 当前有效 metadata（解析失败时保留上一次有效数据）
let metaMtime = -1; // 最近一次成功加载的 metadata.json mtime
let searchIndex = []; // 与 meta.extensions 平行的预计算过滤索引

/** 由 metadata 重建过滤索引：语义与旧实现逐条对齐（见 handleExtensionQuery） */
function rebuildSearchIndex(obj) {
  searchIndex = (obj.extensions || []).map((e) => {
    const v0 = (e.versions && e.versions[0]) || {};
    const props = v0.properties || [];
    const engine =
      (props.find((p) => p.key === 'Microsoft.VisualStudio.Code.Engine') || {}).value || '';
    const em = /^[~^]?(\d+)\.(\d+)/.exec(engine);
    const pubName = String(((e.publisher || {}).publisherName) || '');
    const extName = String(e.extensionName || '');
    return {
      e,
      // filterType 10：名称/展示名/发布者/简介
      searchLower: [extName, e.displayName, pubName, e.shortDescription]
        .join(' ')
        .toLowerCase(),
      // filterType 6：名称/展示名/简介（不含发布者，与旧实现一致）
      searchLowerNoPub: [extName, e.displayName, e.shortDescription].join(' ').toLowerCase(),
      extNameLower: extName.toLowerCase(),
      pubNameLower: pubName.toLowerCase(),
      idLower: `${pubName}.${extName}`.toLowerCase(),
      targetPlatform: v0.targetPlatform,
      // filterType 7：引擎版本主次号（解析失败视为兼容，与旧实现 return true 一致）
      engineMaj: em ? Number(em[1]) : null,
      engineMin: em ? Number(em[2]) : null,
    };
  });
}

function loadMetadataFromDisk() {
  const stat = fs.statSync(METADATA_FILE);
  const obj = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  return { obj, mtime: stat.mtimeMs };
}

/** 获取当前 metadata；mtime 变化时热加载，解析失败保留上次有效数据 */
function getMeta() {
  try {
    const stat = fs.statSync(METADATA_FILE);
    if (stat.mtimeMs !== metaMtime) {
      const next = loadMetadataFromDisk();
      meta = next.obj;
      metaMtime = next.mtime;
      rebuildSearchIndex(meta);
      console.log(
        `[server] metadata.json 已热加载（${(meta.extensions || []).length} 个扩展）`
      );
    }
  } catch (e) {
    console.error(
      `[server] metadata.json 重新加载失败，继续使用上次数据: ${e.message}`
    );
  }
  return meta;
}

// 启动时加载（保持原行为：文件缺失直接退出）
(function initMeta() {
  if (!fs.existsSync(METADATA_FILE)) {
    console.error(`元数据文件不存在: ${METADATA_FILE}，请先运行: node repo/build.js`);
    process.exit(1);
  }
  const loaded = loadMetadataFromDisk();
  meta = loaded.obj;
  metaMtime = loaded.mtime;
  rebuildSearchIndex(meta);
})();

// ============ nacl 首页列表缓存（F1） ============

// 键为 metadata mtime：build.js 重新生成（mtime 变化）时自动重建
let naclCache = { mtime: -1, content: null };

function getNaclContent() {
  if (naclCache.mtime === metaMtime && naclCache.content) {
    return naclCache.content;
  }
  const content = meta.extensions.map((e) => {
    const v = (e.versions && e.versions[0]) || {};
    const id = `${e.publisher.publisherName}.${e.extensionName}`;
    const iconFile = path.join(ASSETS_DIR, id, 'icon.png');
    let imageContent = '';
    if (fs.existsSync(iconFile)) {
      imageContent = fs.readFileSync(iconFile).toString('base64');
    }
    const readmeFile = path.join(ASSETS_DIR, id, 'README.md');
    let readme = '';
    if (fs.existsSync(readmeFile)) {
      readme = fs.readFileSync(readmeFile, 'utf-8');
    }
    const markdown = `# ${e.displayName}

${e.shortDescription || ''}

- **ID**: \`${id}\`
- **版本**: ${v.version}
- **发布者**: ${e.publisher.publisherName}
- **分类**: ${(e.categories || []).join(', ') || 'Other'}

---

${readme.slice(0, 4000)}`;
    return {
      imageContent,
      markdownContent: Buffer.from(markdown, 'utf-8').toString('base64'),
      address: `${BASE_URL}/vscode/item/vscode/${id}`,
    };
  });
  naclCache = { mtime: metaMtime, content };
  return content;
}

// ============ 响应工具 ============

/**
 * 将元数据中的资源地址（生成时可能是 127.0.0.1 / localhost / 0.0.0.0）
 * 重写为当前请求的 Host，保证本机与局域网客户端拿到的 URL 均可直接访问。
 */
function rewriteBaseUrl(text, req) {
  const host = (req && req.headers && req.headers.host) || `${DISPLAY_HOST}:${PORT}`;
  const pub = `http://${host}`;
  let out = String(text);
  if (meta && meta.baseUrl) {
    out = out.split(meta.baseUrl).join(pub);
  }
  out = out.split(`http://127.0.0.1:${PORT}`).join(pub);
  out = out.split(`http://localhost:${PORT}`).join(pub);
  out = out.split(`http://0.0.0.0:${PORT}`).join(pub);
  return out;
}

/** 写出响应体（含 CORS 与可选 gzip）；非 gzip 分支与旧行为一致 */
function sendBody(res, status, contentType, body, req, extraHeaders) {
  const headers = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Vary': 'Accept-Encoding',
    ...(extraHeaders || {}),
  };
  const buf = Buffer.from(body, 'utf-8');
  if (buf.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
    const gz = gzipWithCache(buf, body);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res, status, obj, req) {
  let body = JSON.stringify(obj);
  if (req) {
    body = rewriteBaseUrl(body, req);
  }
  sendBody(res, status, 'application/json; charset=utf-8', body, req);
}

/** 可 gzip 的文本类静态资源扩展名（二进制保持流式原样传输） */
const COMPRESSIBLE_EXT = { '.md': 1, '.json': 1, '.txt': 1, '.html': 1, '.css': 1, '.js': 1 };

function sendFile(res, filePath, req) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: 'not found', path: filePath });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': 'public, max-age=60',
    };
    // 条件请求：ETag 命中直接 304（空 body）
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    // 可压缩文本且客户端接受 gzip 且文件够大：读入内存压缩（内容寻址缓存）
    if (COMPRESSIBLE_EXT[ext] && req && acceptsGzip(req) && stat.size >= GZIP_MIN_BYTES) {
      fs.readFile(filePath, (e2, data) => {
        if (e2) {
          sendJson(res, 404, { error: 'not found', path: filePath });
          return;
        }
        const text = data.toString('utf-8');
        const gz = gzipWithCache(data, text);
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        headers['Content-Length'] = gz.length;
        res.writeHead(200, headers);
        res.end(gz);
      });
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ============ 请求体读取（F4：大小限制） ============

const MAX_BODY_BYTES = 1024 * 1024; // 1MB，正常请求 body < 10KB

/**
 * 读取请求体；超过 1MB 立即返回 413 并丢弃后续数据（不中断连接）。
 * 回调仅在未超限时触发。
 */
function readBody(req, res, onEnd) {
  let body = '';
  let size = 0;
  let responded = false;
  req.on('data', (c) => {
    if (responded) {
      return;
    }
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      responded = true;
      body = '';
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    body += c;
  });
  req.on('end', () => {
    if (!responded) {
      onEnd(body);
    }
  });
}

/**
 * 处理 VS Code Gallery extensionquery 请求（协议与官方一致，完整 filterType 支持）
 * 请求体格式：
 * { filters: [{ criteria: [{filterType, value}], pageNumber, pageSize, sortBy, sortOrder }], assetTypes: [], flags }
 * filterType 语义（VS Code Gallery）：
 *   1  = ExtensionName         按扩展名过滤
 *   4  = ExtensionId           按 publisher.extensionName 过滤
 *   5  = Category              按分类过滤
 *   6  = ExtensionTags         按标签过滤（本地源无标签数据，放行）
 *   7  = Target                按 VS Code 版本兼容性过滤
 *   8  = ExcludeWithFlags / IDE 安装目标（值含 VisualStudio.Code 或非数值时放行）
 *   9  = InstallationTarget    安装目标（值含 VisualStudio.Code 时放行）
 *   10 = SearchText            关键字搜索
 *   12 = TargetPlatform        目标平台（无平台声明的扩展放行）
 *   999 = 自定义标记           放行
 * 未知 filterType 一律放行，避免本地插件被误过滤。
 *
 * 过滤基于预计算索引（rebuildSearchIndex），各分支语义与旧实现逐条一致。
 */
function handleExtensionQuery(body, meta, res, req) {
  let reqBody = {};
  try {
    reqBody = JSON.parse(body);
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid json' }, req);
  }

  const filter = (reqBody.filters && reqBody.filters[0]) || {};
  const criteria = filter.criteria || [];
  const pageNumber = Math.max(1, Number(filter.pageNumber) || 1);
  const pageSize = Math.max(1, Number(filter.pageSize) || 100);

  let idxList = searchIndex;

  for (const c of criteria) {
    const type = c.filterType;
    const value = c.value;
    if (value === undefined || value === null || value === '') {
      continue;
    }

    switch (type) {
      case 1: {
        // ExtensionName / Publisher：兼容两种语义
        //   VS Code 官方：值为扩展名（extensionName）
        //   zide-assistant 类客户端：值为发布者（publisher.publisherName）
        const kw = String(value).toLowerCase();
        idxList = idxList.filter(
          (x) => x.extNameLower === kw || x.pubNameLower === kw
        );
        break;
      }
      case 4: {
        // ExtensionId
        const kw = String(value).toLowerCase();
        idxList = idxList.filter((x) => x.idLower === kw);
        break;
      }
      case 5: {
        // Category
        const cat = String(value);
        idxList = idxList.filter((x) => (x.e.categories || []).includes(cat));
        break;
      }
      case 6: {
        // ExtensionTags：本地源无标签数据，按关键字近似匹配，无匹配则放行
        const tag = String(value).toLowerCase();
        idxList = idxList.filter((x) => x.searchLowerNoPub.includes(tag));
        break;
      }
      case 7: {
        // Target / ExtensionName：兼容两种语义
        //   VS Code 官方：值为 VS Code 版本号（如 1.75.0），按引擎版本过滤
        //   zide-assistant 类客户端：值为扩展名（extensionName），按扩展名精确匹配
        const target = String(value);
        const m = /^(\d+)\.(\d+)/.exec(target);
        if (!m) {
          const kw = target.toLowerCase();
          idxList = idxList.filter((x) => x.extNameLower === kw);
          break;
        }
        const tMaj = Number(m[1]);
        const tMin = Number(m[2]);
        idxList = idxList.filter((x) => {
          // 引擎版本无法解析视为兼容（与旧实现 return true 一致）
          if (x.engineMaj === null) {
            return true;
          }
          return x.engineMaj > tMaj || (x.engineMaj === tMaj && x.engineMin >= tMin);
        });
        break;
      }
      case 8:
      case 9: {
        // ExcludeWithFlags / InstallationTarget：本地扩展无 flags/目标限制，一律放行
        // （旧实现两个分支均为 break，等价于放行；此处保持放行语义）
        break;
      }
      case 10: {
        // SearchText
        const kw = String(value).toLowerCase();
        idxList = idxList.filter((x) => x.searchLower.includes(kw));
        break;
      }
      case 12: {
        // TargetPlatform：无平台声明的扩展放行
        const plat = String(value);
        idxList = idxList.filter(
          (x) =>
            !x.targetPlatform || x.targetPlatform === plat || x.targetPlatform === 'universal'
        );
        break;
      }
      default:
        // 未知 / 自定义（如 999）filterType：放行
        break;
    }
  }

  const list = idxList.map((x) => x.e);
  const total = list.length;
  const start = (pageNumber - 1) * pageSize;
  const page = list.slice(start, start + pageSize);

  sendJson(
    res,
    200,
    {
      results: [
        {
          extensions: page,
          resultMetadata: [
            {
              metadataType: 'ResultCount',
              metadataItems: [{ name: 'TotalCount', count: total }],
            },
          ],
        },
      ],
    },
    req
  );
}

/**
 * 处理应用商店首页列表接口（协议与官方一致）
 * POST /api/nac/admin/list
 * 请求: { page, rowsPerPage }
 * 响应: { content: [ { imageContent, markdownContent, address } ] }
 *   imageContent: base64 图片（不含 data: 前缀）
 *   markdownContent: base64 编码的 Markdown 文本
 *   address: 插件详情地址
 *
 * content 计算结果按 metadata mtime 缓存（F1），避免每次请求同步读磁盘 + base64。
 */
function handleNacAdminList(body, meta, res, req) {
  let reqBody = {};
  try {
    reqBody = JSON.parse(body || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid json' }, req);
  }
  const content = getNaclContent();
  sendJson(res, 200, { content }, req);
}

function handleItemPage(id, meta, res, req) {
  const ext = meta.extensions.find(
    (e) => `${e.publisher.publisherName}.${e.extensionName}` === id
  );
  if (!ext) {
    return sendJson(res, 404, { error: `extension ${id} not found` });
  }
  const v = (ext.versions && ext.versions[0]) || {};
  const vsix = (v.files && v.files.find((f) => f.assetType.includes('VSIXPackage')) || {}).source;
  const icon = (v.files && v.files.find((f) => f.assetType.includes('Icons.Default')) || {}).source;
  const readme = (v.files && v.files.find((f) => f.assetType.includes('Content.Details')) || {}).source;
  // 下载链接：VSIX 缺失/URL 非法时优雅降级，避免拖垮整个服务
  let downloadLink = '';
  if (vsix) {
    let fileName = vsix;
    try {
      fileName = path.basename(new URL(vsix).pathname);
    } catch (e) {
      /* URL 非法时原样展示 */
    }
    downloadLink = `<li>下载: <a href="${vsix}">${fileName}</a></li>`;
  }
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${ext.displayName} - 本地软件源</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto;color:#333}img{max-width:128px}pre{background:#f5f5f5;padding:12px;border-radius:6px}</style></head>
<body>
<h1><img src="${icon || ''}" alt="icon" style="vertical-align:middle"> ${ext.displayName}</h1>
<p><b>ID:</b> <code>${ext.publisher.publisherName}.${ext.extensionName}</code> &nbsp; <b>版本:</b> ${v.version}</p>
<p>${ext.shortDescription || ''}</p>
<ul>
${downloadLink}
${readme ? `<li>说明: <a href="${readme}">README.md</a></li>` : ''}
</ul>
<pre>${JSON.stringify(ext, null, 2)}</pre>
</body></html>`;
  const body = req ? rewriteBaseUrl(html, req) : html;
  sendBody(res, 200, 'text/html; charset=utf-8', body, req);
}

/**
 * 处理扩展版本配置查询（协议与官方 iplug 一致）
 * POST /vscode/version/config?namespace=<publisher>&extensionName=<name>&userId=<uid>
 * 响应: { success, message, code, result: [ { versionConfig: [{ version, versionUrl }] } ] }
 *   versionUrl: 该版本 VSIX 的下载地址
 */
function handleVersionConfig(meta, res, parsed, req) {
  const namespace = String(parsed.query.namespace || '');
  const extensionName = String(parsed.query.extensionName || '');
  const empty = { success: true, message: '', code: 200, result: [], timestamp: Date.now() };
  if (!extensionName) {
    return sendJson(res, 200, empty, req);
  }
  const ext = meta.extensions.find(
    (e) =>
      e.extensionName.toLowerCase() === extensionName.toLowerCase() &&
      (!namespace || e.publisher.publisherName.toLowerCase() === namespace.toLowerCase())
  );
  if (!ext) {
    return sendJson(res, 200, empty, req);
  }
  const versionConfig = (ext.versions || [])
    .map((v) => {
      const vsix = (v.files.find((f) => f.assetType.includes('VSIXPackage')) || {}).source || '';
      return { version: v.version, versionUrl: vsix };
    })
    .filter((c) => c.versionUrl);
  return sendJson(
    res,
    200,
    {
      success: true,
      message: '',
      code: 200,
      result: [{ versionConfig }],
      timestamp: Date.now(),
    },
    req
  );
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/', true);
  const pathname = decodeURIComponent(parsed.pathname);

  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${pathname}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  const m = getMeta();

  if (pathname === '/vscode/gallery/extensionquery' && req.method === 'POST') {
    return readBody(req, res, (body) => handleExtensionQuery(body, m, res, req));
  }

  if (pathname === '/vscode/gallery/extensionquery' && req.method === 'GET') {
    return handleExtensionQuery(
      JSON.stringify({ filters: [{ criteria: [], pageNumber: 1, pageSize: 100 }] }),
      m,
      res,
      req
    );
  }

  if (pathname === '/vscode/version/config' && (req.method === 'POST' || req.method === 'GET')) {
    return handleVersionConfig(m, res, parsed, req);
  }

  if (pathname === '/api/nac/admin/list' && req.method === 'POST') {
    return readBody(req, res, (body) => handleNacAdminList(body, m, res, req));
  }

  if (pathname.startsWith('/vscode/gallery/asset/')) {
    const id = pathname.replace('/vscode/gallery/asset/', '');
    const ext = m.extensions.find(
      (e) => `${e.publisher.publisherName}.${e.extensionName}` === id
    );
    if (!ext) {
      return sendJson(res, 404, { error: 'not found' });
    }
    return sendJson(res, 200, ext, req);
  }

  if (pathname.startsWith('/vscode/item/')) {
    const id = pathname.replace('/vscode/item/vscode/', '').replace('/vscode/item/server/', '');
    return handleItemPage(id, m, res, req);
  }

  // 静态资源：/plugins/... 与 /assets/...
  if (pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')) {
    const filePath = path.normalize(path.join(REPO_DIR, pathname));
    if (!filePath.startsWith(REPO_DIR)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    return sendFile(res, filePath, req);
  }

  // 健康检查 / 根路径
  if (pathname === '/' || pathname === '/health') {
    return sendJson(
      res,
      200,
      {
        name: 'Local Software Repository',
        protocol: 'VS Code Gallery compatible',
        endpoint: `${BASE_URL}/vscode/gallery/extensionquery`,
        extensions: m.extensions.length,
      },
      req
    );
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`本地软件源已启动: ${BASE_URL}`);
  console.log(`  Gallery 查询接口: ${BASE_URL}/vscode/gallery/extensionquery`);
  console.log(`  收录扩展数: ${meta.extensions.length}`);
  for (const e of meta.extensions) {
    console.log(`    - ${e.publisher.publisherName}.${e.extensionName}@${e.versions[0].version}`);
  }
});
