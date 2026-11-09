// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compareVersions } = require('../../src/version');

describe('compareVersions', () => {
  it('相同版本返回 0', () => {
    assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
    assert.strictEqual(compareVersions('0.1.23', '0.1.23'), 0);
  });

  it('数字段比较', () => {
    assert.ok(compareVersions('1.2.3', '1.2.2') > 0);
    assert.ok(compareVersions('1.2.2', '1.2.3') < 0);
    assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('0.0.11', '0.0.9') > 0);
    assert.ok(compareVersions('0.2.9', '0.2.11') < 0);
  });

  it('缺位视为 0（兼容 1.2 / 1.2.3.4）', () => {
    assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.3', '1.2') > 0);
    assert.ok(compareVersions('1.2.3.4', '1.2.3') > 0);
  });

  it('预发布低于正式版', () => {
    assert.ok(compareVersions('1.0.0', '1.0.0-alpha') > 0);
    assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
    assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
    assert.ok(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2') > 0);
    assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  });

  it('构建元数据不参与比较', () => {
    assert.strictEqual(compareVersions('1.0.0+build1', '1.0.0'), 0);
  });

  it('无效版本退化为字符串比较', () => {
    assert.ok(compareVersions('v1.0.0', '1.0.0') > 0);
    assert.strictEqual(compareVersions('abc', 'abc'), 0);
  });
});
