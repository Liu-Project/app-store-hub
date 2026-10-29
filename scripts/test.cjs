#!/usr/bin/env node
/**
 * 跨 Node 版本运行 Mocha：
 * - Node >= 22：原生 TS type-stripping 会与 ts-node 冲突，需禁用（--no-experimental-strip-types）
 * - Node < 22：无需该 flag，直接运行
 */
'use strict';

const { spawnSync } = require('child_process');

const major = Number(process.versions.node.split('.')[0]);
const env = { ...process.env };
if (major >= 22) {
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-experimental-strip-types']
    .filter(Boolean)
    .join(' ');
}

const result = spawnSync('mocha', process.argv.slice(2), {
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
