import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import type { AppInfo } from './apiClient';
import { ApiClient } from './apiClient';
import { downloadFile } from './netHttp';
import { DetailPanel } from './detailPanel';
import { getProxyUrl } from './config';
import { log, logErr } from './logger';
import type { SourceConfig } from './config';
import {
  getActiveSourceUrl,
  getInstallMode,
  getSources,
  setActiveSource,
  setSources,
} from './config';
import { t, uiLocale } from './i18n';
import { safePost } from './safePost';

interface WebviewMessage {
  id: number;
  type: string;
  payload?: Record<string, unknown>;
}

export class AppStoreHubPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'appStoreHub.main';
  /** 列表缓存 TTL：侧边栏切换视图再切回时避免重新请求软件源（对齐 VS Code 内置扩展视图保留状态）。
   *  30 分钟内切回直接命中缓存立即渲染；超过后仅后台重新拉取，不阻塞展示 */
  private static readonly LIST_CACHE_TTL = 30 * 60 * 1000;

  private view?: vscode.WebviewView;
  private client: ApiClient;
  /** 列表查询缓存：key=源+查询参数，value={时间戳, 原始 list, total} */
  private listCache = new Map<string, { t: number; list: AppInfo[]; total: number }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento
  ) {
    this.client = new ApiClient('');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    // retainContextWhenHidden 未在 1.77 的 WebviewOptions 类型中暴露（仅 WebviewPanelOptions），
    // 但运行时对 WebviewView 有效：切换视图（如切到资源管理器）后保留上下文，切回时保持软件源/搜索状态
    webviewView.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    } as vscode.WebviewOptions;
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.handleMessage(webviewView.webview, msg);
    });
  }

  /** 将扩展安装目录加入 webview 可访问资源根，使本地扩展图标可显示 */
  private addExtensionRoot(extDir: string): void {
    if (!this.view || !extDir) return;
    const root = vscode.Uri.file(path.dirname(extDir));
    const existing = (this.view.webview.options.localResourceRoots || []).map((u) => u.toString());
    if (existing.includes(root.toString())) return;
    this.view.webview.options = {
      ...this.view.webview.options,
      localResourceRoots: [...(this.view.webview.options.localResourceRoots || []), root],
    } as vscode.WebviewOptions;
  }

  refresh() {
    this.client = new ApiClient(this.getServerUrl());
    if (this.view) {
      safePost(this.view.webview, { type: 'refresh' });
    }
  }

  /** 按分类回到主面板（详情页分类点击时调用） */
  searchCategory(category: string) {
    if (this.view) {
      safePost(this.view.webview, { type: 'searchCategory', category });
      void vscode.commands.executeCommand('appStoreHub.main.focus');
    }
  }

  private getServerUrl(): string {
    return getActiveSourceUrl();
  }

  private async handleMessage(webview: vscode.Webview, msg: WebviewMessage): Promise<void> {
    const reply = (data: unknown, error?: string) => {
      console.log(
        `[panel] reply type=${msg.type} id=${msg.id} ok=${!error} error=${error ?? ''} data=${data === null ? 'null' : typeof data}`
      );
      safePost(webview, { id: msg.id, ok: !error, data, error });
    };
    const t0 = Date.now();
    // webview 调试日志上报：无请求 id，直接打印后返回，不回包
    if (msg.type === 'log') {
      log(`[webview] ${String((msg as { message?: string }).message ?? '')}`);
      return;
    }
    log(`[panel] msg type=${msg.type} id=${msg.id}`);
    try {
      this.client = new ApiClient(this.getServerUrl());
      log(`[panel] serverUrl=${this.getServerUrl()} proxy=${getProxyUrl() || '（未配置，将直连）'}`);
      switch (msg.type) {
        case 'ping':
          reply({ pong: true });
          break;
        case 'getSources':
          reply({ sources: getSources(), activeUrl: this.getServerUrl() });
          break;
        case 'setActiveSource': {
          const url = String((msg.payload as Record<string, unknown>)?.url ?? '');
          if (!url) {
            reply(null, t('sourceUrlEmpty'));
            break;
          }
          await setActiveSource(url);
          this.client = new ApiClient(getActiveSourceUrl());
          this.listCache.clear();
          reply({ activeUrl: this.getServerUrl() });
          break;
        }
        case 'setSources': {
          const list = (msg.payload as Record<string, unknown>)?.sources as
            SourceConfig[] | undefined;
          if (!Array.isArray(list)) {
            reply(null, t('sourceDataInvalid'));
            break;
          }
          await setSources(list);
          this.client = new ApiClient(getActiveSourceUrl());
          this.listCache.clear();
          reply({ sources: getSources(), activeUrl: this.getServerUrl() });
          break;
        }
        case 'getCategories':
          reply(await this.client.getCategories());
          break;
        case 'getApps': {
          const q = (msg.payload ?? {}) as Record<string, unknown>;
          const keyword = typeof q.keyword === 'string' ? q.keyword : undefined;
          const category = typeof q.category === 'string' ? q.category : undefined;
          const tag = typeof q.tag === 'string' ? q.tag : undefined;
          const sortBy = typeof q.sortBy === 'number' ? q.sortBy : undefined;
          const sortOrder = typeof q.sortOrder === 'number' ? q.sortOrder : undefined;
          const featured = !!q.featured;
          const page = typeof q.page === 'number' ? q.page : 1;
          const pageSize = typeof q.pageSize === 'number' ? q.pageSize : 30;
          // 列表缓存：侧边栏切换视图再切回时 webview 重建会重新 loadAll，
          // 命中缓存可立即返回（对齐 VS Code 内置扩展视图保留状态、不重新加载）
          const cacheKey = JSON.stringify({
            url: this.getServerUrl(),
            keyword,
            category,
            tag,
            sortBy,
            sortOrder,
            featured,
            page,
            pageSize,
          });
          const force = !!q.force;
          if (force) {
            this.listCache.delete(cacheKey);
          }
          const hit = this.listCache.get(cacheKey);
          if (hit && Date.now() - hit.t < AppStoreHubPanel.LIST_CACHE_TTL) {
            const list = hit.list.map((app) => this.withLocalInstallState({ ...app }));
            reply({ total: hit.total, page, pageSize, list });
            break;
          }
          const result = await this.client.queryExtensions({
            keyword,
            category,
            sortBy,
            sortOrder,
            featured,
            tag,
            page,
            pageSize,
          });
          this.listCache.set(cacheKey, { t: Date.now(), list: result.list, total: result.total });
          result.list = result.list.map((app) => this.withLocalInstallState({ ...app }));
          reply(result);
          break;
        }
        case 'getApp': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          const app = await this.client.getApp(id);
          reply(this.withLocalInstallState(app));
          break;
        }
        case 'openDetail': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (!id) {
            reply(null, t('appIdMissing'));
            break;
          }
          // 列表已加载的 app 数据（来自卡片点击），详情页直接使用，无需等待全量查询
          const initialApp = (msg.payload as Record<string, unknown>)?.app as AppInfo | undefined;
          reply({ opened: true });
          void DetailPanel.show(this.extensionUri, this.client, id, initialApp).catch((e) => {
            void vscode.window.showErrorMessage(
              t('openDetailFailed', e instanceof Error ? e.message : String(e))
            );
          });
          break;
        }
        case 'install':
          reply(await this.doInstall(msg.payload as { id: string; version?: string }));
          break;
        case 'selectVersion': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (!id) {
            reply(null, t('appIdMissing'));
            break;
          }
          await this.doSelectVersion(id);
          reply({ done: true });
          break;
        }
        case 'manageApp': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (!id) {
            reply(null, t('appIdMissing'));
            break;
          }
          const result = await this.doManageApp(id);
          reply(result);
          break;
        }
        case 'uninstall':
          reply(await this.doUninstall(msg.payload as { id: string }));
          break;
        case 'update':
          reply(await this.doUpdate(msg.payload as { id: string }));
          break;
        case 'downloadVsix': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          const path = await this.downloadVsix(id);
          reply({ path });
          break;
        }
        case 'getLocalExtensions':
          reply(this.listLocalExtensions());
          break;
        case 'getInstalled':
          reply(this.listInstalledExtensions());
          break;
        case 'toggleExtension': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (!id) {
            reply(null, t('appIdMissing'));
            break;
          }
          const action = await vscode.window.showQuickPick([t('disable'), t('enable')], {
            placeHolder: t('selectActionFor', id),
          });
          if (!action) {
            reply({ done: false });
            break;
          }
          const cmd =
            action === t('disable')
              ? 'workbench.extensions.disableExtension'
              : 'workbench.extensions.enableExtension';
          await vscode.commands.executeCommand(cmd, [id]);
          reply({ done: true, action });
          break;
        }
        case 'uninstallLocal': {
          const id = String((msg.payload as Record<string, unknown>)?.id ?? '');
          if (!id) {
            reply(null, t('appIdMissing'));
            break;
          }
          await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
          reply({ done: true });
          break;
        }
        case 'getViewState': {
          // 视图状态（搜索词/分页/筛选）存于扩展 globalState（Memento），
          // 侧边栏 WebviewView 切走再切回会重载脚本，据此恢复搜索词等状态；
          // 不写入 configuration：appStoreHub.viewState 未注册配置，cfg.update 会报
          // 「没有注册配置 appStoreHub.viewState」导致保存失败、状态丢失
          const vs = this.globalState.get<{
            keyword?: string;
            page?: number;
            viewType?: string;
            sort?: string;
            category?: string;
          }>('viewState', {});
          reply({
            keyword: vs?.keyword ?? '',
            page: vs?.page ?? 1,
            viewType: vs?.viewType ?? 'popular',
            sort: vs?.sort ?? 'relevance',
            category: vs?.category ?? '',
          });
          break;
        }
        case 'setViewState': {
          const payload = (msg.payload ?? {}) as Record<string, unknown>;
          const vs = this.globalState.get<{
            keyword?: string;
            page?: number;
            viewType?: string;
            sort?: string;
            category?: string;
          }>('viewState', {});
          if (typeof payload.keyword === 'string') {
            vs.keyword = payload.keyword;
          }
          if (typeof payload.page === 'number') {
            vs.page = payload.page;
          }
          if (typeof payload.viewType === 'string') {
            vs.viewType = payload.viewType;
          }
          if (typeof payload.sort === 'string') {
            vs.sort = payload.sort;
          }
          if (typeof payload.category === 'string') {
            vs.category = payload.category;
          }
          await this.globalState.update('viewState', vs);
          reply({ done: true });
          break;
        }
        default:
          reply(null, t('unknownMessage', msg.type));
      }
      log(`[panel] msg type=${msg.type} id=${msg.id} 处理完成（${Date.now() - t0}ms）`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      logErr(`[panel] exception type=${msg.type} id=${msg.id} err=${err}`);
      console.log(
        `[panel] exception type=${msg.type} id=${msg.id} err=${err}`
      );
      reply(null, err);
    }
  }

  private listLocalExtensions(): Array<{ id: string; version: string }> {
    return vscode.extensions.all
      .filter((ext) => ext.id.includes('.') && !ext.id.endsWith('.builtin'))
      .map((ext) => ({ id: ext.id, version: ext.packageJSON?.version ?? '' }));
  }

  /** 已安装扩展列表（含内置与禁用，供"已安装"视图展示） */
  private listInstalledExtensions(): Array<{
    id: string;
    name: string;
    publisher: string;
    version: string;
    builtin: boolean;
    description: string;
    enabled: boolean;
    icon: string;
  }> {
    const loaded = new Set(vscode.extensions.all.map((e) => e.id));
    const list = this.readDiskExtensions();
    // 磁盘扩展目录下读取的扩展，若不在已加载集合中则视为已禁用
    list.forEach((e) => {
      e.enabled = loaded.has(e.id);
    });
    return list;
  }

  /** 从磁盘扩展目录 extensions.json 读取全部已安装扩展（含禁用的），并补充 package.json 元数据 */
  private readDiskExtensions(): Array<{
    id: string;
    name: string;
    publisher: string;
    version: string;
    builtin: boolean;
    description: string;
    enabled: boolean;
    icon: string;
  }> {
    const out: Array<{
      id: string;
      name: string;
      publisher: string;
      version: string;
      builtin: boolean;
      description: string;
      enabled: boolean;
      icon: string;
    }> = [];
    const toIconUri = (extDir: string, iconRel: string): string => {
      if (!iconRel || !this.view) return '';
      try {
        this.addExtensionRoot(extDir);
        const p = vscode.Uri.file(path.join(extDir, iconRel));
        return this.view.webview.asWebviewUri(p).toString();
      } catch {
        return '';
      }
    };
    try {
      const sample = vscode.extensions.all.find(
        (e) => e.id.includes('.') && !e.id.endsWith('.builtin')
      );
      if (!sample) {
        // 无任何已加载扩展时无法推断目录，退化为仅列已加载
        return vscode.extensions.all
          .filter((e) => e.id.includes('.'))
          .map((e) => this.fromExtension(e, true));
      }
      const extRoot = path.dirname(sample.extensionPath);
      const manifest = path.join(extRoot, 'extensions.json');
      if (!fs.existsSync(manifest)) {
        return vscode.extensions.all
          .filter((e) => e.id.includes('.'))
          .map((e) => this.fromExtension(e, true));
      }
      const entries = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Array<{
        identifier?: { id?: string };
        version?: string;
        location?: { path?: string };
        metadata?: { isBuiltin?: boolean };
      }>;
      for (const entry of entries) {
        const id = entry.identifier?.id;
        if (!id || !id.includes('.')) {
          continue;
        }
        const idx = id.indexOf('.');
        const extDir = entry.location?.path || '';
        const pkgPath = extDir ? path.join(extDir, 'package.json') : '';
        let pkg: Record<string, unknown> = {};
        if (pkgPath && fs.existsSync(pkgPath)) {
          try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
          } catch {
            pkg = {};
          }
        }
        out.push({
          id,
          name: String(pkg.displayName || id),
          publisher: idx > 0 ? id.slice(0, idx) : '',
          version: String(pkg.version || entry.version || ''),
          builtin: !!entry.metadata?.isBuiltin || !!pkg.builtin,
          description: String(pkg.description || ''),
          enabled: true,
          icon: extDir ? toIconUri(extDir, String(pkg.icon || '')) : '',
        });
      }
    } catch {
      /* 磁盘读取失败时退化为仅列已加载 */
      return vscode.extensions.all
        .filter((e) => e.id.includes('.'))
        .map((e) => this.fromExtension(e, true));
    }
    return out;
  }

  private fromExtension(
    ext: vscode.Extension<unknown>,
    enabled: boolean
  ): {
    id: string;
    name: string;
    publisher: string;
    version: string;
    builtin: boolean;
    description: string;
    enabled: boolean;
    icon: string;
  } {
    const pkg = (ext.packageJSON || {}) as Record<string, unknown>;
    const idx = ext.id.indexOf('.');
    let icon = '';
    if (pkg.icon && this.view) {
      try {
        this.addExtensionRoot(ext.extensionPath);
        icon = this.view.webview
          .asWebviewUri(vscode.Uri.file(path.join(ext.extensionPath, String(pkg.icon))))
          .toString();
      } catch {
        icon = '';
      }
    }
    return {
      id: ext.id,
      name: String(pkg.displayName || ext.id),
      publisher: idx > 0 ? ext.id.slice(0, idx) : '',
      version: String(pkg.version ?? ''),
      builtin: !!pkg.builtin,
      description: String(pkg.description || ''),
      enabled,
      icon,
    };
  }

  private withLocalInstallState(app: AppInfo): AppInfo {
    const local = vscode.extensions.all.find((ext) => ext.id === `${app.publisher}.${app.name}`);
    if (local) {
      app.installed = true;
      app.installedVersion = String(local.packageJSON?.version ?? app.version);
      app.updatable = app.installedVersion !== app.version;
    }
    return app;
  }

  /**
   * 版本选择：mode=install 选择后直接安装指定版本；mode=download 选择后直接下载指定版本。
   */
  private async doSelectVersion(id: string, mode: 'install' | 'download' = 'install'): Promise<void> {
    const app = this.withLocalInstallState(await this.client.getApp(id));
    const versions = (app.versions || []).filter((v) => v.hasPackage);
    if (!versions.length) {
      vscode.window.showInformationMessage(t('noInstallableVersion', app.displayName));
      return;
    }
    const current = app.installedVersion || app.version;
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
      if (!sel) {
        return;
      }
      pick.hide();
      void (async () => {
        try {
          if (mode === 'download') {
            await this.downloadVersionToPath(app, sel.label);
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
            () => this.doInstall({ id, version: sel.label })
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

  /**
   * 管理菜单（仿 VS Code 小齿轮）：按状态提供 安装/更新/卸载、安装其他版本、下载其他版本。
   * 返回是否发生了会影响列表的操作（安装/更新/卸载），供前端刷新。
   */
  private async doManageApp(id: string): Promise<{ changed: boolean }> {
    const app = this.withLocalInstallState(await this.client.getApp(id));
    const versions = (app.versions || []).filter((v) => v.hasPackage);
    const items: vscode.QuickPickItem[] = [];
    if (versions.length) {
      items.push({ label: t('installOtherVersion'), description: t('installHistory', app.displayName) });
      items.push({ label: t('downloadOtherVersion'), description: t('downloadHistory', app.displayName) });
    }
    if (app.installed) {
      if (app.updatable) {
        items.push({ label: t('update'), description: `→ ${app.version}` });
      }
      items.push({ label: t('uninstall') });
    } else if (app.hasPackage) {
      items.push({ label: t('install'), description: `${app.version}` });
    }
    if (!items.length) {
      vscode.window.showInformationMessage(t('noManageAction', app.displayName));
      return { changed: false };
    }
    items.push({ label: t('copyExtId'), description: `${app.publisher}.${app.name}` });
    const sel = await vscode.window.showQuickPick(items, {
      placeHolder: t('managePlaceholder', app.displayName),
    });
    if (!sel) {
      return { changed: false };
    }
    if (sel.label === t('copyExtId')) {
      await vscode.env.clipboard.writeText(`${app.publisher}.${app.name}`);
      vscode.window.showInformationMessage(t('copiedExtId', `${app.publisher}.${app.name}`));
      return { changed: false };
    }
    if (sel.label === t('installOtherVersion')) {
      await this.doSelectVersion(id, 'install');
      return { changed: false };
    }
    if (sel.label === t('downloadOtherVersion')) {
      await this.doSelectVersion(id, 'download');
      return { changed: false };
    }
    if (sel.label === t('update')) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('updating', app.displayName),
        },
        () => this.doUpdate({ id })
      );
      return { changed: true };
    }
    if (sel.label === t('uninstall')) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('uninstalling', app.displayName),
        },
        () => this.doUninstall({ id })
      );
      return { changed: true };
    }
    if (sel.label === t('install')) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('installing', app.displayName),
        },
        () => this.doInstall({ id })
      );
      return { changed: true };
    }
    return { changed: false };
  }

  private async doInstall(payload: { id: string; version?: string }): Promise<AppInfo> {
    const mode = getInstallMode();
    let app: AppInfo;
    try {
      app = await this.client.install(payload.id, payload.version);
    } catch {
      // 纯 Gallery 源无安装记录端点，降级为仅本地安装
      app = await this.client.getApp(payload.id);
    }
    if (mode === 'auto' && app.hasPackage) {
      const vsix = await this.downloadVsix(payload.id, payload.version);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(vsix)
      );
      return this.withLocalInstallState(app);
    }
    return app;
  }

  private async doUninstall(payload: { id: string }): Promise<AppInfo> {
    const mode = getInstallMode();
    const app = await this.client.getApp(payload.id);
    if (mode === 'auto') {
      const extId = `${app.publisher}.${app.name}`;
      const installed = vscode.extensions.all.find((ext) => ext.id === extId);
      if (installed) {
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', extId);
      }
    }
    try {
      return await this.client.uninstall(payload.id);
    } catch {
      return app;
    }
  }

  private async doUpdate(payload: { id: string }): Promise<AppInfo> {
    const mode = getInstallMode();
    let app: AppInfo;
    try {
      app = await this.client.update(payload.id);
    } catch {
      app = await this.client.getApp(payload.id);
    }
    if (mode === 'auto' && app.hasPackage) {
      const vsix = await this.downloadVsix(payload.id, undefined);
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(vsix)
      );
      return this.withLocalInstallState(app);
    }
    return app;
  }

  /** 解析指定版本（缺省为最新版）的 VSIX 下载地址 */
  private async resolveVsixUrl(app: AppInfo, version?: string): Promise<string> {
    let url = app.vsixUrl || '';
    if (version) {
      url =
        (await this.client.getVsixUrl(app.publisher, app.name, version).catch(() => '')) || url;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      url = `${this.client.baseUrl}${url}`;
    }
    if (!url) {
      throw new Error(t('noVsixFound', app.displayName));
    }
    return url;
  }

  private async downloadVsix(appId: string, version?: string): Promise<string> {
    const app = await this.client.getApp(appId);
    const url = await this.resolveVsixUrl(app, version);
    const dir = path.join(os.tmpdir(), 'appstore-hub');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(
      dir,
      `${app.name}-${version ?? app.version}-${crypto.randomBytes(4).toString('hex')}.vsix`
    );
    await downloadFile(url, dest, undefined, getProxyUrl());
    return dest;
  }

  /** 选择保存位置并下载指定版本的 VSIX 包 */
  private async downloadVersionToPath(app: AppInfo, version: string): Promise<void> {
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
    const url = await this.resolveVsixUrl(app, version);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('downloading', app.displayName, version),
      },
      () => downloadFile(url, uri.fsPath, undefined, getProxyUrl())
    );
    vscode.window
      .showInformationMessage(t('downloaded', uri.fsPath), t('openContainingFolder'))
      .then((action) => {
        if (action === t('openContainingFolder')) {
          void vscode.commands.executeCommand('revealFileInOS', uri);
        }
      });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview', 'appStoreHub.js')
    );
    const i18nUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview', 'i18n.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview', 'appStoreHub.css')
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
<title>${locale === 'en' ? 'App Store Hub' : '插件中心'}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.__APPSTORE_LOCALE__ = '${locale}';</script>
<script nonce="${nonce}" src="${i18nUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
