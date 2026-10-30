// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safePost } = require('../../src/safePost');

describe('safePost 安全发送', () => {
  it('正常发送消息不抛异常', async () => {
    let received: unknown;
    const webview = {
      postMessage: (m: unknown) => {
        received = m;
        return Promise.resolve(true);
      },
    };
    safePost(webview, { type: 'ping' });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(received, { type: 'ping' });
  });

  it('postMessage 返回 rejected promise（webview 已销毁）时不抛异常', async () => {
    const webview = {
      postMessage: () => Promise.reject(new Error('Webview is disposed')),
    };
    assert.doesNotThrow(() => safePost(webview, { type: 'ping' }));
    await new Promise((r) => setTimeout(r, 10));
  });

  it('postMessage 同步抛异常（webview 已销毁）时不抛异常', () => {
    const webview = {
      postMessage: () => {
        throw new Error('Webview is disposed');
      },
    };
    assert.doesNotThrow(() => safePost(webview, { type: 'ping' }));
  });
});
