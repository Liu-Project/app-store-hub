#!/usr/bin/env node
'use strict';

/**
 * ZXISOS 本地软件源 - 构建脚本
 *
 * 扫描 repo/plugins 目录下的所有 .vsix（同一插件可含多个版本）：
 *  1. 从每个 .vsix 中提取 extension/package.json 作为扩展元数据
 *  2. 同一插件（publisher.name）的多个版本合并为一个扩展条目，
 *     versions 数组包含全部版本，每个版本独立提供 VSIXPackage 下载
 *  3. 提取图标 / README / 变更日志(CHANGELOG) / LICENSE / 截图到 repo/assets/<publisher>.<name>/
 *  4. 生成 repo/metadata.json（VS Code Gallery 兼容格式）——变更日志按
 *     Gallery 协议的 Microsoft.VisualStudio.Services.Content.Changelog 资源对外提供
 *
 * 用法：node repo/build.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const REPO_DIR = __dirname;
const PLUGINS_DIR = path.join(REPO_DIR, 'plugins');
const ASSETS_DIR = path.join(REPO_DIR, 'assets');
const METADATA_FILE = path.join(REPO_DIR, 'metadata.json');

function run(cmd, args) {
  return execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
}

function unzipList(vsix) {
  return run('unzip', ['-Z1', vsix]).split('\n').filter(Boolean);
}

function unzipFile(vsix, entry) {
  try {
    return execFileSync('unzip', ['-p', vsix, entry], { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return null;
  }
}

function stableUuid(str) {
  const h = crypto.createHash('md5').update(str).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function findEntry(entries, candidates) {
  for (const c of candidates) {
    const hit = entries.find((e) => e.toLowerCase() === c.toLowerCase());
    if (hit) {
      return hit;
    }
  }
  return null;
}

function collectVsix(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectVsix(p, out);
    } else if (entry.name.endsWith('.vsix')) {
      out.push(p);
    }
  }
  return out;
}

function readPkg(vsix) {
  const pkgRaw = unzipFile(vsix, 'extension/package.json');
  if (!pkgRaw) {
    return null;
  }
  try {
    return JSON.parse(pkgRaw.toString('utf-8'));
  } catch (e) {
    return null;
  }
}

function parseVersion(v) {
  return String(v)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function versionCompare(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

/**
 * 从 vsix 中提取图标 / README / 变更日志 / LICENSE / 截图到 assets/<id>/，
 * 并将 README 中指向 /screenshots/ 的外链替换为本地链接。
 */
function extractAssets(vsix, pkg, id, baseUrl) {
  const entries = unzipList(vsix);
  const assetDir = path.join(ASSETS_DIR, id);
  fs.mkdirSync(assetDir, { recursive: true });

  // 图标
  let iconEntry = null;
  if (pkg.icon) {
    iconEntry = findEntry(entries, [`extension/${pkg.icon}`]);
  }
  if (!iconEntry) {
    iconEntry = findEntry(entries, [
      'extension/icon.png',
      'extension/icon/icon_128.png',
      'extension/media/icon.png',
      'extension/assets/icon.png',
    ]);
  }
  let iconAsset = null;
  if (iconEntry) {
    const iconData = unzipFile(vsix, iconEntry);
    if (iconData) {
      const ext = path.extname(iconEntry) || '.png';
      const iconFile = path.join(assetDir, `icon${ext}`);
      fs.writeFileSync(iconFile, iconData);
      iconAsset = `${baseUrl}/assets/${id}/icon${ext}`;
    }
  }

  // README（先本地化截图外链，保证离线环境可显示）
  let readmeEntry = findEntry(entries, ['extension/README.md', 'extension/readme.md', 'extension/Readme.md']);
  let readmeAsset = null;
  if (readmeEntry) {
    const readmeData = unzipFile(vsix, readmeEntry);
    if (readmeData) {
      fs.writeFileSync(path.join(assetDir, 'README.md'), readmeData);
      readmeAsset = `${baseUrl}/assets/${id}/README.md`;
    }
  }

  // 变更日志（VS Code Gallery Content.Changelog 资源）
  let changelogEntry = findEntry(entries, [
    'extension/CHANGELOG.md',
    'extension/changelog.md',
    'extension/ChangeLog.md',
  ]);
  let changelogAsset = null;
  if (changelogEntry) {
    const changelogData = unzipFile(vsix, changelogEntry);
    if (changelogData) {
      fs.writeFileSync(path.join(assetDir, 'CHANGELOG.md'), changelogData);
      changelogAsset = `${baseUrl}/assets/${id}/CHANGELOG.md`;
    }
  }

  // 截图：提取 media/screenshots/ 下的图片到 assets/<id>/screenshots/
  const screenshotEntries = entries.filter((e) =>
    /\/screenshots\/[^/]+\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e)
  );
  const screenshots = [];
  for (const se of screenshotEntries) {
    const data = unzipFile(vsix, se);
    if (data) {
      const name = path.basename(se);
      const outFile = path.join(assetDir, 'screenshots', name);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, data);
      screenshots.push({ name, source: `${baseUrl}/assets/${id}/screenshots/${name}` });
    }
  }

  // 将 README 中指向 /screenshots/<file> 的图片外链替换为本地链接
  if (screenshots.length > 0) {
    const readmeFile = path.join(assetDir, 'README.md');
    if (fs.existsSync(readmeFile)) {
      let content = fs.readFileSync(readmeFile, 'utf-8');
      content = content.replace(/\]\(([^)]*\/screenshots\/([^)]+))\)/g, (m, full, name) => {
        const decoded = decodeURIComponent(name);
        if (fs.existsSync(path.join(assetDir, 'screenshots', decoded))) {
          return `](${baseUrl}/assets/${id}/screenshots/${decoded})`;
        }
        return m;
      });
      fs.writeFileSync(readmeFile, content);
    }
  }

  // LICENSE
  let licenseEntry = findEntry(entries, ['extension/LICENSE.txt', 'extension/LICENSE.md', 'extension/LICENSE']);
  let licenseAsset = null;
  if (licenseEntry) {
    const licenseData = unzipFile(vsix, licenseEntry);
    if (licenseData) {
      fs.writeFileSync(path.join(assetDir, 'LICENSE.txt'), licenseData);
      licenseAsset = `${baseUrl}/assets/${id}/LICENSE.txt`;
    }
  }

  return { iconAsset, readmeAsset, changelogAsset, licenseAsset, screenshots };
}

/**
 * 将同一插件（publisher.name）的多个版本 vsix 合并为一个扩展条目。
 * 图标 / README / LICENSE / 截图取自最新版本，各版本独立提供 VSIXPackage 下载。
 */
function buildExtensionGroup(group, baseUrl) {
  group.sort((a, b) => versionCompare(b.pkg.version, a.pkg.version));
  const latest = group[0];
  const pkg = latest.pkg;
  const publisher = pkg.publisher || 'unknown';
  const name = pkg.name;
  const id = `${publisher}.${name}`;

  const assets = extractAssets(latest.vsix, pkg, id, baseUrl);

  const commonFiles = [];
  if (assets.iconAsset) {
    commonFiles.push({ assetType: 'Microsoft.VisualStudio.Services.Icons.Default', source: assets.iconAsset });
  }
  for (const s of assets.screenshots) {
    commonFiles.push({ assetType: 'Microsoft.VisualStudio.Services.Content.Screenshots', source: s.source });
  }
  if (assets.readmeAsset) {
    commonFiles.push({ assetType: 'Microsoft.VisualStudio.Services.Content.Details', source: assets.readmeAsset });
  }
  if (assets.changelogAsset) {
    commonFiles.push({ assetType: 'Microsoft.VisualStudio.Services.Content.Changelog', source: assets.changelogAsset });
  }
  if (assets.licenseAsset) {
    commonFiles.push({ assetType: 'Microsoft.VisualStudio.Services.Content.License', source: assets.licenseAsset });
  }

  const engine = (pkg.engines && pkg.engines.vscode) || '';
  const lastUpdated = fs.statSync(latest.vsix).mtime.toISOString();

  const versions = group.map(({ vsix, pkg: vpkg }) => {
    const v = vpkg.version;
    const stat = fs.statSync(vsix);
    const files = commonFiles.concat([
      {
        assetType: 'Microsoft.VisualStudio.Services.VSIXPackage',
        source: `${baseUrl}/plugins/${id}/${v}/${vpkg.name}-${v}.vsix`,
      },
    ]);
    return {
      version: v,
      lastUpdated: stat.mtime.toISOString(),
      assetUri: `${baseUrl}/vscode/gallery/asset/${id}`,
      fallbackAssetUri: `${baseUrl}/vscode/gallery/asset/${id}`,
      files,
      properties: [
        { key: 'Microsoft.VisualStudio.Code.Engine', value: engine },
        { key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: '' },
        { key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: '' },
        { key: 'Microsoft.VisualStudio.Code.LocalizedLanguages', value: '' },
        { key: 'Microsoft.VisualStudio.Services.Links.Source', value: '' },
      ],
    };
  });

  return {
    publisher: {
      publisherId: stableUuid(`publisher:${publisher}`),
      publisherName: publisher,
      displayName: publisher,
      flags: 'verified',
    },
    extensionId: stableUuid(id),
    extensionName: name,
    displayName: pkg.displayName || name,
    flags: 'valid',
    lastUpdated,
    publishedDate: lastUpdated,
    releaseDate: lastUpdated,
    shortDescription: pkg.description || '',
    versions,
    statistics: [
      { statisticName: 'install', value: 1 },
      { statisticName: 'averagerating', value: 5 },
      { statisticName: 'ratingcount', value: 1 },
    ],
    categories: pkg.categories || ['Other'],
  };
}

function main() {
  const port = process.env.REPO_PORT || 3000;
  const baseUrl = process.env.REPO_BASE_URL || `http://127.0.0.1:${port}`;

  const vsixFiles = collectVsix(PLUGINS_DIR, []);
  if (vsixFiles.length === 0) {
    console.error('未找到任何 .vsix 文件，请先将插件放入 ' + PLUGINS_DIR);
    process.exit(1);
  }

  // 按 publisher.name 分组
  const groups = new Map();
  for (const f of vsixFiles) {
    const pkg = readPkg(f);
    if (!pkg || !pkg.name) {
      console.error(`  [FAIL] ${path.basename(f)}: 无法读取 package.json`);
      continue;
    }
    const id = `${pkg.publisher || 'unknown'}.${pkg.name}`;
    if (!groups.has(id)) {
      groups.set(id, []);
    }
    groups.get(id).push({ vsix: f, pkg });
  }

  const extensions = [];
  for (const [id, group] of groups) {
    try {
      const ext = buildExtensionGroup(group, baseUrl);
      console.log(
        `  [OK] ${ext.publisher.publisherName}.${ext.extensionName} 版本: ${ext.versions.map((v) => v.version).join(' / ')}`
      );
      extensions.push(ext);
    } catch (e) {
      console.error(`  [FAIL] ${id}: ${e.message}`);
    }
  }

  extensions.sort((a, b) => a.extensionName.localeCompare(b.extensionName));

  const metadata = { generatedAt: new Date().toISOString(), baseUrl, extensions };
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  console.log(`\n已生成 ${METADATA_FILE}，共 ${extensions.length} 个扩展。`);
}

main();
