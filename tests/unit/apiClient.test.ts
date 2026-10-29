// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');

// vscode mock 由 tests/unit/vscode-mock.ts（mocha --require 预加载）统一提供

type GalleryExtension = import('../../src/apiClient').GalleryExtension;

// 动态 require，确保在 mock 注册之后加载 apiClient
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ApiClient,
  ApiError,
  galleryToAppInfo,
  GALLERY_ASSET_VSIX,
  GALLERY_ASSET_ICON,
  GALLERY_ASSET_DETAILS,
  GALLERY_ASSET_CHANGELOG,
} = require('../../src/apiClient');

function sampleExtension(overrides: Partial<GalleryExtension> = {}): GalleryExtension {
  return {
    publisher: {
      publisherId: 'p1',
      publisherName: 'testpub',
      displayName: 'Test Publisher',
    },
    extensionId: 'e1',
    extensionName: 'hello-world',
    displayName: 'Hello World',
    shortDescription: 'A sample extension',
    versions: [
      {
        version: '1.0.0',
        lastUpdated: '2026-01-02T03:04:05Z',
        versionDescription: 'First release',
        files: [
          {
            assetType: GALLERY_ASSET_VSIX,
            source: 'https://cdn.example.com/hello-1.0.0.vsix',
          },
          {
            assetType: GALLERY_ASSET_ICON,
            source: 'https://cdn.example.com/icon.png',
          },
          {
            assetType: GALLERY_ASSET_DETAILS,
            source: 'https://cdn.example.com/README.md',
          },
          {
            assetType: GALLERY_ASSET_CHANGELOG,
            source: 'https://cdn.example.com/CHANGELOG.md',
          },
        ],
      },
    ],
    categories: ['Other'],
    tags: ['demo'],
    statistics: [
      { statisticName: 'install', value: 1234 },
      { statisticName: 'averagerating', value: 4.5 },
      { statisticName: 'ratingcount', value: 10 },
    ],
    iconUrl: '',
    lastUpdated: '2026-01-02T03:04:05Z',
    publishedDate: '2026-01-01T00:00:00Z',
    releaseDate: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('galleryToAppInfo', () => {
  it('映射核心字段', () => {
    const app = galleryToAppInfo(sampleExtension());
    assert.strictEqual(app.id, 'testpub.hello-world');
    assert.strictEqual(app.name, 'hello-world');
    assert.strictEqual(app.publisher, 'testpub');
    assert.strictEqual(app.displayName, 'Hello World');
    assert.strictEqual(app.description, 'A sample extension');
    assert.strictEqual(app.version, '1.0.0');
    assert.strictEqual(app.hasPackage, true);
    assert.strictEqual(app.downloadCount, 1234);
    assert.strictEqual(app.rating, 4.5);
    assert.strictEqual(app.ratingCount, 10);
    assert.strictEqual(app.releaseDate, '2026-01-01');
  });

  it('映射资产 URL 与版本列表', () => {
    const app = galleryToAppInfo(sampleExtension());
    assert.ok(app.vsixUrl?.includes('hello-1.0.0.vsix'));
    assert.ok(app.icon?.includes('icon.png'));
    assert.ok(app.readmeUrl?.includes('README.md'));
    assert.ok(app.changelogUrl?.includes('CHANGELOG.md'));
    assert.strictEqual(app.versions.length, 1);
    assert.strictEqual(app.versions[0].version, '1.0.0');
    assert.strictEqual(app.versions[0].hasPackage, true);
    assert.strictEqual(app.versions[0].date, '2026-01-02');
  });

  it('无 vsix 时 hasPackage=false', () => {
    const app = galleryToAppInfo(
      sampleExtension({
        versions: [
          {
            version: '1.0.0',
            lastUpdated: '',
            versionDescription: '',
            files: [{ assetType: 'Other', source: 'x' }],
          },
        ],
      })
    );
    assert.strictEqual(app.hasPackage, false);
    assert.strictEqual(app.vsixUrl, '');
  });

  it('版本历史按 targetPlatform 过滤（对齐 VS Code isTargetPlatformCompatible）', () => {
    const app = galleryToAppInfo(
      sampleExtension({
        versions: [
          { version: '2.0.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }], targetPlatform: 'linux-x64' },
          { version: '2.0.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }], targetPlatform: 'universal' },
          { version: '1.9.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }], targetPlatform: 'win32-x64' },
          { version: '1.8.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }] },
        ],
      }),
      { targetPlatform: 'linux-x64' }
    );
    const ver = app.versions.map((v) => v.version);
    // win32-x64 不兼容被排除；2.0.0 出现两次按版本号去重只留一条
    assert.deepStrictEqual(ver, ['2.0.0', '1.8.0']);
  });

  it('universal 与未定义平台视为通用（兼容）', () => {
    const app = galleryToAppInfo(
      sampleExtension({
        versions: [
          { version: '3.0.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }], targetPlatform: 'universal' },
          { version: '2.0.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }] },
        ],
      }),
      { targetPlatform: 'darwin-arm64' }
    );
    assert.deepStrictEqual(app.versions.map((v) => v.version), ['3.0.0', '2.0.0']);
  });

  it('release 通道排除预发布版本；includePreRelease 时保留', () => {
    const versions = [
      { version: '2.0.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }] },
      { version: '1.5.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }], properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] },
      { version: '1.4.0', lastUpdated: '', files: [{ assetType: GALLERY_ASSET_VSIX, source: 'u' }] },
    ];
    // 最新版非 pre-release → 默认 release 通道排除 1.5.0
    const release = galleryToAppInfo(sampleExtension({ versions }), { targetPlatform: 'linux-x64' });
    assert.deepStrictEqual(release.versions.map((v) => v.version), ['2.0.0', '1.4.0']);
    const withPre = galleryToAppInfo(sampleExtension({ versions }), { targetPlatform: 'linux-x64', includePreRelease: true });
    assert.deepStrictEqual(withPre.versions.map((v) => v.version), ['2.0.0', '1.5.0', '1.4.0']);
  });
});

describe('ApiClient', () => {
  describe('targetPlatform', () => {
    it('返回 win32-x64', () => {
      const orig = { p: process.platform, a: process.arch };
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      assert.strictEqual(ApiClient.targetPlatform(), 'win32-x64');
      Object.defineProperty(process, 'platform', { value: orig.p });
      Object.defineProperty(process, 'arch', { value: orig.a });
    });
  });

  describe('galleryEndpoint', () => {
    it('追加 /vscode/gallery', () => {
      const c = new ApiClient('http://127.0.0.1:3000/');
      assert.strictEqual(c.galleryEndpoint(), 'http://127.0.0.1:3000/vscode/gallery');
    });

    it('已包含时不再追加', () => {
      const c = new ApiClient('http://x/vscode/gallery');
      assert.strictEqual(c.galleryEndpoint(), 'http://x/vscode/gallery');
    });
  });

  describe('ApiError', () => {
    it('携带状态码', () => {
      const e = new ApiError(404, 'not found');
      assert.strictEqual(e.status, 404);
      assert.strictEqual(e.message, 'not found');
    });
  });
});

describe('ApiClient 连接重试', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mock = require('mock-require');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  // mock-require 以绝对路径作为 key，才能命中 apiClient 内部的 require('./netHttp')
  const NET_HTTP_PATH = path.resolve(__dirname, '../../src/netHttp.ts');

  function makeNetHttpMock(handler: (calls: number) => unknown) {
    const calls = { n: 0 };
    const netHttpMock = {
      HttpError: class extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      },
      httpRequest: async () => {
        calls.n += 1;
        return handler(calls.n);
      },
    };
    return { calls, netHttpMock };
  }

  function reloadApiClient(): {
    ApiClient: new (baseUrl: string) => {
      request: <T>(
        p: string,
        o?: unknown,
        r?: number,
        t?: number,
        concurrent?: boolean
      ) => Promise<T>;
    };
    ApiError: new (status: number, message: string) => Error;
  } {
    delete require.cache[require.resolve('../../src/apiClient')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/apiClient');
  }

  afterEach(() => {
    mock.stop(NET_HTTP_PATH);
    delete require.cache[require.resolve('../../src/apiClient')];
  });

  it('顺序模式：稳定源首连成功只发 1 个请求（不并发，避免触发限流）', async () => {
    const { calls, netHttpMock } = makeNetHttpMock(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: true }),
    }));
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const result = await c.request('/api/x', {}, 4, undefined, false);
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(calls.n, 1);
  });

  it('顺序模式：连续失败全部按单连接顺序重试，不并发', async () => {
    const { calls, netHttpMock } = makeNetHttpMock((n) => {
      if (n < 3) {
        throw new netHttpMock.HttpError(0, '连接超时');
      }
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
    });
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const result = await c.request('/api/x', {}, 4, undefined, false);
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(calls.n, 3);
  });

  it('并发模式：失败后并发赛跑直到成功', async () => {
    const { calls, netHttpMock } = makeNetHttpMock((n) => {
      if (n < 2) {
        throw new netHttpMock.HttpError(0, '连接超时');
      }
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
    });
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const result = await c.request('/api/x', {}, 4, undefined, true);
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(calls.n >= 2, `应至少发起 2 次连接，实际 ${calls.n}`);
  });

  it('重试耗尽后抛出 ApiError(0) 连接错误', async () => {
    const { calls, netHttpMock } = makeNetHttpMock(() => {
      throw new netHttpMock.HttpError(0, '连接超时');
    });
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient, ApiError } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    await assert.rejects(
      () => c.request('/api/x', {}, 2),
      (e: Error) =>
        e instanceof ApiError && e.status === 0 && /无法连接软件源/.test(e.message)
    );
    assert.strictEqual(calls.n, 3);
  });

  it('单次尝试连接失败直接抛 ApiError(0)，不重试', async () => {
    const { calls, netHttpMock } = makeNetHttpMock(() => {
      throw new netHttpMock.HttpError(0, '连接超时');
    });
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient, ApiError } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    await assert.rejects(
      () => c.request('/api/x', {}, 0),
      (e: Error) => e instanceof ApiError && e.status === 0
    );
    assert.strictEqual(calls.n, 1);
  });

  it('HTTP 错误码不重试', async () => {
    const { calls, netHttpMock } = makeNetHttpMock(() => ({
      status: 500,
      headers: {},
      body: 'oops',
    }));
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    await assert.rejects(() => c.request('/api/x', {}, 4), /HTTP 500/);
    assert.strictEqual(calls.n, 1);
  });

  it('非连接类异常不重试', async () => {
    const { calls, netHttpMock } = makeNetHttpMock(() => {
      throw new Error('unexpected');
    });
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    await assert.rejects(() => c.request('/api/x', {}, 4), /unexpected/);
    assert.strictEqual(calls.n, 1);
  });

  it('并发阶段首个成功即返回，并取消仍挂起的连接', async () => {
    const calls = { n: 0 };
    const aborted = { n: 0 };
    const netHttpMock = {
      HttpError: class extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      },
      httpRequest: async (_url: string, options: { signal?: AbortSignal }) => {
        calls.n += 1;
        if (calls.n === 1) {
          // 首次单连接失败
          throw new netHttpMock.HttpError(0, '连接超时');
        }
        if (calls.n === 2) {
          // 并发阶段第一个连接挂起，仅在收到取消信号时结束
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              aborted.n += 1;
              reject(new netHttpMock.HttpError(0, '请求已取消'));
            });
          });
        }
        // 并发阶段第二个连接快速成功
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
      },
    };
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const result = await c.request('/api/x', {}, 2, undefined, true);
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(calls.n, 3);
    assert.strictEqual(aborted.n, 1);
  });

  it('getJson 支持绝对 URL 且解析 JSON（详情页 manifest 获取）', async () => {
    const urls: string[] = [];
    const { netHttpMock } = makeNetHttpMock(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ name: 'gitlens', contributes: { commands: [] } }),
    }));
    netHttpMock.httpRequest = async (url: string) => {
      urls.push(url);
      return { status: 200, headers: {}, body: JSON.stringify({ name: 'gitlens' }) };
    };
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const json = await c.getJson<{ name: string }>(
      'https://open-vsx.org/api/eamodio/gitlens/2026.1.1/file/package.json'
    );
    assert.strictEqual(json.name, 'gitlens');
    assert.deepStrictEqual(urls, ['https://open-vsx.org/api/eamodio/gitlens/2026.1.1/file/package.json']);
  });

  it('getText 返回原始文本（详情页 readme/changelog 获取）', async () => {
    const { netHttpMock } = makeNetHttpMock(() => ({
      status: 200,
      headers: {},
      body: '# Hello\n\nWorld',
    }));
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    const c = new ApiClient('http://127.0.0.1:3000');
    const text = await c.getText('https://open-vsx.org/api/x/y/1.0.0/file/README.md');
    assert.ok(text.includes('# Hello'));
  });

  it('getJson 走配置驱动的并发策略：open-vsx 配置并发时失败后并发赛跑', async () => {
    const calls = { n: 0 };
    const netHttpMock = {
      HttpError: class extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      },
      httpRequest: async () => {
        calls.n += 1;
        if (calls.n < 2) {
          throw new netHttpMock.HttpError(0, '连接超时');
        }
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
      },
    };
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    // open-vsx 配置 concurrent=true → getJson 内部走并发赛跑（首轮即多连接）
    const c = new ApiClient('https://open-vsx.org/vscode/gallery');
    const result = await c.getJson('https://open-vsx.org/api/x/y/1.0.0/file/package.json');
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(calls.n >= 2, `应至少发起 2 次连接，实际 ${calls.n}`);
  });

  it('getJson 走配置驱动的并发策略：微软配置非并发时顺序重试', async () => {
    const calls = { n: 0 };
    const netHttpMock = {
      HttpError: class extends Error {
        status: number;
        constructor(status: number, message: string) {
          super(message);
          this.status = status;
        }
      },
      httpRequest: async () => {
        calls.n += 1;
        if (calls.n < 2) {
          throw new netHttpMock.HttpError(0, '连接超时');
        }
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
      },
    };
    mock(NET_HTTP_PATH, netHttpMock);
    const { ApiClient } = reloadApiClient();
    // 微软配置 concurrent=false → 顺序单连接重试（每轮只发 1 个）
    const c = new ApiClient('https://marketplace.visualstudio.com/vscode/gallery');
    const result = await c.getJson('https://x/vscode/file/package.json');
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(calls.n >= 2, `应至少重试 2 次，实际 ${calls.n}`);
  });
});
