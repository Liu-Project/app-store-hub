// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

// vscode mock 的配置 store（由 tests/unit/vscode-mock.ts 预加载共享）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { store } = require('./vscode-mock');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getVscodeAutoUpdateFromPath,
  setVscodeAutoUpdateAtPath,
  resolveUserDataDir,
  VSCODE_AUTO_UPDATE_KEY,
  VSCODE_DONOT_AUTO_UPDATE_KEY,
  __setStateDbPathForTest,
} = require('../../src/vscodeAutoUpdateSync');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getEffectiveAutoUpdate,
  setEffectiveAutoUpdate,
  getAutoUpdateSetting,
} = require('../../src/autoUpdater');

// node:sqlite 需要 Node >= 22.5；环境不支持时跳过同步相关用例
let DatabaseSync: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}
const hasSqlite = typeof DatabaseSync === 'function';
const maybe = hasSqlite ? describe : describe.skip;

function makeMemento() {
  const memStore: Record<string, unknown> = {};
  const mem = {
    get: <T>(key: string, def?: T): T => (key in memStore ? memStore[key] : def) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        delete memStore[key];
      } else {
        memStore[key] = value;
      }
    },
  };
  return { store: memStore, mem };
}

/** 创建临时 state.vscdb（与 VS Code 相同 schema / WAL 模式） */
function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ash-state-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.exec('PRAGMA journal_mode=WAL');
  db.close();
  return { dir, dbPath };
}

function readListRaw(dbPath: string, key: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined) return [];
    let v = row.value;
    if (v instanceof Uint8Array) v = Buffer.from(v).toString('utf8');
    const arr = JSON.parse(String(v));
    return Array.isArray(arr) ? arr.map((x: unknown) => String(x)) : [];
  } finally {
    db.close();
  }
}

describe('resolveUserDataDir 解析扩展宿主 argv', () => {
  const origArgv = process.argv;

  afterEach(() => {
    process.argv = origArgv;
  });

  it('支持 --user-data-dir=path 形式', () => {
    process.argv = ['node', 'x', '--user-data-dir=/tmp/ud', 'y'];
    assert.strictEqual(resolveUserDataDir(), '/tmp/ud');
  });

  it('支持 --user-data-dir path 空格分隔形式', () => {
    process.argv = ['node', 'x', '--user-data-dir', '/tmp/ud2'];
    assert.strictEqual(resolveUserDataDir(), '/tmp/ud2');
  });

  it('无参数时返回 undefined', () => {
    process.argv = ['node', 'x'];
    assert.strictEqual(resolveUserDataDir(), undefined);
  });
});

maybe('vscodeAutoUpdateSync 与 VS Code 内置扩展商店双向同步', () => {
  let dbPath = '';
  let tmpDir = '';

  beforeEach(() => {
    const t = createTempDb();
    dbPath = t.dbPath;
    tmpDir = t.dir;
    __setStateDbPathForTest(dbPath);
    delete store['extensions.autoUpdate'];
  });

  afterEach(() => {
    __setStateDbPathForTest(undefined);
    delete store['extensions.autoUpdate'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('全局开启 + 无记录 → 未单独设置（available，跟随全局默认 true）', () => {
    const st = getVscodeAutoUpdateFromPath(dbPath, 'pub.ext');
    assert.strictEqual(st.available, true);
    assert.strictEqual(st.hasRecord, false);
    assert.strictEqual(st.value, true);
  });

  it('全局开启 + 禁用 → 写入 donotAutoUpdate 列表', () => {
    assert.strictEqual(setVscodeAutoUpdateAtPath(dbPath, 'Pub.Ext', false), true);
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_DONOT_AUTO_UPDATE_KEY), ['pub.ext']);
    const st = getVscodeAutoUpdateFromPath(dbPath, 'pub.ext');
    assert.strictEqual(st.hasRecord, true);
    assert.strictEqual(st.value, false);
  });

  it('全局开启 + 重新启用 → 从 donotAutoUpdate 移除（恢复默认）', () => {
    setVscodeAutoUpdateAtPath(dbPath, 'pub.ext', false);
    setVscodeAutoUpdateAtPath(dbPath, 'pub.ext', true);
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_DONOT_AUTO_UPDATE_KEY), []);
    const st = getVscodeAutoUpdateFromPath(dbPath, 'pub.ext');
    assert.strictEqual(st.hasRecord, false);
    assert.strictEqual(st.value, true);
  });

  it('全局关闭 + 启用 → 写入 autoUpdate 列表（单独启用）', () => {
    store['extensions.autoUpdate'] = 'off';
    assert.strictEqual(setVscodeAutoUpdateAtPath(dbPath, 'Pub.Ext', true), true);
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_AUTO_UPDATE_KEY), ['pub.ext']);
    const st = getVscodeAutoUpdateFromPath(dbPath, 'pub.ext');
    assert.strictEqual(st.hasRecord, true);
    assert.strictEqual(st.value, true);
  });

  it('全局关闭 + 再禁用 → 从 autoUpdate 移除', () => {
    store['extensions.autoUpdate'] = 'off';
    setVscodeAutoUpdateAtPath(dbPath, 'pub.ext', true);
    setVscodeAutoUpdateAtPath(dbPath, 'pub.ext', false);
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_AUTO_UPDATE_KEY), []);
    const st = getVscodeAutoUpdateFromPath(dbPath, 'pub.ext');
    assert.strictEqual(st.hasRecord, false);
    assert.strictEqual(st.value, false);
  });

  it('多个扩展互不影响', () => {
    store['extensions.autoUpdate'] = 'off';
    setVscodeAutoUpdateAtPath(dbPath, 'pub.a', true);
    setVscodeAutoUpdateAtPath(dbPath, 'pub.b', false);
    assert.strictEqual(getVscodeAutoUpdateFromPath(dbPath, 'pub.a').value, true);
    assert.strictEqual(getVscodeAutoUpdateFromPath(dbPath, 'pub.b').hasRecord, false);
  });

  it('setEffectiveAutoUpdate 写内置存储并清除本地缓存（内置为权威）', async () => {
    const { mem } = makeMemento();
    await setEffectiveAutoUpdate(mem, 'Pub.Ext', false);
    // 本地缓存被清除（避免旧缓存被误迁移覆盖内置商店状态）
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), undefined);
    // 内置存储（全局开启 → donotAutoUpdate）
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_DONOT_AUTO_UPDATE_KEY), ['pub.ext']);
    // 有效状态读取一致
    assert.strictEqual(getEffectiveAutoUpdate(mem, 'pub.ext'), false);
  });

  it('getEffectiveAutoUpdate 优先读内置存储（与本地缓存不一致时以内置为准）', async () => {
    const { mem } = makeMemento();
    await setEffectiveAutoUpdate(mem, 'Pub.Ext', false);
    // 模拟内置商店反向修改（从 donotAutoUpdate 移除 → 恢复自动更新）
    setVscodeAutoUpdateAtPath(dbPath, 'pub.ext', true);
    assert.strictEqual(getEffectiveAutoUpdate(mem, 'pub.ext'), true);
  });

  it('旧版本 globalState 数据惰性迁移到内置存储并清除本地记录', async () => {
    const { mem } = makeMemento();
    await mem.update('autoUpdate:pub.ext', 'off');
    // 全局开启默认，无内置记录 → 读取时迁移
    assert.strictEqual(getEffectiveAutoUpdate(mem, 'pub.ext'), false);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(readListRaw(dbPath, VSCODE_DONOT_AUTO_UPDATE_KEY), ['pub.ext']);
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), undefined);
  });

  it('SQLite 不可用（无 db 文件）时降级本地缓存', async () => {
    __setStateDbPathForTest(undefined);
    const { store: memStore, mem } = makeMemento();
    await mem.update('autoUpdate:pub.ext', 'off');
    assert.strictEqual(getEffectiveAutoUpdate(mem, 'pub.ext'), false);
    delete memStore['autoUpdate:pub.ext'];
    assert.strictEqual(getEffectiveAutoUpdate(mem, 'pub.ext'), true);
  });
});
