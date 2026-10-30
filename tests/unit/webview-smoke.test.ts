// webview 初始化冒烟测试：确保 appStoreHub.js / detail.js 在最小 DOM 环境下可正常初始化
// 防止再次出现「首行被误改导致整个脚本运行时崩溃、面板一片黑」的回归。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require('vm');

const WEBVIEW_DIR = path.resolve(__dirname, '../../webview');

function readWebview(name: string): string {
  return fs.readFileSync(path.join(WEBVIEW_DIR, name), 'utf8');
}

function makeEl() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    innerHTML: '',
    value: '',
    className: '',
    textContent: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    style: {},
    dataset: {},
    addEventListener(type: string, fn: (...args: unknown[]) => void) {
      listeners[type] = fn;
    },
    removeEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {},
    remove() {},
    focus() {},
    click() {},
  };
}

function makeSandbox(postMessageCalls: unknown[]) {
  return {
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      body: makeEl(),
      createElement: makeEl,
      getElementById: () => makeEl(),
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { addEventListener() {} },
    location: { search: '' },
    acquireVsCodeApi: () => ({
      postMessage(m: unknown) { postMessageCalls.push(m); },
      getState() { return undefined; },
      setState() {},
    }),
  };
}

describe('webview 初始化冒烟测试', () => {
  it('appStoreHub.js 以正确 IIFE 开头并完整闭合', () => {
    const src = readWebview('appStoreHub.js');
    assert.ok(/^\(function \(\) \{/.test(src), 'appStoreHub.js 必须以 (function () { 开头');
    assert.ok(/\}\)\(\);?\s*$/.test(src), 'appStoreHub.js 必须以 }); 闭合');
  });

  it('detail.js 以正确 IIFE 开头并完整闭合', () => {
    const src = readWebview('detail.js');
    assert.ok(/^\(function \(\) \{/.test(src), 'detail.js 必须以 (function () { 开头');
    assert.ok(/\}\)\(\);?\s*$/.test(src), 'detail.js 必须以 }); 闭合');
  });

  it('appStoreHub.js 在最小 DOM 环境初始化无异常且发起消息', () => {
    const calls: unknown[] = [];
    const sandbox = makeSandbox(calls);
    assert.doesNotThrow(() => {
      vm.runInNewContext(readWebview('appStoreHub.js'), sandbox, {
        filename: 'appStoreHub.js',
      });
    }, 'appStoreHub.js 初始化不应抛出异常');
    assert.ok(calls.length > 0, '初始化后应通过 acquireVsCodeApi().postMessage 发起消息');
  });

  it('detail.js 在最小 DOM 环境初始化无异常', () => {
    const calls: unknown[] = [];
    const sandbox = makeSandbox(calls);
    assert.doesNotThrow(() => {
      vm.runInNewContext(readWebview('detail.js'), sandbox, { filename: 'detail.js' });
    }, 'detail.js 初始化不应抛出异常');
  });

  it('detail.js 图片代理：data-img-src 必须插入到 img 标签闭合符之前（防止落到标签外）', () => {
    // 回归防护：此前用 noImg += ' data-img-src=...' 追加，对非自闭合 <img> 会落到标签外，
    // 导致 querySelector 匹配不到（图片永不显示）且页面出现可见文本
    const src = readWebview('detail.js');
    assert.ok(
      src.includes('noImg = noImg.replace(/\\/?>$/, function (end) {'),
      'data-img-src 应通过替换闭合符插入到 img 标签内'
    );
    assert.ok(
      !src.includes("noImg += ' data-img-src="),
      '不应再使用 += 追加 data-img-src'
    );
  });

  it('detail.js 图片代理：src 匹配兼容无引号形式（<img src=https://... width=...>）', () => {
    // python 等扩展 README 使用无引号 src，即使 DOMPurify 未规范化属性也必须能代理
    const src = readWebview('detail.js');
    assert.ok(
      src.includes('var IMG_SRC_RE = /\\bsrc\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))/i;'),
      '应使用兼容引号/无引号 src 的 IMG_SRC_RE'
    );
    assert.ok(
      !src.includes('tag.match(/\\bsrc="(https?:[^"]+)"/i)'),
      '不应只匹配带双引号的 src'
    );
  });

  it('i18n.js 在最小 DOM 环境初始化并提供 t()（默认中文）', () => {
    const calls: unknown[] = [];
    const sandbox = makeSandbox(calls);
    sandbox.window.__APPSTORE_LOCALE__ = undefined;
    assert.doesNotThrow(() => {
      vm.runInNewContext(readWebview('i18n.js'), sandbox, { filename: 'i18n.js' });
    }, 'i18n.js 初始化不应抛出异常');
    assert.strictEqual(typeof sandbox.window.t, 'function', '应提供 window.t');
    assert.strictEqual(sandbox.window.t('install'), '安装', '默认应为中文文案');
    assert.strictEqual(sandbox.window.t('no.such.key'), 'no.such.key', '未知 key 回退为 key');
  });

  it('i18n.js 支持英文切换（__APPSTORE_LOCALE__=en）', () => {
    const calls: unknown[] = [];
    const sandbox = makeSandbox(calls);
    sandbox.window.__APPSTORE_LOCALE__ = 'en';
    vm.runInNewContext(readWebview('i18n.js'), sandbox, { filename: 'i18n.js' });
    assert.strictEqual(sandbox.window.t('install'), 'Install');
    assert.strictEqual(sandbox.window.t('update'), 'Update');
  });

  it('webview 脚本引用的所有 i18n key 都已在 i18n.js 字典中定义', () => {
    const i18nSrc = readWebview('i18n.js');
    const zhStart = i18nSrc.indexOf('var zh = {');
    const enStart = i18nSrc.indexOf('var en = {');
    const zhBlock = i18nSrc.slice(zhStart, enStart);
    const enBlock = i18nSrc.slice(enStart);
    const zhKeys = new Set(
      [...zhBlock.matchAll(/^\s*'([a-zA-Z0-9._]+)':/gm)].map((m) => m[1])
    );
    const enKeys = new Set(
      [...enBlock.matchAll(/^\s*'([a-zA-Z0-9._]+)':/gm)].map((m) => m[1])
    );
    const used = new Set<string>();
    ['appStoreHub.js', 'detail.js'].forEach((f) => {
      const src = readWebview(f);
      const re = /[^.]\bt\((['"])([a-zA-Z0-9._]+)\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        used.add(m[2]);
      }
    });
    const missingZh = [...used].filter((k) => !zhKeys.has(k));
    const missingEn = [...used].filter((k) => !enKeys.has(k));
    assert.deepStrictEqual(missingZh, [], `i18n.js 中文缺 key: ${missingZh.join(', ')}`);
    assert.deepStrictEqual(missingEn, [], `i18n.js 英文缺 key: ${missingEn.join(', ')}`);
  });
});
