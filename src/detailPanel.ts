import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ApiClient, AppInfo } from './apiClient';
import { downloadFile } from './netHttp';
import { getInstallMode, getProxyUrl } from './config';

interface DetailMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

export class DetailPanel {
  private static panels = new Map<
    string,
    { panel: vscode.WebviewPanel; client: ApiClient; extensionUri: vscode.Uri }
  >();

  static async show(
    extensionUri: vscode.Uri,
    client: ApiClient,
    appId: string,
    initialApp?: AppInfo
  ): Promise<void> {
    const existing = DetailPanel.panels.get(appId);
    if (existing) {
      existing.client = client;
      existing.panel.reveal();
      await DetailPanel.pushData(existing.panel, client, appId, initialApp);
      return;
    }
    // 对齐 VS Code 内置商城：列表点击时已加载扩展对象，直接用它立即打开详情，
    // 不再等待全量（含全部历史版本）查询
    const app = initialApp ?? (await client.getApp(appId));
    const panel = vscode.window.createWebviewPanel(
      'appStoreHub.detail',
      app.displayName || app.name,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );
    DetailPanel.panels.set(appId, { panel, client, extensionUri });
    panel.onDidDispose(() => {
      DetailPanel.panels.delete(appId);
    });
    panel.webview.html = DetailPanel.getHtml(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((msg: DetailMessage) => {
      void DetailPanel.handleMessage(panel, client, appId, msg);
    });
    await DetailPanel.pushData(panel, client, appId, initialApp);
  }

  private static async handleMessage(
    panel: vscode.WebviewPanel,
    client: ApiClient,
    appId: string,
    msg: DetailMessage
  ): Promise<void> {
    const post = (text: string, isError = false) => {
      void panel.webview.postMessage({ type: 'toast', text, isError });
    };
    try {
      switch (msg.type) {
        case 'getData':
          await DetailPanel.pushData(panel, client, appId);
          break;
        case 'install':
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `正在安装...`,
            },
            () => DetailPanel.doInstall(client, appId)
          );
          post('安装成功，请重新加载窗口生效');
          await DetailPanel.pushData(panel, client, appId);
          break;
        case 'update':
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '正在更新...' },
            () => DetailPanel.doUpdate(client, appId)
          );
          post('更新成功，请重新加载窗口生效');
          await DetailPanel.pushData(panel, client, appId);
          break;
        case 'uninstall':
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '正在卸载...' },
            () => DetailPanel.doUninstall(client, appId)
          );
          post('卸载成功');
          await DetailPanel.pushData(panel, client, appId);
          break;
        case 'selectVersion':
          await DetailPanel.selectVersion(client, panel, appId, undefined);
          break;
        case 'installVersion':
          await DetailPanel.selectVersion(client, panel, appId, 'install');
          break;
        case 'downloadVersion':
          await DetailPanel.selectVersion(client, panel, appId, 'download');
          break;
        case 'toggleAutoUpdate': {
          // 内置命令（源无关）：切换当前扩展的 Auto Update enablement（写入本地 storage）
          await vscode.commands.executeCommand(
            'workbench.extensions.action.toggleAutoUpdateForExtension',
            appId
          );
          await DetailPanel.pushData(panel, client, appId);
          break;
        }
        case 'openApp': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (id) {
            const entry = DetailPanel.panels.get(appId);
            const extUri = entry?.extensionUri ?? vscode.Uri.file('');
            void DetailPanel.show(extUri, client, id).catch(() => undefined);
          }
          break;
        }
        case 'openCategory': {
          const category = String((msg.payload as Record<string, unknown>)?.category ?? '');
          if (category) {
            await vscode.commands.executeCommand('appStoreHub.searchCategory', category);
          }
          break;
        }
        case 'getContent': {
          // 通过 ApiClient 获取文本内容（走代理/并发/重试），供 readme/changelog 等使用。
          // 失败必须回空内容：否则 webview 的 pendingContent 永不 resolve，Details 页 spinner 永远转
          const url = String((msg.payload as Record<string, unknown>)?.url ?? '');
          if (!url) {
            void panel.webview.postMessage({ type: 'content', url, text: '' });
            break;
          }
          let text = '';
          try {
            text = await client.getText(url);
          } catch {
            text = '';
          }
          void panel.webview.postMessage({ type: 'content', url, text });
          break;
        }
        case 'getImage': {
          // README/Changelog 中的外部截图：webview <img> 直连不走代理会失败，
          // 改为扩展主机下载并以 base64 data URI 回传
          const url = String((msg.payload as Record<string, unknown>)?.url ?? '');
          if (!url) {
            break;
          }
          const dataUrl = await client.getImageDataUrl(url);
          void panel.webview.postMessage({ type: 'image', url, dataUrl });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      post(e instanceof Error ? e.message : String(e), true);
    }
  }

  private static async doInstall(client: ApiClient, appId: string, version?: string): Promise<void> {
    const mode = getInstallMode();
    let app: AppInfo;
    try {
      app = await client.install(appId, version);
    } catch {
      app = await client.getApp(appId);
    }
    if (mode === 'auto' && app.hasPackage) {
      const vsix = await DetailPanel.downloadVsix(client, app, version);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(vsix)
      );
    }
  }

  private static async doUpdate(client: ApiClient, appId: string): Promise<void> {
    const mode = getInstallMode();
    let app: AppInfo;
    try {
      app = await client.update(appId);
    } catch {
      app = await client.getApp(appId);
    }
    if (mode === 'auto' && app.hasPackage) {
      const vsix = await DetailPanel.downloadVsix(client, app);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(vsix)
      );
    }
  }

  private static async doUninstall(client: ApiClient, appId: string): Promise<void> {
    const mode = getInstallMode();
    const app = await client.getApp(appId);
    if (mode === 'auto') {
      const extId = `${app.publisher}.${app.name}`;
      const installed = vscode.extensions.all.find((ext) => ext.id === extId);
      if (installed) {
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', extId);
      }
    }
    try {
      await client.uninstall(appId);
    } catch {
      /* 纯 Gallery 源无卸载记录端点 */
    }
  }

  /** 版本选择：mode 为空先选操作（安装/下载），否则直接按 mode 执行 */
  private static async selectVersion(
    client: ApiClient,
    panel: vscode.WebviewPanel,
    appId: string,
    mode: 'install' | 'download' | undefined
  ): Promise<void> {
    const app = await client.getApp(appId);
    const versions = (app.versions || []).filter((v) => v.hasPackage);
    if (!versions.length) {
      void panel.webview.postMessage({
        type: 'toast',
        text: `[${app.displayName}] 暂无可安装的版本包`,
        isError: true,
      });
      return;
    }
    if (!mode) {
      const op = await vscode.window.showQuickPick(
        [
          { label: '安装其他版本', description: `安装 ${app.displayName} 的历史版本` },
          { label: '下载其他版本', description: `下载 ${app.displayName} 的历史版本 .vsix` },
        ],
        { placeHolder: `选择操作：${app.displayName}` }
      );
      if (!op) return;
      mode = op.label === '下载其他版本' ? 'download' : 'install';
    }
    const local = vscode.extensions.all.find((ext) => ext.id === `${app.publisher}.${app.name}`);
    const current = local ? String(local.packageJSON?.version ?? '') : app.version;
    const pick = vscode.window.createQuickPick();
    pick.title =
      mode === 'download'
        ? `选择要下载的版本：${app.displayName}`
        : `选择要安装的版本：${app.displayName}`;
    pick.placeholder = mode === 'download' ? '选择一个版本下载 .vsix' : '选择一个版本安装';
    pick.items = versions.map((v) => ({
      label: v.version,
      description: v.version === current ? '当前版本' : '',
      detail: v.date ? `发布于 ${v.date}` : '',
    }));
    pick.onDidChangeSelection((items) => {
      const sel = items[0];
      if (!sel) return;
      pick.hide();
      void (async () => {
        try {
          if (mode === 'download') {
            await DetailPanel.downloadVersionToPath(client, app, sel.label);
            return;
          }
          if (sel.label === current) {
            vscode.window.showInformationMessage(
              `[${app.displayName}] 版本 ${sel.label} 已安装，无需重复安装`
            );
            return;
          }
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `正在安装 ${app.displayName} ${sel.label}...`,
            },
            () => DetailPanel.doInstall(client, appId, sel.label)
          );
          vscode.window
            .showInformationMessage(
              `[${app.displayName}] ${sel.label} 安装成功，请重新加载窗口生效`,
              '重新加载'
            )
            .then((action) => {
              if (action === '重新加载') {
                void vscode.commands.executeCommand('workbench.action.reloadWindow');
              }
            });
        } catch (e) {
          vscode.window.showErrorMessage(
            `[${app.displayName}] ${mode === 'download' ? '下载' : '安装'}版本 ${sel.label} 失败：${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }
      })();
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  }

  private static async downloadVsix(
    client: ApiClient,
    app: AppInfo,
    version?: string
  ): Promise<string> {
    let url = app.vsixUrl || '';
    if (version) {
      url =
        (await client.getVsixUrl(app.publisher, app.name, version).catch(() => '')) || url;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      url = `${client.baseUrl}${url}`;
    }
    if (!url) {
      throw new Error(`[${app.displayName}] 未找到可下载的 VSIX 包`);
    }
    const dir = path.join(os.tmpdir(), 'appstore-hub');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(
      dir,
      `${app.name}-${version ?? app.version}-${crypto.randomBytes(4).toString('hex')}.vsix`
    );
    await downloadFile(url, dest, undefined, getProxyUrl());
    return dest;
  }

  private static async downloadVersionToPath(
    client: ApiClient,
    app: AppInfo,
    version: string
  ): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(os.homedir(), 'Downloads', `${app.name}-${version}.vsix`)
      ),
      filters: { 'VSIX 包': ['vsix'] },
      saveLabel: '下载',
    });
    if (!uri) {
      return;
    }
    let url = app.vsixUrl || '';
    url =
      (await client.getVsixUrl(app.publisher, app.name, version).catch(() => '')) || url;
    if (url && !/^https?:\/\//i.test(url)) {
      url = `${client.baseUrl}${url}`;
    }
    if (!url) {
      throw new Error(`[${app.displayName}] 未找到可下载的 VSIX 包`);
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在下载 ${app.displayName} ${version}...`,
      },
      () => downloadFile(url, uri.fsPath, undefined, getProxyUrl())
    );
    vscode.window
      .showInformationMessage(`已下载：${uri.fsPath}`, '打开所在目录')
      .then((action) => {
        if (action === '打开所在目录') {
          void vscode.commands.executeCommand('revealFileInOS', uri);
        }
      });
  }

  private static async pushData(
    panel: vscode.WebviewPanel,
    client: ApiClient,
    appId: string,
    initialApp?: AppInfo
  ): Promise<void> {
    // 优先使用列表已加载数据（对齐 VS Code：点击卡片即开详情）；无则全量查询
    const app = initialApp ?? (await client.getApp(appId));
    const local = vscode.extensions.all.find((ext) => ext.id === `${app.publisher}.${app.name}`);
    const curVersion = local ? String(local.packageJSON?.version ?? '') : '';
    const toAbsolute = (u: string): string =>
      /^https?:\/\//i.test(u) ? u : `${client.baseUrl}${u}`;
    // Auto Update 状态：与 VS Code 内置一致——读取 extensions.autoUpdate 配置（on/off）作为近似；
    // 切换通过内置命令 toggleAutoUpdateForExtension 写入内部 storage
    const autoUpdateConfig = vscode.workspace
      .getConfiguration('extensions')
      .get<string>('autoUpdate', 'on');
    // 先发简单信息立即渲染（对齐 VS Code：列表点击即展示主体），manifest 异步到后再补功能/依赖 tab
    const data = {
      app: {
        ...app,
        icon: app.icon ? toAbsolute(app.icon) : '',
        readmeUrl: app.readmeUrl
          ? toAbsolute(app.readmeUrl)
          : `${client.baseUrl}/api/apps/${encodeURIComponent(appId)}/readme`,
        changelogUrl: app.changelogUrl
          ? toAbsolute(app.changelogUrl)
          : `${client.baseUrl}/api/apps/${encodeURIComponent(appId)}/changelog`,
        installed: !!local,
        installedVersion: curVersion,
        autoUpdate: autoUpdateConfig === 'on',
      },
      curVersion,
      manifest: null,
    };
    void panel.webview.postMessage({ type: 'data', ...data });
    if (app.manifestUrl) {
      const manifest = await client
        .getJson<Record<string, unknown>>(toAbsolute(app.manifestUrl))
        .catch(() => null);
      const resources = DetailPanel.resolveResources(app, manifest, client.baseUrl);
      void panel.webview.postMessage({ type: 'manifest', manifest, resources });
    }
  }

  /** 从 manifest 补充扩展资源（仓库/Issues/商店页）：Gallery 响应对多数源不携带这些字段 */
  private static resolveResources(
    app: AppInfo,
    manifest: Record<string, unknown> | null,
    baseUrl: string
  ): { repository: string; issues: string; moreInfoUrl: string; moreInfoLabel: string } {
    const m = (manifest || {}) as {
      repository?: string | { url?: string };
      bugs?: string | { url?: string };
      homepage?: string;
    };
    const repository =
      app.repository || (typeof m.repository === 'string' ? m.repository : m.repository?.url) || '';
    const issues =
      app.issues || (typeof m.bugs === 'string' ? m.bugs : m.bugs?.url) || '';
    const moreInfoUrl =
      app.moreInfoUrl ||
      DetailPanel.marketplaceItemUrl(baseUrl, app.publisher, app.name) ||
      (typeof m.homepage === 'string' ? m.homepage : '');
    return {
      repository,
      issues,
      moreInfoUrl,
      moreInfoLabel: DetailPanel.marketplaceLabel(baseUrl),
    };
  }

  /** 根据软件源生成商店详情页 URL（微软市场 / Open VSX） */
  private static marketplaceItemUrl(baseUrl: string, publisher: string, name: string): string {
    try {
      const host = new URL(baseUrl).hostname;
      if (host.endsWith('marketplace.visualstudio.com')) {
        return `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(publisher)}.${encodeURIComponent(name)}`;
      }
      if (host.endsWith('open-vsx.org')) {
        return `https://open-vsx.org/extension/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`;
      }
    } catch {
      /* 忽略 */
    }
    return '';
  }

  /** 根据软件源生成商店资源条目名称（对齐 VS Code 扩展资源区的 More Info） */
  private static marketplaceLabel(baseUrl: string): string {
    try {
      const host = new URL(baseUrl).hostname;
      if (host.endsWith('marketplace.visualstudio.com')) {
        return 'Microsoft 市场';
      }
      if (host.endsWith('open-vsx.org')) {
        return 'Open VSX 市场';
      }
    } catch {
      /* 忽略 */
    }
    return '应用商店';
  }

  private static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'detail.js')
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', 'marked.min.js')
    );
    const gfmHeadingIdUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', 'gfmHeadingId.js')
    );
    const purifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'vendor', 'purify.min.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'detail.css')
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: http: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http: https:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>应用详情</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${markedUri}"></script>
<script nonce="${nonce}" src="${gfmHeadingIdUri}"></script>
<script nonce="${nonce}" src="${purifyUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
