import * as vscode from 'vscode';
import { AppStoreHubPanel } from './appStoreHubPanel';
import { AutoUpdater } from './autoUpdater';
import { initLogger } from './logger';
import { t } from './i18n';

let panelProvider: AppStoreHubPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // 立即创建「插件中心」输出通道，日志从激活即开始记录
  initLogger();
  panelProvider = new AppStoreHubPanel(context.extensionUri, context.globalState);

  // 后台自动更新（对齐 VS Code 原生插件中心 AutoUpdater）：
  // 启动后延迟首次检查，之后每 5 分钟检查已安装扩展是否有更新并自动安装
  const autoUpdater = new AutoUpdater(context.globalState);
  autoUpdater.start(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AppStoreHubPanel.viewType, panelProvider, {
      // WebviewView 的 retainContextWhenHidden 必须在注册时通过 webviewOptions 设置才会生效：
      // 切走（切换到其它活动栏视图/折叠）时保留 webview 上下文，切回时内容与滚动位置原样恢复
      webviewOptions: { retainContextWhenHidden: true },
    })
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
      const msg = cur ? t('debugLogOff') : t('debugLogOn');
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
