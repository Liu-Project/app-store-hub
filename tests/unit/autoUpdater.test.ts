// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');

// vscode mock 的配置 store（由 tests/unit/vscode-mock.ts 预加载共享）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { store } = require('./vscode-mock');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getAutoUpdateSetting,
  setAutoUpdateSetting,
  getInstalledUpdate,
  setInstalledUpdate,
  isGlobalAutoUpdateEnabled,
  shouldAutoUpdate,
} = require('../../src/autoUpdater');

function makeMemento() {
  const store: Record<string, unknown> = {};
  const mem = {
    get: <T>(key: string, def?: T): T => (key in store ? store[key] : def) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        delete store[key];
      } else {
        store[key] = value;
      }
    },
  };
  return { store, mem };
}

describe('autoUpdater 单扩展自动更新设置', () => {
  it('未设置时返回 undefined（跟随全局）', () => {
    const { mem } = makeMemento();
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), undefined);
  });

  it('写入 on/off 后能读回', async () => {
    const { mem } = makeMemento();
    await setAutoUpdateSetting(mem, 'pub.ext', 'on');
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), 'on');
    await setAutoUpdateSetting(mem, 'pub.ext', 'off');
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), 'off');
  });

  it('写入 undefined 恢复为跟随全局', async () => {
    const { mem } = makeMemento();
    await setAutoUpdateSetting(mem, 'pub.ext', 'on');
    await setAutoUpdateSetting(mem, 'pub.ext', undefined);
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.ext'), undefined);
  });

  it('不同扩展互不影响', async () => {
    const { mem } = makeMemento();
    await setAutoUpdateSetting(mem, 'pub.a', 'off');
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.b'), undefined);
    assert.strictEqual(getAutoUpdateSetting(mem, 'pub.a'), 'off');
  });
});

describe('autoUpdater 防重复安装标记', () => {
  it('默认无待重启标记', () => {
    const { mem } = makeMemento();
    assert.strictEqual(getInstalledUpdate(mem, 'pub.ext'), undefined);
  });

  it('记录与清除待重启标记', async () => {
    const { mem } = makeMemento();
    await setInstalledUpdate(mem, 'pub.ext', '1.2.3');
    assert.strictEqual(getInstalledUpdate(mem, 'pub.ext'), '1.2.3');
    await setInstalledUpdate(mem, 'pub.ext', undefined);
    assert.strictEqual(getInstalledUpdate(mem, 'pub.ext'), undefined);
  });
});

describe('isGlobalAutoUpdateEnabled 全局自动更新开关', () => {
  afterEach(() => {
    delete store['extensions.autoUpdate'];
  });

  it('默认（未配置）为开启（VS Code 默认 true）', () => {
    delete store['extensions.autoUpdate'];
    assert.strictEqual(isGlobalAutoUpdateEnabled(), true);
  });

  it('布尔 true 为开启', () => {
    store['extensions.autoUpdate'] = true;
    assert.strictEqual(isGlobalAutoUpdateEnabled(), true);
  });

  it("字符串 'on' 为开启", () => {
    store['extensions.autoUpdate'] = 'on';
    assert.strictEqual(isGlobalAutoUpdateEnabled(), true);
  });

  it('布尔 false 为关闭', () => {
    store['extensions.autoUpdate'] = false;
    assert.strictEqual(isGlobalAutoUpdateEnabled(), false);
  });

  it("字符串 'off' 为关闭", () => {
    store['extensions.autoUpdate'] = 'off';
    assert.strictEqual(isGlobalAutoUpdateEnabled(), false);
  });
});

describe('shouldAutoUpdate 自动更新决策', () => {
  it('全局开启 + 未单独设置 → 自动更新', () => {
    assert.strictEqual(shouldAutoUpdate(true, undefined), true);
  });

  it('全局开启 + 单独 off → 不更新该扩展', () => {
    assert.strictEqual(shouldAutoUpdate(true, 'off'), false);
  });

  it('全局关闭 + 未单独设置 → 不自动更新', () => {
    assert.strictEqual(shouldAutoUpdate(false, undefined), false);
  });

  it('全局关闭 + 单独 on → 仍自动更新（用户显式要求）', () => {
    assert.strictEqual(shouldAutoUpdate(false, 'on'), true);
  });

  it('全局开启 + 单独 on → 自动更新', () => {
    assert.strictEqual(shouldAutoUpdate(true, 'on'), true);
  });

  it('全局关闭 + 单独 off → 不更新', () => {
    assert.strictEqual(shouldAutoUpdate(false, 'off'), false);
  });
});
