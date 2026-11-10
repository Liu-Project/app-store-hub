#!/usr/bin/env node
'use strict';

/**
 * ZXISOS 本地软件源 - VS Code Gallery 兼容 HTTP 服务
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
 * / zxisos-requirement-helper）在本机与局域网下均可正常浏览与下载。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

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

function loadMetadata() {
  if (!fs.existsSync(METADATA_FILE)) {
    console.error(`元数据文件不存在: ${METADATA_FILE}，请先运行: node repo/build.js`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
}

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

function sendJson(res, status, obj, req) {
  let body = JSON.stringify(obj);
  if (req) {
    body = rewriteBaseUrl(body, req);
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: 'not found', path: filePath });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
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

  let list = meta.extensions;

  const startsWithNumber = (v) => /^\d+/.test(String(v));

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
        list = list.filter(
          (e) =>
            e.extensionName.toLowerCase() === kw ||
            e.publisher.publisherName.toLowerCase() === kw
        );
        break;
      }
      case 4: {
        // ExtensionId
        const kw = String(value).toLowerCase();
        list = list.filter((e) => `${e.publisher.publisherName}.${e.extensionName}`.toLowerCase() === kw);
        break;
      }
      case 5: {
        // Category
        const cat = String(value);
        list = list.filter((e) => (e.categories || []).includes(cat));
        break;
      }
      case 6: {
        // ExtensionTags：本地源无标签数据，按关键字近似匹配，无匹配则放行
        const tag = String(value).toLowerCase();
        list = list.filter(
          (e) => [e.extensionName, e.displayName, e.shortDescription].join(' ').toLowerCase().includes(tag)
        );
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
          list = list.filter((e) => e.extensionName.toLowerCase() === kw);
          break;
        }
        const tMaj = Number(m[1]);
        const tMin = Number(m[2]);
        list = list.filter((e) => {
          const engine =
            (e.versions[0].properties.find((p) => p.key === 'Microsoft.VisualStudio.Code.Engine') || {}).value || '';
          const ok = /^[~^]?(\d+)\.(\d+)/.exec(engine);
          if (!ok) {
            return true;
          }
          const eMaj = Number(ok[1]);
          const eMin = Number(ok[2]);
          return eMaj > tMaj || (eMaj === tMaj && eMin >= tMin);
        });
        break;
      }
      case 8: {
        // ExcludeWithFlags / IDE 安装目标：
        // 值为 "Microsoft.VisualStudio.Code" 等 IDE 标识或非纯数字时放行；
        // 纯数字视为 flags 排除（本地扩展无 flags，全部放行）
        const sv = String(value);
        if (/VisualStudio\.Code/i.test(sv) || !startsWithNumber(sv)) {
          break;
        }
        break;
      }
      case 9: {
        // InstallationTarget：值为 VS Code 类目标时放行
        if (/VisualStudio\.Code/i.test(String(value))) {
          break;
        }
        break;
      }
      case 10: {
        // SearchText
        const kw = String(value).toLowerCase();
        list = list.filter((e) =>
          [e.extensionName, e.displayName, e.publisher.publisherName, e.shortDescription]
            .join(' ')
            .toLowerCase()
            .includes(kw)
        );
        break;
      }
      case 12: {
        // TargetPlatform：无平台声明的扩展放行
        const plat = String(value);
        list = list.filter((e) => {
          const v = e.versions[0];
          return !v.targetPlatform || v.targetPlatform === plat || v.targetPlatform === 'universal';
        });
        break;
      }
      default:
        // 未知 / 自定义（如 999）filterType：放行
        break;
    }
  }

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
 */
function handleNacAdminList(body, meta, res, req) {
  let reqBody = {};
  try {
    reqBody = JSON.parse(body || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: 'invalid json' }, req);
  }
  const content = meta.extensions.map((e) => {
    const v = e.versions[0];
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
  sendJson(res, 200, { content }, req);
}

function handleItemPage(id, meta, res, req) {  const ext = meta.extensions.find((e) => `${e.publisher.publisherName}.${e.extensionName}` === id);
  if (!ext) {
    return sendJson(res, 404, { error: `extension ${id} not found` });
  }
  const v = ext.versions[0];
  const vsix = (v.files.find((f) => f.assetType.includes('VSIXPackage')) || {}).source;
  const icon = (v.files.find((f) => f.assetType.includes('Icons.Default')) || {}).source;
  const readme = (v.files.find((f) => f.assetType.includes('Content.Details')) || {}).source;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${ext.displayName} - ZXISOS 本地软件源</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto;color:#333}img{max-width:128px}pre{background:#f5f5f5;padding:12px;border-radius:6px}</style></head>
<body>
<h1><img src="${icon || ''}" alt="icon" style="vertical-align:middle"> ${ext.displayName}</h1>
<p><b>ID:</b> <code>${ext.publisher.publisherName}.${ext.extensionName}</code> &nbsp; <b>版本:</b> ${v.version}</p>
<p>${ext.shortDescription || ''}</p>
<ul>
<li>下载: <a href="${vsix}">${path.basename(new URL(vsix).pathname)}</a></li>
${readme ? `<li>说明: <a href="${readme}">README.md</a></li>` : ''}
</ul>
<pre>${JSON.stringify(ext, null, 2)}</pre>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(req ? rewriteBaseUrl(html, req) : html);
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
  const versionConfig = ext.versions
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

const meta = loadMetadata();

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

  if (pathname === '/vscode/gallery/extensionquery' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleExtensionQuery(body, meta, res, req));
    return;
  }

  if (pathname === '/vscode/gallery/extensionquery' && req.method === 'GET') {
    return handleExtensionQuery(JSON.stringify({ filters: [{ criteria: [], pageNumber: 1, pageSize: 100 }] }), meta, res, req);
  }

  if (pathname === '/vscode/version/config' && (req.method === 'POST' || req.method === 'GET')) {
    return handleVersionConfig(meta, res, parsed, req);
  }

  if (pathname === '/api/nac/admin/list' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleNacAdminList(body, meta, res, req));
    return;
  }

  if (pathname.startsWith('/vscode/gallery/asset/')) {
    const id = pathname.replace('/vscode/gallery/asset/', '');
    const ext = meta.extensions.find((e) => `${e.publisher.publisherName}.${e.extensionName}` === id);
    if (!ext) {
      return sendJson(res, 404, { error: 'not found' });
    }
    return sendJson(res, 200, ext, req);
  }

  if (pathname.startsWith('/vscode/item/')) {
    const id = pathname.replace('/vscode/item/vscode/', '').replace('/vscode/item/server/', '');
    return handleItemPage(id, meta, res, req);
  }

  // 静态资源：/plugins/... 与 /assets/...
  if (pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')) {
    const filePath = path.normalize(path.join(REPO_DIR, pathname));
    if (!filePath.startsWith(REPO_DIR)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    return sendFile(res, filePath);
  }

  // 健康检查 / 根路径
  if (pathname === '/' || pathname === '/health') {
    return sendJson(
      res,
      200,
      {
        name: 'ZXISOS Local Software Repository',
        protocol: 'VS Code Gallery compatible',
        endpoint: `${BASE_URL}/vscode/gallery/extensionquery`,
        extensions: meta.extensions.length,
      },
      req
    );
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`ZXISOS 本地软件源已启动: ${BASE_URL}`);
  console.log(`  Gallery 查询接口: ${BASE_URL}/vscode/gallery/extensionquery`);
  console.log(`  收录扩展数: ${meta.extensions.length}`);
  for (const e of meta.extensions) {
    console.log(`    - ${e.publisher.publisherName}.${e.extensionName}@${e.versions[0].version}`);
  }
});
