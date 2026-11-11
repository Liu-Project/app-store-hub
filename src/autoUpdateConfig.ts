import * as vscode from 'vscode';

/**
 * 全局自动更新开关（对齐 VS Code extensions.autoUpdate）：
 * VS Code 默认值为布尔 true，用户也可能配置为 false 或字符串 'on'/'off'，统一兼容。
 */
export function isGlobalAutoUpdateEnabled(): boolean {
  try {
    const v = vscode.workspace.getConfiguration('extensions').get<unknown>('autoUpdate', true);
    return v === true || v === 'on';
  } catch {
    return true;
  }
}
