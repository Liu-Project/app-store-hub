// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { store } = require('./vscode-mock');

// 动态 require，确保在 mock 注册之后加载
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getLanguage } = require('../../src/config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const i18n = require('../../src/i18n');

describe('i18n 语言切换', () => {
  beforeEach(() => {
    store['appStoreHub.language'] = 'auto';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    vscode.env.language = 'zh-cn';
    i18n.setLang('auto');
  });

  it('config.getLanguage 默认 auto', () => {
    assert.strictEqual(getLanguage(), 'auto');
  });

  it('config.getLanguage 返回显式值', () => {
    store['appStoreHub.language'] = 'en';
    assert.strictEqual(getLanguage(), 'en');
    store['appStoreHub.language'] = 'zh-cn';
    assert.strictEqual(getLanguage(), 'zh-cn');
  });

  it('auto + zh 前缀语言 → 中文文案', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    vscode.env.language = 'zh-cn';
    i18n.setLang('auto');
    assert.strictEqual(i18n.t('reload'), '重新加载');
    assert.strictEqual(i18n.t('install'), '安装');
  });

  it('auto + en 语言 → 英文文案', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    vscode.env.language = 'en';
    i18n.setLang('auto');
    assert.strictEqual(i18n.t('reload'), 'Reload');
    assert.strictEqual(i18n.t('install'), 'Install');
  });

  it('显式 en 覆盖 auto 的 zh 语言', () => {
    store['appStoreHub.language'] = 'en';
    i18n.setLang('auto');
    assert.strictEqual(i18n.t('reload'), 'Reload');
  });

  it('显式 zh-cn 覆盖 auto 的 en 语言', () => {
    store['appStoreHub.language'] = 'zh-cn';
    i18n.setLang('auto');
    assert.strictEqual(i18n.t('reload'), '重新加载');
  });

  it('setLang 强制指定语言', () => {
    i18n.setLang('en');
    assert.strictEqual(i18n.t('reload'), 'Reload');
    i18n.setLang('zh-cn');
    assert.strictEqual(i18n.t('reload'), '重新加载');
  });

  it('t 支持占位符参数替换', () => {
    i18n.setLang('zh-cn');
    assert.strictEqual(
      i18n.t('installingVersion', 'Foo', '1.0.0'),
      '正在安装 Foo 1.0.0...'
    );
    i18n.setLang('en');
    assert.strictEqual(i18n.t('installingVersion', 'Foo', '1.0.0'), 'Installing Foo 1.0.0...');
  });

  it('t 未知 key 回退为 key 本身', () => {
    i18n.setLang('zh-cn');
    assert.strictEqual(i18n.t('no.such.key'), 'no.such.key');
  });

  it('uiLocale 返回解析后的语言', () => {
    i18n.setLang('en');
    assert.strictEqual(i18n.uiLocale(), 'en');
    i18n.setLang('zh-cn');
    assert.strictEqual(i18n.uiLocale(), 'zh-cn');
  });
});
