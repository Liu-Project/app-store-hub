#!/usr/bin/env node
'use strict';

/**
 * 本地软件源（server.js）并发压测工具
 *
 * 用法：
 *   node perf/bench.js [--server path/to/server.js] [--port 3009]
 *        [--concurrency 30] [--duration 20] [--scenario all|query|nacl|assets|mixed]
 *        [--think 50] [--json out.json] [--skip]
 *
 * 说明：
 *   - 以子进程方式启动被测 server.js（REPO_PORT=<port> REPO_HOST=127.0.0.1），结束后自动 kill。
 *   - 采用「闭环用户」模型：恒定 concurrency 个虚拟用户，每个用户循环执行
 *     加权随机请求 + 随机思考时间，直到 duration 秒结束（模拟 30 人同时操作的真实形态）。
 *   - 采样子进程 CPU（/proc/<pid>/stat）与 RSS（/proc/<pid>/status），给出峰值与均值。
 *   - 只依赖 Node 内置模块。
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { server: null, port: 3009, concurrency: 30, duration: 20, scenario: 'all', think: 50, json: null, skip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--server') args.server = next();
    else if (a === '--port') args.port = Number(next());
    else if (a === '--concurrency') args.concurrency = Number(next());
    else if (a === '--duration') args.duration = Number(next());
    else if (a === '--scenario') args.scenario = next();
    else if (a === '--think') args.think = Number(next());
    else if (a === '--json') args.json = next();
    else if (a === '--skip') args.skip = true;
    else if (a === '--help') { console.log(usage()); process.exit(0); }
  }
  return args;
}

function usage() {
  return `用法: node perf/bench.js [选项]
  --server <path>      被测 server.js 路径（默认 repo/server.js）
  --port <n>           测试端口（默认 3009）
  --concurrency <n>    并发用户数（默认 30）
  --duration <s>       压测时长（默认 20 秒）
  --scenario <name>    all|query|nacl|assets|mixed（默认 all）
  --think <ms>         用户平均思考时间上限（默认 50）
  --json <path>        结果写入 JSON 文件
  --skip               不启动 server，仅用于其它脚本复用`;
}

// ---------- 请求构造 ----------
const QUERY_BODIES = {
  listAll: {
    filters: [{ criteria: [], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }],
    assetTypes: [], flags: 950,
  },
  search: {
    filters: [{ criteria: [{ filterType: 10, value: 'markdown' }], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }],
    assetTypes: [], flags: 950,
  },
  category: {
    filters: [{ criteria: [{ filterType: 5, value: 'Other' }], pageNumber: 1, pageSize: 30, sortBy: 0, sortOrder: 0 }],
    assetTypes: [], flags: 950,
  },
  detail: {
    filters: [{ criteria: [{ filterType: 7, value: 'Liu-Hongcun.appstore-hub' }], pageNumber: 1, pageSize: 10, sortBy: 0, sortOrder: 0 }],
    assetTypes: [], flags: 0x1b7,
  },
};

function makeRequest(port, kind) {
  const base = `http://127.0.0.1:${port}`;
  switch (kind) {
    case 'queryList':
      return req(base, 'POST', '/vscode/gallery/extensionquery', QUERY_BODIES.listAll);
    case 'querySearch':
      return req(base, 'POST', '/vscode/gallery/extensionquery', QUERY_BODIES.search);
    case 'queryCategory':
      return req(base, 'POST', '/vscode/gallery/extensionquery', QUERY_BODIES.category);
    case 'queryDetail':
      return req(base, 'POST', '/vscode/gallery/extensionquery', QUERY_BODIES.detail);
    case 'nacl':
      return req(base, 'POST', '/api/nac/admin/list', { page: 1, rowsPerPage: 30 });
    case 'icon':
      return req(base, 'GET', '/assets/Liu-Hongcun.markdown-commonmark-preview/icon.png', null, true);
    case 'readme':
      return req(base, 'GET', '/assets/Liu-Hongcun.appstore-hub/README.md', null, true);
    case 'vsix':
      return req(base, 'GET', '/plugins/Liu-Hongcun.file-match-compare/0.2.0/file-match-compare-0.2.0.vsix', null, true);
    case 'health':
      return req(base, 'GET', '/health', null, true);
    default:
      throw new Error('unknown request kind: ' + kind);
  }
}

function req(base, method, urlPath, body, raw) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(urlPath, base);
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json;api-version=3.0-preview.1',
          platform: 'linux-x64',
          'accept-encoding': 'gzip',
          ...(data ? { 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          resolve({ status: res.statusCode || 0, bytes: chunks.reduce((s, c) => s + c.length, 0), ms, err: null });
        });
        res.on('error', (e) => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          resolve({ status: 0, bytes: 0, ms, err: e.message });
        });
      }
    );
    r.setTimeout(30000, () => {
      r.destroy();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ status: 0, bytes: 0, ms, err: 'timeout' });
    });
    r.on('error', (e) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ status: 0, bytes: 0, ms, err: e.message });
    });
    if (data) r.write(data);
    r.end();
  });
}

// ---------- 场景定义（每种场景的请求种类权重） ----------
const SCENARIOS = {
  query: { queryList: 5, querySearch: 2, queryCategory: 2, queryDetail: 1 },
  nacl: { nacl: 10 },
  assets: { icon: 4, readme: 3, vsix: 2, health: 1 },
  mixed: { queryList: 5, querySearch: 2, queryCategory: 1, queryDetail: 1, nacl: 2, icon: 4, readme: 2, health: 1 },
  all: null, // 由 main 决定：all = query + nacl + assets 合并
};

function pickKind(weights, rnd) {
  const entries = Object.keys(weights);
  let total = 0;
  for (const k of entries) total += weights[k];
  let r = rnd() * total;
  for (const k of entries) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return entries[entries.length - 1];
}

// ---------- 进程监控 ----------
function sampleProcess(pid, samples) {
  let last = null;
  return setInterval(() => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // 字段顺序：pid comm state ppid pgrp session tty_nr tpgid flags
      //           minflt cminflt majflt cmajflt utime stime ...
      const close = stat.indexOf(')');
      if (close < 0) return;
      const fields = stat.slice(close + 2).split(' ');
      // fields[0]=state ... fields[11]=utime fields[12]=stime
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      const rss = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/)?.[1] || 0);
      const now = Date.now();
      if (last) {
        const dt = (now - last.t) / 1000;
        const cpu = ((utime - last.u + stime - last.s) / 100) / dt * 100;
        samples.push({ t: now, cpu, rss });
      }
      last = { t: now, u: utime, s: stime };
    } catch { /* 进程已退出 */ }
  }, 200);
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const serverPath = path.resolve(args.server || path.join(root, 'repo', 'server.js'));
  const port = args.port;
  const serverDir = path.dirname(serverPath);

  let child = null;
  if (!args.skip) {
    if (!fs.existsSync(serverPath)) {
      console.error(`server 不存在: ${serverPath}`);
      process.exit(1);
    }
    child = spawn(process.execPath, [serverPath], {
      cwd: serverDir,
      env: { ...process.env, REPO_PORT: String(port), REPO_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 等待端口就绪
    let ready = false;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      try {
        await new Promise((res, rej) => {
          const r = http.get(`http://127.0.0.1:${port}/health`, (x) => { x.resume(); x.on('end', () => res()); });
          r.on('error', rej);
          r.setTimeout(1000, () => { r.destroy(); rej(new Error('timeout')); });
        });
        ready = true;
        break;
      } catch { /* not ready */ }
    }
    if (!ready) {
      console.error('server 启动失败');
      child.kill('SIGKILL');
      process.exit(1);
    }
  }

  let scenarioWeights = args.scenario === 'all'
    ? { ...SCENARIOS.query, ...SCENARIOS.nacl, ...SCENARIOS.assets }
    : SCENARIOS[args.scenario];
  if (!scenarioWeights) scenarioWeights = { ...SCENARIOS.query, ...SCENARIOS.nacl, ...SCENARIOS.assets };

  const kinds = Object.keys(scenarioWeights);
  const results = {};
  for (const k of kinds) results[k] = [];
  const totalResults = [];
  let active = args.concurrency;
  const endAt = Date.now() + args.duration * 1000;
  const samples = [];
  const timer = child ? sampleProcess(child.pid, samples) : null;

  const user = async (uid) => {
    let seed = 123456789 + uid * 1000003;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    while (Date.now() < endAt) {
      const kind = pickKind(scenarioWeights, rnd);
      const r = await makeRequest(port, kind);
      results[kind].push(r.ms);
      totalResults.push(r);
      const think = Math.floor(rnd() * args.think);
      if (think > 0) await sleep(think);
    }
    active -= 1;
  };

  const users = [];
  for (let i = 0; i < args.concurrency; i++) users.push(user(i));
  await Promise.all(users);
  if (timer) clearInterval(timer);

  // 统计
  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  };
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const byKind = {};
  for (const k of kinds) {
    const a = results[k];
    byKind[k] = {
      count: a.length,
      avg: a.length ? sum(a) / a.length : 0,
      p50: pct(a, 0.5),
      p95: pct(a, 0.95),
      p99: pct(a, 0.99),
      max: a.length ? Math.max(...a) : 0,
    };
  }
  const errs = totalResults.filter((r) => r.err || r.status >= 500 || r.status === 0).length;
  const non2xx = totalResults.filter((r) => r.status >= 400 && r.status < 500).length;
  const totalMs = totalResults.reduce((s, r) => s + r.ms, 0);
  const elapsed = args.duration;
  const cpuArr = samples.map((s) => s.cpu);
  const rssArr = samples.map((s) => s.rss);

  const report = {
    meta: {
      node: process.version,
      server: path.relative(root, serverPath),
      port,
      concurrency: args.concurrency,
      durationSec: elapsed,
      thinkMs: args.think,
      scenario: args.scenario,
      gzipRequested: true,
    },
    summary: {
      totalRequests: totalResults.length,
      throughput: totalResults.length / elapsed,
      avgMs: totalMs / totalResults.length,
      p50: pct(totalResults.map((r) => r.ms), 0.5),
      p95: pct(totalResults.map((r) => r.ms), 0.95),
      p99: pct(totalResults.map((r) => r.ms), 0.99),
      max: totalResults.length ? Math.max(...totalResults.map((r) => r.ms)) : 0,
      errorRate: totalResults.length ? errs / totalResults.length : 0,
      non2xx: non2xx,
      bytesOut: sum(totalResults.map((r) => r.bytes)),
    },
    byKind,
    cpu: cpuArr.length
      ? { avg: sum(cpuArr) / cpuArr.length, p95: pct(cpuArr, 0.95), peak: Math.max(...cpuArr), samples: cpuArr.length }
      : { avg: 0, p95: 0, peak: 0, samples: 0 },
    rss: rssArr.length
      ? { avgMB: sum(rssArr) / rssArr.length / 1024, peakMB: Math.max(...rssArr) / 1024, samples: rssArr.length }
      : { avgMB: 0, peakMB: 0, samples: 0 },
  };

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));

  if (child) child.kill('SIGKILL');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
