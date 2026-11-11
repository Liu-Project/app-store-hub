import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ApiClient, AppInfo } from './apiClient';
import { downloadVsixToTmp, resolveVsixUrl } from './downloadVsix';
import { downloadFile } from './netHttp';
import { getInstallMode } from './config';
import { getEffectiveAutoUpdate, setEffectiveAutoUpdate } from './autoUpdater';
import { compareVersions } from './version';
import { t, uiLocale } from './i18n';
import { safePost } from './safePost';

interface DetailMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

export class DetailPanel {
  /** 详情页打开期间轮询 VS Code 内置扩展商店 Auto Update 状态的间隔（毫秒），实现内置商店变更实时同步 */
  private static readonly AUTO_UPDATE_SYNC_INTERVAL_MS = 3000;

  private static panels = new Map<
    string,
    {
      panel: vscode.WebviewPanel;
      client: ApiClient;
      extensionUri: vscode.Uri;
      globalState: vscode.Memento;
      syncTimer?: NodeJS.Timeout;
    }
  >();

  static async show(
    extensionUri: vscode.Uri,
    client: ApiClient,
    appId: string,
    initialApp?: AppInfo,
    globalState?: vscode.Memento
  ): Promise<void> {
    const existing = DetailPanel.panels.get(appId);
    if (existing) {
      existing.client = client;
      if (globalState) {
        existing.globalState = globalState;
      }
      existing.panel.reveal();
      await DetailPanel.pushData(existing.panel, client, appId, initialApp, existing.globalState);
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
    const state = globalState ?? ({} as vscode.Memento);
    DetailPanel.panels.set(appId, { panel, client, extensionUri, globalState: state });
    panel.onDidDispose(() => {
      const entry = DetailPanel.panels.get(appId);
      if (entry?.syncTimer) {
        clearInterval(entry.syncTimer);
      }
      DetailPanel.panels.delete(appId);
    });
    panel.webview.html = DetailPanel.getHtml(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((msg: DetailMessage) => {
      void DetailPanel.handleMessage(panel, client, appId, msg);
    });
    await DetailPanel.pushData(panel, client, appId, initialApp, state);
    DetailPanel.startAutoUpdateSync(appId);
  }

  /**
   * 详情页打开期间轮询 VS Code 内置扩展商店的 Auto Update 状态：
   * 用户在 VS Code 内置「扩展:商店」切换 Auto Update 后，此处检测到变化并实时推送前端，
   * 实现「内置商店 → 插件中心」方向的同步（另一方向由 setEffectiveAutoUpdate 写同一存储完成）。
   */
  private static startAutoUpdateSync(appId: string): void {
    const entry = DetailPanel.panels.get(appId);
    if (!entry || entry.syncTimer) {
      return;
    }
    let last = getEffectiveAutoUpdate(entry.globalState, appId);
    entry.syncTimer = setInterval(() => {
      const cur = DetailPanel.panels.get(appId);
      if (!cur) {
        return;
      }
      const value = getEffectiveAutoUpdate(cur.globalState, appId);
      if (value !== last) {
        last = value;
        safePost(cur.panel.webview, { type: 'autoUpdate', value });
      }
    }, DetailPanel.AUTO_UPDATE_SYNC_INTERVAL_MS);
  }

  private static async handleMessage(
    panel: vscode.WebviewPanel,
    client: ApiClient,
    appId: string,
    msg: DetailMessage
  ): Promise<void> {
    const post = (text: string, isError = false) => {
      safePost(panel.webview, { type: 'toast', text, isError });
    };
    const gs = DetailPanel.panels.get(appId)?.globalState ?? ({} as vscode.Memento);
    try {
      switch (msg.type) {
        case 'getData':
          await DetailPanel.pushData(panel, client, appId, undefined, gs);
          break;
        case 'install':
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: t('installingGeneric'),
            },
            () => DetailPanel.doInstall(client, appId)
          );
          post(t('installSuccessGeneric'));
          await DetailPanel.pushData(panel, client, appId, undefined, gs);
          break;
        case 'update':
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('updatingGeneric') },
            () => DetailPanel.doUpdate(client, appId)
          );
          post(t('updateSuccessGeneric'));
          await DetailPanel.pushData(panel, client, appId, undefined, gs);
          break;
        case 'uninstall':
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('uninstallingGeneric') },
            () => DetailPanel.doUninstall(client, appId)
          );
          post(t('uninstallSuccessGeneric'));
          await DetailPanel.pushData(panel, client, appId, undefined, gs);
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
          // 对齐 VS Code 内置 ToggleAutoUpdateForExtensionAction：on ↔ off 两态切换，
          // 写入 VS Code 内置扩展商店存储（extensions.autoUpdate / extensions.donotAutoUpdate），
          // 与 VS Code 内置「扩展:商店」的 Auto Update 双向同步
          const current = getEffectiveAutoUpdate(gs, appId);
          await setEffectiveAutoUpdate(gs, appId, !current);
          // 运行中的 VS Code 主进程在内存缓存 state.vscdb，内置商店 UI 需完全退出重启后才刷新
          post(t('autoUpdateSyncRestart'));
          await DetailPanel.pushData(panel, client, appId, undefined, gs);
          break;
        }
        case 'openApp': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (id) {
            const entry = DetailPanel.panels.get(appId);
            const extUri = entry?.extensionUri ?? vscode.Uri.file('');
            const entryGs = entry?.globalState;
            void DetailPanel.show(extUri, client, id, undefined, entryGs).catch(() => undefined);
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
            safePost(panel.webview, { type: 'content', url, text: '' });
            break;
          }
          let text = '';
          try {
            text = await client.getText(url);
          } catch {
            text = '';
          }
          safePost(panel.webview, { type: 'content', url, text });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      post(e instanceof Error ? e.message : String(e), true);
    }
  }

  private static async doInstall(
    client: ApiClient,
    appId: string,
    version?: string
  ): Promise<void> {
    const mode = getInstallMode();
    let app: AppInfo;
    try {
      app = await client.install(appId, version);
    } catch {
      app = await client.getApp(appId);
    }
    if (mode === 'auto' && app.hasPackage) {
      const vsix = await downloadVsixToTmp(client, app, version);
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
      const vsix = await downloadVsixToTmp(client, app);
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
      const installed = vscode.extensions.all.find(
        (ext) => ext.id.toLowerCase() === extId.toLowerCase()
      );
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
      safePost(panel.webview, {
        type: 'toast',
        text: t('noInstallableVersion', app.displayName),
        isError: true,
      });
      return;
    }
    if (!mode) {
      const op = await vscode.window.showQuickPick(
        [
          { label: t('installOtherVersion'), description: t('installHistory', app.displayName) },
          { label: t('downloadOtherVersion'), description: t('downloadHistory', app.displayName) },
        ],
        { placeHolder: t('selectOperation', app.displayName) }
      );
      if (!op) return;
      mode = op.label === t('downloadOtherVersion') ? 'download' : 'install';
    }
    // 扩展 ID 匹配大小写不敏感（对齐 VS Code ExtensionIdentifier）
    const local = vscode.extensions.all.find(
      (ext) => ext.id.toLowerCase() === `${app.publisher}.${app.name}`.toLowerCase()
    );
    const current = local ? String(local.packageJSON?.version ?? '') : app.version;
    const pick = vscode.window.createQuickPick();
    pick.title =
      mode === 'download'
        ? t('titleDownloadVersion', app.displayName)
        : t('titleInstallVersion', app.displayName);
    pick.placeholder =
      mode === 'download' ? t('placeholderDownloadVersion') : t('placeholderInstallVersion');
    pick.items = versions.map((v) => ({
      label: v.version,
      description: v.version === current ? t('currentVersion') : '',
      detail: v.date ? t('releasedOn', v.date) : '',
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
              t('versionAlreadyInstalled', app.displayName, sel.label)
            );
            return;
          }
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: t('installingVersion', app.displayName, sel.label),
            },
            () => DetailPanel.doInstall(client, appId, sel.label)
          );
          vscode.window
            .showInformationMessage(
              t('installSuccessReload', app.displayName, sel.label),
              t('reload')
            )
            .then((action) => {
              if (action === t('reload')) {
                void vscode.commands.executeCommand('workbench.action.reloadWindow');
              }
            });
        } catch (e) {
          vscode.window.showErrorMessage(
            t(
              'versionOpFailed',
              app.displayName,
              mode === 'download' ? t('download') : t('install'),
              sel.label,
              e instanceof Error ? e.message : String(e)
            )
          );
        }
      })();
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
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
      filters: { [t('vsixFilter')]: ['vsix'] },
      saveLabel: t('download'),
    });
    if (!uri) {
      return;
    }
    const url = await resolveVsixUrl(client, app, version);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('downloading', app.displayName, version),
      },
      () => downloadFile(url, uri.fsPath)
    );
    vscode.window
      .showInformationMessage(t('downloaded', uri.fsPath), t('openContainingFolder'))
      .then((action) => {
        if (action === t('openContainingFolder')) {
          void vscode.commands.executeCommand('revealFileInOS', uri);
        }
      });
  }

  private static async pushData(
    panel: vscode.WebviewPanel,
    client: ApiClient,
    appId: string,
    initialApp?: AppInfo,
    globalState?: vscode.Memento
  ): Promise<void> {
    // 优先使用列表已加载数据（对齐 VS Code：点击卡片即开详情）；无则全量查询
    const app = initialApp ?? (await client.getApp(appId));
    // 扩展 ID 匹配大小写不敏感（对齐 VS Code ExtensionIdentifier：ext.id 归一化为小写，
    // Gallery publisherName 保留原始大小写，直接 === 会导致已安装状态/版本匹配失败）
    const local = vscode.extensions.all.find(
      (ext) => ext.id.toLowerCase() === `${app.publisher}.${app.name}`.toLowerCase()
    );
    const curVersion = local ? String(local.packageJSON?.version ?? '') : '';
    const toAbsolute = (u: string): string =>
      /^https?:\/\//i.test(u) ? u : `${client.baseUrl}${u}`;
    // Auto Update 状态（与 VS Code 内置扩展商店双向同步）：优先读取内置存储
    // state.vscdb（extensions.autoUpdate / extensions.donotAutoUpdate），SQLite 不可用时
    // 降级本地 globalState 并惰性迁移，保证两边状态一致。
    const autoUpdate = globalState ? getEffectiveAutoUpdate(globalState, appId) : true;
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
        // 可更新判定：语义化版本比较，源版本严格高于本地版本才算有更新
        updatable: !!local && curVersion !== '' && compareVersions(app.version, curVersion) > 0,
        autoUpdate,
      },
      curVersion,
      manifest: null,
    };
    safePost(panel.webview, { type: 'data', ...data });
    if (app.manifestUrl) {
      const manifest = await client
        .getJson<Record<string, unknown>>(toAbsolute(app.manifestUrl))
        .catch(() => null);
      const resources = DetailPanel.resolveResources(app, manifest, client.baseUrl);
      safePost(panel.webview, { type: 'manifest', manifest, resources });
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
    const issues = app.issues || (typeof m.bugs === 'string' ? m.bugs : m.bugs?.url) || '';
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
        return t('marketplaceMicrosoft');
      }
      if (host.endsWith('open-vsx.org')) {
        return t('marketplaceOpenVsx');
      }
    } catch {
      /* 忽略 */
    }
    return t('marketplaceOther');
  }

  private static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'webview', 'detail.js')
    );
    const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview', 'i18n.js'));
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
    const locale = uiLocale();
    return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: http: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http: https:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>${locale === 'en' ? 'Extension Details' : '应用详情'}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.__APPSTORE_LOCALE__ = '${locale}';</script>
<script nonce="${nonce}" src="${i18nUri}"></script>
<script nonce="${nonce}" src="${markedUri}"></script>
<script nonce="${nonce}" src="${gfmHeadingIdUri}"></script>
<script nonce="${nonce}" src="${purifyUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
