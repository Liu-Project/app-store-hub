import * as vscode from 'vscode';
import { AppStoreHubPanel } from './appStoreHubPanel';
import { initLogger } from './logger';

let panelProvider: AppStoreHubPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // 立即创建「插件中心」输出通道，日志从激活即开始记录
  initLogger();
  panelProvider = new AppStoreHubPanel(context.extensionUri, context.globalState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AppStoreHubPanel.viewType, panelProvider)
  );

  const openCommand = vscode.commands.registerCommand('appStoreHub.open', async () => {
    await vscode.commands.executeCommand('appStoreHub.main.focus');
    if (panelProvider) {
      panelProvider.refresh();
    }
  });
  context.subscriptions.push(openCommand);

  context.subscriptions.push(
    vscode.commands.registerCommand('appStoreHub.searchCategory', (category: string) => {
      panelProvider?.searchCategory(category);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('appStoreHub.toggleDebug', async () => {
      const cfg = vscode.workspace.getConfiguration('appStoreHub');
      const cur = cfg.get<boolean>('debug', true);
      await cfg.update('debug', !cur, vscode.ConfigurationTarget.Global);
      const msg = `插件中心调试日志已${cur ? '关闭' : '开启'}`;
      void vscode.window.showInformationMessage(msg);
      if (cur) {
        // 关闭后清空历史输出，避免误读旧日志
        void vscode.commands.executeCommand('workbench.action.output.clear');
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('appStoreHub.activeSource') && panelProvider) {
        panelProvider.refresh();
      }
    })
  );

}

export function deactivate(): void {
  panelProvider = undefined;
}
