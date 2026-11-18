#!/usr/bin/env node
'use strict';

/** 功能回归验证：确认优化后 server.js 各接口/协议行为与预期一致（含 gzip/304/413/热加载） */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const PORT = 3021;
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = process.argv[2] || path.resolve(__dirname, '..', 'repo', 'server.js');
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || (data ? 'POST' : 'GET'),
        headers: {
          accept: 'application/json;api-version=3.0-preview.1',
          platform: 'linux-x64',
          ...(opts.headers || {}),
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let body = buf;
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          if (enc.includes('gzip')) {
            try {
              body = zlib.gunzipSync(buf);
            } catch (e) {
              return resolve({ status: res.statusCode, headers: res.headers, body: buf, gunzipError: e.message });
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
        res.on('error', reject);
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: { ...process.env, REPO_PORT: String(PORT), REPO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait ready
  for (let i = 0; i < 100; i++) {
    await new Promise((s) => setTimeout(s, 100));
    try {
      await new Promise((res, rej) => {
        const r = http.get(`${BASE}/health`, (x) => { x.resume(); x.on('end', res); });
        r.on('error', rej);
      });
      break;
    } catch { /* retry */ }
  }

  console.log('== 基础 ==');
  const health = await request('/health');
  check('GET /health 200', health.status === 200);
  const healthJson = JSON.parse(health.body.toString());
  check('health 返回扩展数', typeof healthJson.extensions === 'number' && healthJson.extensions > 0);

  const notFound = await request('/no/such/path');
  check('404 未知路径', notFound.status === 404);

  const opts = await request('/vscode/gallery/extensionquery', { method: 'OPTIONS' });
  check('OPTIONS 204 + CORS', opts.status === 204 && opts.headers['access-control-allow-origin'] === '*');

  console.log('== extensionquery（gzip 与过滤）==');
  const q = (filters, flags = 950, gzip = true) =>
    request('/vscode/gallery/extensionquery', {
      body: { filters, assetTypes: [], flags },
      headers: gzip ? { 'accept-encoding': 'gzip' } : {},
    });

  const listAll = await q([{ criteria: [], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }]);
  check('列表 200', listAll.status === 200);
  const listAllJson = JSON.parse(listAll.body.toString());
  check('列表返回全部扩展', listAllJson.results[0].extensions.length > 0);
  check('TotalCount 正确', Number(listAllJson.results[0].resultMetadata[0].metadataItems[0].count) > 0);

  // gzip 内容与无 gzip 内容一致性
  const listAllPlain = await q([{ criteria: [], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }], 950, false);
  check('无 gzip 请求返回明文', !String(listAllPlain.headers['content-encoding'] || '').includes('gzip'));
  const a = JSON.stringify(listAllJson);
  const b = JSON.stringify(JSON.parse(listAllPlain.body.toString()));
  check('gzip 与明文内容一致', a === b);
  check('gzip Content-Encoding', String(listAll.headers['content-encoding'] || '').includes('gzip'));
  check('Vary: Accept-Encoding', String(listAll.headers.vary || '').includes('Accept-Encoding'));

  const ext0 = listAllJson.results[0].extensions[0];
  const pub = ext0.publisher.publisherName;
  const name = ext0.extensionName;

  const byId = await q([{ criteria: [{ filterType: 4, value: `${pub}.${name}` }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 4 按 ID 精确匹配', JSON.parse(byId.body.toString()).results[0].extensions.length === 1);

  const byName = await q([{ criteria: [{ filterType: 1, value: name }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 1 按名称匹配', JSON.parse(byName.body.toString()).results[0].extensions.some((x) => x.extensionName === name));

  const byPub = await q([{ criteria: [{ filterType: 1, value: pub }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 1 按发布者匹配', JSON.parse(byPub.body.toString()).results[0].extensions.length >= 1);

  const bySearch = await q([{ criteria: [{ filterType: 10, value: name.slice(0, 4) }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 10 搜索', JSON.parse(bySearch.body.toString()).results[0].extensions.some((x) => x.extensionName === name));

  const byCat = await q([{ criteria: [{ filterType: 5, value: 'Other' }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 5 分类', JSON.parse(byCat.body.toString()).results[0].extensions.length >= 1);

  const byTarget = await q([{ criteria: [{ filterType: 8, value: 'Microsoft.VisualStudio.Code' }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 8 目标放行', JSON.parse(byTarget.body.toString()).results[0].extensions.length > 0);

  const byTag = await q([{ criteria: [{ filterType: 6, value: name }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 6 标签近似', JSON.parse(byTag.body.toString()).results[0].extensions.length > 0);

  const byPlatform = await q([{ criteria: [{ filterType: 12, value: 'linux-x64' }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 12 平台', JSON.parse(byPlatform.body.toString()).results[0].extensions.length > 0);

  const engine = await q([{ criteria: [{ filterType: 7, value: '1.77.0' }], pageNumber: 1, pageSize: 10 }]);
  check('filterType 7 引擎版本过滤不报错', engine.status === 200 && JSON.parse(engine.body.toString()).results[0].extensions.length > 0);

  const paginated = await q([{ criteria: [], pageNumber: 1, pageSize: 2, sortBy: 0, sortOrder: 0 }]);
  check('分页 pageSize=2', JSON.parse(paginated.body.toString()).results[0].extensions.length === 2);

  const badJson = await request('/vscode/gallery/extensionquery', { body: '{bad', headers: {} });
  check('非法 JSON 400', badJson.status === 400);

  console.log('== nac/admin/list ==');
  const nacl = await request('/api/nac/admin/list', { body: { page: 1, rowsPerPage: 30 } });
  check('nacl 200', nacl.status === 200);
  const naclJson = JSON.parse(nacl.body.toString());
  check('nacl content 非空', Array.isArray(naclJson.content) && naclJson.content.length > 0);
  const c0 = naclJson.content[0];
  check('nacl imageContent 为 base64', typeof c0.imageContent === 'string' && (!c0.imageContent || /^[A-Za-z0-9+/=]+$/.test(c0.imageContent)));
  check('nacl markdownContent 为 base64', typeof c0.markdownContent === 'string' && c0.markdownContent.length > 0);
  check('nacl address 指向 item 页', String(c0.address).includes('/vscode/item/vscode/'));
  const md = Buffer.from(c0.markdownContent, 'base64').toString('utf-8');
  check('nacl markdown 可解码', md.includes('#') && md.includes('**ID**'));

  console.log('== version/config ==');
  const vc = await request(`/vscode/version/config?namespace=${pub}&extensionName=${name}`);
  check('version/config 200', vc.status === 200);
  const vcJson = JSON.parse(vc.body.toString());
  check('version/config result 含版本', vcJson.success === true && vcJson.result.length === 1 && vcJson.result[0].versionConfig.length > 0);

  console.log('== 静态资源（ETag / 304 / gzip）==');
  const icon = await request(`/assets/${pub}.${name}/icon.png`);
  check('icon 200 + 正确类型', icon.status === 200 && String(icon.headers['content-type'] || '').includes('image'));
  check('icon 有 ETag', !!icon.headers.etag);
  const etag = icon.headers.etag;
  const icon304 = await request(`/assets/${pub}.${name}/icon.png`, { headers: { 'if-none-match': etag } });
  check('If-None-Match 命中返回 304', icon304.status === 304);
  check('304 无 body', icon304.body.length === 0);

  const readme = await request(`/assets/${pub}.${name}/README.md`, { headers: { 'accept-encoding': 'gzip' } });
  check('README gzip 200', readme.status === 200 && String(readme.headers['content-encoding'] || '').includes('gzip'));
  check('README gzip 内容正确', readme.body.toString().includes('#') || readme.body.toString().includes('README'));
  const readmePlain = await request(`/assets/${pub}.${name}/README.md`);
  check('README 无 gzip 请求明文', !String(readmePlain.headers['content-encoding'] || '').includes('gzip'));

  const traversal = await request('/assets/../package.json');
  check('路径穿越被拦截(404/403)', traversal.status === 403 || traversal.status === 404);

  console.log('== item 页 ==');
  const item = await request(`/vscode/item/vscode/${pub}.${name}`);
  check('item 200 + html', item.status === 200 && String(item.headers['content-type'] || '').includes('text/html'));
  check('item 内容含扩展名', item.body.toString().includes(name));

  const itemMissing = await request('/vscode/item/vscode/no.such');
  check('item 不存在 404', itemMissing.status === 404);

  console.log('== gallery/asset ==');
  const ga = await request(`/vscode/gallery/asset/${pub}.${name}`);
  check('gallery/asset 200', ga.status === 200);

  console.log('== 请求体大小限制（413）==');
  const big = await new Promise((resolve) => {
    const data = Buffer.alloc(2 * 1024 * 1024, 97);
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: '/vscode/gallery/extensionquery', method: 'POST', headers: { 'content-length': data.length, 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    r.write(data);
    r.end();
  });
  check('超大 body 返回 413', big.status === 413);
  check('413 后服务仍可用', (await request('/health')).status === 200);

  console.log('== metadata 热加载 ==');
  // 改 mtime 触发重载（内容不变），确认服务不崩且计数一致
  const before = JSON.parse((await request('/health')).body.toString()).extensions;
  const metaFile = path.join(path.dirname(serverPath), 'metadata.json');
  const stat = fs.statSync(metaFile);
  fs.utimesSync(metaFile, new Date(stat.atimeMs), new Date(stat.mtimeMs + 2000));
  await new Promise((s) => setTimeout(s, 200));
  const after = JSON.parse((await request('/health')).body.toString()).extensions;
  check('metadata 热加载后服务正常且计数一致', before === after);

  child.kill('SIGKILL');
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
