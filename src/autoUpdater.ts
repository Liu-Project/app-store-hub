import * as vscode from 'vscode';
import type { AppInfo } from './apiClient';
import { createApiClient } from './apiClient';
import { downloadVsixToTmp } from './downloadVsix';
import { getInstallMode } from './config';
import { compareVersions } from './version';
import { log, logErr } from './logger';
import { t } from './i18n';

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

  private globalAutoUpdateEnabled(): boolean {
    return isGlobalAutoUpdateEnabled();
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
      const globalAuto = this.globalAutoUpdateEnabled();
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
        const setting = getAutoUpdateSetting(this.globalState, id);
        if (!shouldAutoUpdate(globalAuto, setting)) {
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
