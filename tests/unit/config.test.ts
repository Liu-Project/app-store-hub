// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { store } = require('./vscode-mock');

// 动态 require，确保在 mock 注册之后加载 config
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSources, getActiveSourceUrl, getInstallMode, setSources } = require('../../src/config');

type SourceConfig = { label: string; url: string; concurrent?: boolean };

function seed(sources: SourceConfig[], active: string): void {
  store['appStoreHub.sources'] = sources;
  store['appStoreHub.activeSource'] = active;
}

describe('config', () => {
  beforeEach(() => {
    seed(
      [
        { label: '本地', url: 'http://127.0.0.1:3000/' },
        { label: '远程', url: 'https://example.com' },
      ],
      'http://127.0.0.1:3000/'
    );
    store['appStoreHub.installMode'] = 'auto';
  });

  it('getSources 归一化 URL（去尾部斜杠）', () => {
    const sources = getSources();
    assert.strictEqual(sources.length, 2);
    assert.strictEqual(sources[0].url, 'http://127.0.0.1:3000');
  });

  it('getActiveSourceUrl 匹配并归一化', () => {
    assert.strictEqual(getActiveSourceUrl(), 'http://127.0.0.1:3000');
  });

  it('getActiveSourceUrl 未匹配时回退首个源', () => {
    seed([{ label: 'A', url: 'http://a' }], 'http://not-exists');
    assert.strictEqual(getActiveSourceUrl(), 'http://a');
  });

  it('getSources 为空时使用默认源', () => {
    seed([], '');
    const sources = getSources();
    assert.strictEqual(sources.length, 3);
    assert.strictEqual(sources[0].url, 'https://marketplace.visualstudio.com/_apis/public/gallery');
    assert.strictEqual(sources[1].url, 'https://open-vsx.org/vscode/gallery');
  });

  it('默认源并发开关：微软关闭、Open VSX 开启', () => {
    seed([], '');
    const sources = getSources();
    assert.strictEqual(sources[0].concurrent, false);
    assert.strictEqual(sources[1].concurrent, true);
    assert.strictEqual(sources[2].concurrent, false);
  });

  it('getSources 归一化并发开关为布尔值', () => {
    seed(
      [
        { label: 'A', url: 'http://a', concurrent: true },
        { label: 'B', url: 'http://b' },
      ],
      'http://a'
    );
    const sources = getSources();
    assert.strictEqual(sources[0].concurrent, true);
    assert.strictEqual(sources[1].concurrent, false);
  });

  it('setSources 保留并发开关', async () => {
    seed([{ label: '旧', url: 'http://old', concurrent: true }], 'http://old');
    await setSources([{ label: '新', url: 'http://new', concurrent: true }]);
    const sources = getSources();
    assert.strictEqual(sources[0].concurrent, true);
  });

  it('getInstallMode 返回配置值', () => {
    assert.strictEqual(getInstallMode(), 'auto');
    store['appStoreHub.installMode'] = 'manual';
    assert.strictEqual(getInstallMode(), 'manual');
  });

  it('setSources 过滤非法项并回退 activeSource', async () => {
    seed([{ label: '旧', url: 'http://old' }], 'http://old');
    await setSources([
      { label: '新', url: 'http://new' },
      { label: '坏', url: '' },
      { label: 'bad', url: 'not-a-url' },
    ]);
    const sources = getSources();
    assert.strictEqual(sources.length, 2);
    assert.strictEqual(getActiveSourceUrl(), 'http://new');
  });
});
