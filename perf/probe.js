#!/usr/bin/env node
'use strict';

/**
 * 顺序单客户端延迟探针：低噪声对比 baseline 与 optimized 服务器的单请求处理成本。
 * 每次探测使用随机空闲端口，避免端口冲突/残留进程干扰；结束后强制 kill 子进程。
 */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function req(base, urlPath, method, body) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const u = new URL(urlPath, base);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
      }
    );
    r.on('error', () => resolve(-1));
    if (data) r.write(data);
    r.end();
  });
}

async function probe(serverPath, n, kind) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: { ...process.env, REPO_PORT: String(port), REPO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout && child.stdout.on('data', (d) => (childOut += d));
  child.stderr && child.stderr.on('data', (d) => (childOut += d));
  // 等待端口就绪（最多 10s）
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await new Promise((s) => setTimeout(s, 100));
    try {
      await new Promise((res, rej) => {
        const r = http.get(`${base}/health`, (x) => {
          x.resume();
          x.on('end', res);
        });
        r.on('error', rej);
      });
      ready = true;
      break;
    } catch {
      /* retry */
    }
  }
  if (!ready) {
    console.error('[not-ready]', serverPath, 'port=' + port, 'exitCode=' + child.exitCode, 'OUT:', JSON.stringify(childOut.slice(0, 300)));
    child.kill('SIGKILL');
    return { avg: 'ERR', p50: 'ERR', p95: 'ERR', max: 'ERR', n: 0 };
  }
  // 预热
  for (let i = 0; i < 10; i++) {
    await req(base, '/vscode/gallery/extensionquery', 'POST', {
      filters: [{ criteria: [], pageNumber: 1, pageSize: 30 }],
      flags: 950,
    });
  }
  for (let i = 0; i < 10; i++) {
    await req(base, '/api/nac/admin/list', 'POST', { page: 1 });
  }

  const times = [];
  for (let i = 0; i < n; i++) {
    let ms;
    if (kind === 'query') {
      ms = await req(base, '/vscode/gallery/extensionquery', 'POST', {
        filters: [{ criteria: [], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }],
        assetTypes: [],
        flags: 950,
      });
    } else if (kind === 'search') {
      ms = await req(base, '/vscode/gallery/extensionquery', 'POST', {
        filters: [{ criteria: [{ filterType: 10, value: 'markdown' }], pageNumber: 1, pageSize: 30 }],
        assetTypes: [],
        flags: 950,
      });
    } else if (kind === 'nacl') {
      ms = await req(base, '/api/nac/admin/list', 'POST', { page: 1, rowsPerPage: 30 });
    } else if (kind === 'icon') {
      ms = await req(base, '/assets/Liu-Hongcun.markdown-commonmark-preview/icon.png', 'GET', null);
    } else {
      ms = await req(base, '/health', 'GET', null);
    }
    if (ms >= 0) times.push(ms);
  }
  child.kill('SIGKILL');
  // 等子进程真正退出，避免端口残留
  await new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.on('exit', res);
    setTimeout(res, 2000);
  });
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))];
  return {
    avg: (times.reduce((s, x) => s + x, 0) / times.length).toFixed(3),
    p50: pct(0.5).toFixed(3),
    p95: pct(0.95).toFixed(3),
    max: times[times.length - 1].toFixed(3),
    n: times.length,
  };
}

async function main() {
  const serverPath = path.resolve(process.argv[2]);
  const baseline = path.resolve(process.argv[3] || '/tmp/zero/baseline-repo/server.js');
  for (const kind of ['query', 'search', 'nacl', 'icon', 'health']) {
    const b = await probe(baseline, 400, kind);
    const o = await probe(serverPath, 400, kind);
    console.log(
      `${kind.padEnd(7)} baseline: avg=${b.avg}ms p50=${b.p50} p95=${b.p95} max=${b.max} | optimized: avg=${o.avg}ms p50=${o.p50} p95=${o.p95} max=${o.max}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
