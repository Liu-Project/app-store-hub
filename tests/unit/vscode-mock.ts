// 共享 vscode mock：在任意测试加载前注册，确保 config/apiClient 模块加载时
// 命中同一份 vscode stub（mock-require 按模块路径全局拦截）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mock = require('mock-require');

const store: Record<string, unknown> = {
  'appStoreHub.sources': [],
  'appStoreHub.activeSource': '',
  'appStoreHub.installMode': 'auto',
};

const vscodeStub = {
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, def: T): T => (store as Record<string, T>)[`${section}.${key}`] ?? def,
      update: async <T>(key: string, value: T) => {
        (store as Record<string, T>)[`${section}.${key}`] = value;
      },
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};

mock('vscode', vscodeStub);

module.exports = { store };
