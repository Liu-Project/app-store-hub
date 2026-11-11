import * as vscode from 'vscode';
import type { AppInfo } from './apiClient';
import { createApiClient } from './apiClient';
import { downloadVsixToTmp } from './downloadVsix';
import { getInstallMode } from './config';
import { compareVersions } from './version';
import { log, logErr } from './logger';
import { t } from './i18n';
import { getVscodeAutoUpdate, setVscodeAutoUpdate } from './vscodeAutoUpdateSync';
import { isGlobalAutoUpdateEnabled } from './autoUpdateConfig';

export { isGlobalAutoUpdateEnabled } from './autoUpdateConfig';

export const AUTO_UPDATE_PREFIX = 'autoUpdate:';
/** 已自动安装待重启的版本标记（避免重启前每轮重复下载安装） */
const INSTALLED_PREFIX = 'autoUpdater.installed:';

/**
 * 读取单个扩展的自动更新 enablement（对齐 VS Code getExtensionAutoUpdateSetting）：
 * 返回 undefined 表示未单独设置，跟随全局 extensions.autoUpdate。
 */
export function getAutoUpdateSetting(
  globalState: vscode.Memento,
  extId: string
): 'on' | 'off' | undefined {
  const v = globalState.get<string>(`${AUTO_UPDATE_PREFIX}${extId}`);
  return v === 'on' || v === 'off' ? v : undefined;
}

/** 写入单个扩展的自动更新 enablement（传 undefined 恢复为跟随全局） */
export function setAutoUpdateSetting(
  globalState: vscode.Memento,
  extId: string,
  value: 'on' | 'off' | undefined
): Thenable<void> {
  if (value === undefined) {
    return globalState.update(`${AUTO_UPDATE_PREFIX}${extId}`, undefined);
  }
  return globalState.update(`${AUTO_UPDATE_PREFIX}${extId}`, value);
}

/** 读取「已自动安装、等待重启生效」的目标版本标记 */
export function getInstalledUpdate(globalState: vscode.Memento, extId: string): string | undefined {
  return globalState.get<string>(`${INSTALLED_PREFIX}${extId}`);
}

/** 设置/清除「已自动安装、等待重启生效」的标记 */
export function setInstalledUpdate(
  globalState: vscode.Memento,
  extId: string,
  version: string | undefined
): Thenable<void> {
  return globalState.update(`${INSTALLED_PREFIX}${extId}`, version);
}

/**
 * 自动更新决策（对齐 VS Code 原生机制）：
 * - 单扩展显式 off：永不自动更新；
 * - 其余情况：全局 autoUpdate 开启，或该扩展显式 on。
 */
export function shouldAutoUpdate(globalAuto: boolean, setting: 'on' | 'off' | undefined): boolean {
  if (setting === 'off') {
    return false;
  }
  return globalAuto || setting === 'on';
}

/**
 * 单扩展自动更新的有效状态（与 VS Code 内置「扩展:商店」双向同步）：
 * 优先读取 VS Code 内置扩展中心存储（state.vscdb 的 extensions.autoUpdate /
 * extensions.donotAutoUpdate），与内置商店状态完全一致；SQLite 不可用时降级为本地
 * globalState。读取到旧版本 globalState 数据（内置存储无记录）时惰性迁移到内置存储
 * 并清除本地记录，之后两边共用同一数据源。
 */
export function getEffectiveAutoUpdate(globalState: vscode.Memento, extId: string): boolean {
  try {
    const id = extId.toLowerCase();
    const st = getVscodeAutoUpdate(id);
    if (st.available) {
      if (st.hasRecord) {
        return st.value;
      }
      // 内置存储无记录：若本地有旧版本设置，惰性迁移到内置存储并清除，保持两边一致
      const setting = getAutoUpdateSetting(globalState, id);
      if (setting) {
        const ok = setVscodeAutoUpdate(id, setting === 'on');
        if (ok) {
          void Promise.resolve(setAutoUpdateSetting(globalState, id, undefined)).catch(
            () => undefined
          );
        }
        return setting === 'on';
      }
      return st.value;
    }
    // SQLite 不可用：降级本地 globalState
    const setting = getAutoUpdateSetting(globalState, id);
    return setting === 'on' || (setting !== 'off' && isGlobalAutoUpdateEnabled());
  } catch {
    return isGlobalAutoUpdateEnabled();
  }
}

/** 设置单扩展自动更新：写 VS Code 内置扩展中心存储（双向同步）。
 *  内置存储写入成功后清除本地缓存（内置存储为唯一权威，避免旧缓存被误迁移覆盖内置商店状态）；
 *  内置存储不可用时降级写入本地缓存，保证本次会话功能可用。 */
export async function setEffectiveAutoUpdate(
  globalState: vscode.Memento,
  extId: string,
  enable: boolean
): Promise<void> {
  const id = extId.toLowerCase();
  const ok = setVscodeAutoUpdate(id, enable);
  if (ok) {
    await setAutoUpdateSetting(globalState, id, undefined);
  } else {
    await setAutoUpdateSetting(globalState, id, enable ? 'on' : 'off');
  }
}

/**
 * 后台自动更新（对齐 VS Code 内置扩展中心 AutoUpdater）：
 * - 启动后延迟首次检查，之后每 5 分钟检查一次；
 * - 全局开关：extensions.autoCheckUpdates（是否检查）与 extensions.autoUpdate（是否自动安装）；
 * - 单扩展开关：globalState 中的 autoUpdate:<extId>（on/off，undefined 跟随全局）；
 * - 仅更新「源版本严格高于本地版本」的扩展；installMode=manual 时只检测不安装。
 */
export class AutoUpdater {
  static readonly CHECK_INTERVAL_MS = 5 * 60 * 1000;
  static readonly FIRST_CHECK_DELAY_MS = 30 * 1000;

  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(private readonly globalState: vscode.Memento) {}

  start(context: vscode.ExtensionContext): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.checkForUpdates(), AutoUpdater.CHECK_INTERVAL_MS);
    context.subscriptions.push({
      dispose: () => {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    });
    setTimeout(() => void this.checkForUpdates(), AutoUpdater.FIRST_CHECK_DELAY_MS);
  }

  private globalAutoCheckEnabled(): boolean {
    try {
      return vscode.workspace.getConfiguration('extensions').get<boolean>('autoCheckUpdates', true);
    } catch {
      return true;
    }
  }

  async checkForUpdates(): Promise<void> {
    if (this.checking) {
      return;
    }
    this.checking = true;
    const t0 = Date.now();
    try {
      if (!this.globalAutoCheckEnabled()) {
        log('[autoUpdater] extensions.autoCheckUpdates=off，跳过后台更新检查');
        return;
      }
      const mode = getInstallMode();
      const client = createApiClient();
      const extensions = vscode.extensions.all.filter(
        (e) => e.id.includes('.') && !e.id.endsWith('.builtin')
      );
      if (!extensions.length) {
        return;
      }
      const toUpdate: AppInfo[] = [];
      for (const ext of extensions) {
        const id = ext.id;
        // 与 VS Code 内置扩展商店同源决策（含旧数据惰性迁移），SQLite 不可用时降级本地存储
        if (!getEffectiveAutoUpdate(this.globalState, id)) {
          continue;
        }
        const localVersion = String(ext.packageJSON?.version ?? '');
        if (!localVersion) {
          continue;
        }
        try {
          const app = await client.getApp(id);
          if (!app.version || !app.hasPackage) {
            continue;
          }
          const cmp = compareVersions(app.version, localVersion);
          if (cmp <= 0) {
            // 本地已是最新/更高：清除可能残留的「待重启」标记
            if (getInstalledUpdate(this.globalState, id) !== undefined) {
              await setInstalledUpdate(this.globalState, id, undefined);
            }
            continue;
          }
          // 已自动安装过该目标版本、等待重启生效：本轮跳过，避免重复下载安装
          if (getInstalledUpdate(this.globalState, id) === app.version) {
            log(`[autoUpdater] ${id} 已自动更新至 ${app.version}，等待重启生效，跳过`);
            continue;
          }
          log(`[autoUpdater] 检测到更新：${id} ${localVersion} → ${app.version}`);
          toUpdate.push(app);
        } catch (e) {
          logErr(
            `[autoUpdater] 检查 ${id} 更新失败：${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      if (!toUpdate.length) {
        log(`[autoUpdater] 本次检查无更新（${Date.now() - t0}ms）`);
        return;
      }
      if (mode !== 'auto') {
        log(`[autoUpdater] 检测到 ${toUpdate.length} 个更新，但 installMode=manual，跳过自动安装`);
        return;
      }
      let installed = 0;
      for (const app of toUpdate) {
        try {
          const vsix = await downloadVsixToTmp(client, app);
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(vsix)
          );
          // 记录「已自动安装、等待重启生效」，防止重启前下一轮检查重复下载安装
          await setInstalledUpdate(this.globalState, app.id, app.version);
          installed += 1;
        } catch (e) {
          logErr(
            `[autoUpdater] 安装 ${app.id} 更新失败：${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      if (installed > 0) {
        log(
          `[autoUpdater] 已自动更新 ${installed}/${toUpdate.length} 个扩展（${Date.now() - t0}ms）`
        );
        const action = await vscode.window.showInformationMessage(
          t('autoUpdatedCount', installed),
          t('reload')
        );
        if (action === t('reload')) {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    } catch (e) {
      logErr(`[autoUpdater] 后台更新检查异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.checking = false;
    }
  }
}
