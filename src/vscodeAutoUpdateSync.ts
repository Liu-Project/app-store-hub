import * as fs from 'fs';
import * as path from 'path';
import { isGlobalAutoUpdateEnabled } from './autoUpdateConfig';
import { log, logErr } from './logger';

/**
 * 与 VS Code 内置「扩展:商店」的 Auto Update 双向同步。
 *
 * VS Code 内置扩展中心的单扩展 Auto Update 并非配置项，而是存在工作台全局存储
 * `state.vscdb`（SQLite，`ItemTable` 表）的两个列表中：
 * - `extensions.autoUpdate`      当全局 `extensions.autoUpdate` 关闭时，记录「单独启用自动更新」的扩展 ID（小写）
 * - `extensions.donotAutoUpdate` 当全局 `extensions.autoUpdate` 开启时，记录「禁用自动更新」的扩展 ID（小写）
 *
 * 本模块直接读写该存储（与 VS Code 内置逻辑一致，见
 * ExtensionsWorkbenchService#isAutoUpdateEnabledFor / updateAutoUpdateEnablementFor），
 * 使插件中心与 VS Code 内置扩展商店共用同一数据源，实现双向同步。
 */

/** VS Code 内置扩展中心「单独启用自动更新」的扩展 ID 列表 */
export const VSCODE_AUTO_UPDATE_KEY = 'extensions.autoUpdate';
/** VS Code 内置扩展中心「禁用自动更新」的扩展 ID 列表 */
export const VSCODE_DONOT_AUTO_UPDATE_KEY = 'extensions.donotAutoUpdate';

type Db = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => { value?: unknown } | undefined;
    run: (...args: unknown[]) => { changes: number };
  };
  close: () => void;
};

type DatabaseSyncCtor = new (file: string, opts?: { timeout?: number }) => Db;

/** 动态加载 node:sqlite（Node >= 22.5）。旧版 VS Code 宿主不支持时返回 undefined，降级为本地存储。 */
function loadDatabaseSync(): DatabaseSyncCtor | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    if (mod && typeof mod.DatabaseSync === 'function') {
      return mod.DatabaseSync as DatabaseSyncCtor;
    }
  } catch {
    /* node:sqlite 不可用 */
  }
  return undefined;
}

let cachedDbAvailable: boolean | undefined;
let stateDbPathOverride: string | undefined;
let globalStorageUriValue: string | undefined;

/** 测试专用：覆盖 state.vscdb 路径（正常运行时勿调用） */
export function __setStateDbPathForTest(p: string | undefined): void {
  stateDbPathOverride = p;
  cachedDbAvailable = undefined;
}

/** 记录扩展自身的 globalStorageUri（用于 argv 无 --user-data-dir 时反推 user-data-dir） */
export function setGlobalStorageUri(uri: string | undefined): void {
  globalStorageUriValue = uri;
  cachedDbAvailable = undefined;
}

/** state.vscdb 是否可读（一次性探测，避免每 3 秒轮询反复尝试打开） */
export function isStateDbAvailable(): boolean {
  if (cachedDbAvailable !== undefined) {
    return cachedDbAvailable;
  }
  try {
    const p = resolveStateDbPath();
    cachedDbAvailable = !!loadDatabaseSync() && !!p && fs.existsSync(p);
  } catch {
    cachedDbAvailable = false;
  }
  return cachedDbAvailable;
}

/** 从扩展宿主进程 argv 解析 VS Code user-data-dir（VS Code 启动扩展宿主时传递 --user-data-dir） */
export function resolveUserDataDirFromArgv(): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--user-data-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
    const m = /^--user-data-dir=(.+)$/.exec(a);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/** 从扩展自身 globalStorageUri 反推 user-data-dir（argv 无 --user-data-dir 时的可靠备选）：
 *  globalStorageUri = <userDataDir>/User/globalStorage/<extId>
 *  或                <userDataDir>/User/profiles/<profileId>/globalStorage/<extId> */
export function resolveUserDataDirFromGlobalStorage(): string | undefined {
  const g = globalStorageUriValue;
  if (!g) {
    return undefined;
  }
  const parts = String(g)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/);
  const idx = parts.lastIndexOf('User');
  if (idx > 0) {
    return parts.slice(0, idx).join('/');
  }
  return undefined;
}

/** 解析 VS Code user-data-dir：优先 argv 参数，其次由 globalStorageUri 反推 */
export function resolveUserDataDir(): string | undefined {
  return resolveUserDataDirFromArgv() ?? resolveUserDataDirFromGlobalStorage();
}

/** VS Code 内置扩展中心全局存储 state.vscdb 路径 */
export function resolveStateDbPath(): string | undefined {
  if (stateDbPathOverride !== undefined) {
    return stateDbPathOverride;
  }
  const dir = resolveUserDataDir();
  if (!dir) {
    return undefined;
  }
  return path.join(dir, 'User', 'globalStorage', 'state.vscdb');
}

function openDb(dbPath: string | undefined): Db | undefined {
  const DatabaseSync = loadDatabaseSync();
  const p = dbPath ?? resolveStateDbPath();
  if (!DatabaseSync) {
    log(`[autoUpdateSync] node:sqlite 不可用（Node ${process.versions.node}），降级本地存储`);
    return undefined;
  }
  if (!p) {
    log(
      `[autoUpdateSync] 无法定位 state.vscdb（argv=${JSON.stringify(process.argv.slice(0, 6))}... globalStorageUri=${globalStorageUriValue ?? '未设置'}），降级本地存储`
    );
    return undefined;
  }
  if (!fs.existsSync(p)) {
    log(`[autoUpdateSync] state.vscdb 不存在：${p}，降级本地存储`);
    return undefined;
  }
  try {
    // timeout：SQLite busy timeout（毫秒），避免与 VS Code 主进程写库时锁冲突
    return new DatabaseSync(p, { timeout: 2000 });
  } catch (e) {
    logErr(
      `[autoUpdateSync] 打开 ${p} 失败：${e instanceof Error ? e.message : String(e)}，降级本地存储`
    );
    return undefined;
  }
}

function readList(db: Db, key: string): string[] {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined) {
      return [];
    }
    let v = row.value;
    if (v instanceof Uint8Array) {
      v = Buffer.from(v).toString('utf8');
    }
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.map((x: unknown) => String(x)) : [];
  } catch {
    return [];
  }
}

function writeList(db: Db, key: string, list: string[]): boolean {
  try {
    db.prepare(
      'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, JSON.stringify(list));
    return true;
  } catch (e) {
    logErr(`[autoUpdateSync] 写入 ${key} 失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * 从指定 state.vscdb 读取单扩展 Auto Update 决策（对齐 VS Code isAutoUpdateEnabledFor）：
 * - available=false：SQLite 不可用（无路径/无文件/node:sqlite 不支持），由上层降级本地存储；
 * - hasRecord：该扩展是否在内置商店被单独设置过（用于旧数据惰性迁移）；
 * - value：实际决策（true=自动更新），无记录时即跟随全局默认。
 */
export function getVscodeAutoUpdateFromPath(
  dbPath: string | undefined,
  extId: string
): { available: boolean; hasRecord: boolean; value: boolean } {
  const db = openDb(dbPath);
  if (!db) {
    return { available: false, hasRecord: false, value: isGlobalAutoUpdateEnabled() };
  }
  try {
    const id = extId.toLowerCase();
    const disabled = readList(db, VSCODE_DONOT_AUTO_UPDATE_KEY);
    const enabled = readList(db, VSCODE_AUTO_UPDATE_KEY);
    if (isGlobalAutoUpdateEnabled()) {
      return {
        available: true,
        hasRecord: disabled.includes(id) || enabled.includes(id),
        value: !disabled.includes(id),
      };
    }
    return {
      available: true,
      hasRecord: disabled.includes(id) || enabled.includes(id),
      value: enabled.includes(id),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 写入指定 state.vscdb 的单扩展 Auto Update enablement（对齐 VS Code updateAutoUpdateEnablementFor）：
 * 全局开启时维护 disabled 列表，全局关闭时维护 enabled 列表。返回是否成功。
 */
export function setVscodeAutoUpdateAtPath(
  dbPath: string | undefined,
  extId: string,
  enable: boolean
): boolean {
  const db = openDb(dbPath);
  if (!db) {
    return false;
  }
  try {
    const id = extId.toLowerCase();
    if (isGlobalAutoUpdateEnabled()) {
      const disabled = readList(db, VSCODE_DONOT_AUTO_UPDATE_KEY);
      const i = disabled.indexOf(id);
      if (enable) {
        if (i !== -1) {
          disabled.splice(i, 1);
        }
      } else if (i === -1) {
        disabled.push(id);
      }
      return writeList(db, VSCODE_DONOT_AUTO_UPDATE_KEY, disabled);
    }
    const enabled = readList(db, VSCODE_AUTO_UPDATE_KEY);
    const i = enabled.indexOf(id);
    if (enable) {
      if (i === -1) {
        enabled.push(id);
      }
    } else if (i !== -1) {
      enabled.splice(i, 1);
    }
    return writeList(db, VSCODE_AUTO_UPDATE_KEY, enabled);
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 读取当前 VS Code 内置扩展中心的单扩展 Auto Update 状态（含 available/hasRecord/value） */
export function getVscodeAutoUpdate(extId: string): {
  available: boolean;
  hasRecord: boolean;
  value: boolean;
} {
  return getVscodeAutoUpdateFromPath(resolveStateDbPath(), extId);
}

/** 写入当前 VS Code 内置扩展中心的单扩展 Auto Update enablement（返回是否成功） */
export function setVscodeAutoUpdate(extId: string, enable: boolean): boolean {
  const ok = setVscodeAutoUpdateAtPath(resolveStateDbPath(), extId, enable);
  if (ok) {
    log(`[autoUpdateSync] 已写入 VS Code 扩展商店自动更新：${extId} → ${enable ? 'on' : 'off'}`);
  } else {
    log('[autoUpdateSync] 写入 VS Code 扩展商店自动更新存储失败，已回退本地存储');
  }
  return ok;
}
