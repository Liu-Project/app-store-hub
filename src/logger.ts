import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel | undefined {
  try {
    if (!channel && vscode.window && typeof vscode.window.createOutputChannel === 'function') {
      channel = vscode.window.createOutputChannel('插件中心');
    }
    return channel;
  } catch {
    return undefined;
  }
}

function now(): string {
  return new Date().toISOString().slice(11, 23);
}

/** 激活时立即创建输出通道，确保用户打开输出面板即可看到「插件中心」通道 */
export function initLogger(): void {
  getChannel();
  log('插件中心已激活');
}

/** 调试日志开关（appStoreHub.debug）：关闭后 log() 静默，logErr() 始终输出 */
export function debugEnabled(): boolean {
  try {
    return !!vscode.workspace.getConfiguration('appStoreHub').get<boolean>('debug', true);
  } catch {
    return true;
  }
}

/** 写入「插件中心」输出面板；非 VS Code 环境（单元测试）回退到 console */
export function log(msg: string): void {
  if (!debugEnabled()) {
    return;
  }
  const c = getChannel();
  if (c) {
    c.appendLine(`[${now()}] ${msg}`);
  } else {
    console.log(`[插件中心] ${msg}`);
  }
}

export function logErr(msg: string): void {
  const c = getChannel();
  if (c) {
    c.appendLine(`[${now()}] [ERROR] ${msg}`);
  } else {
    console.error(`[插件中心] [ERROR] ${msg}`);
  }
}
