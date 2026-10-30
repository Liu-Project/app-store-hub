import * as vscode from 'vscode';
import { getLanguage, type Language } from './config';

type Dict = Record<string, string>;

const zh: Dict = {
  sourceUrlEmpty: '软件源地址不能为空',
  sourceDataInvalid: '软件源数据格式错误',
  appIdMissing: '缺少应用 id',
  openDetailFailed: '打开应用详情失败：{0}',
  unknownMessage: '未知消息类型：{0}',
  enable: '启用',
  disable: '禁用',
  selectActionFor: '{0}：选择操作',
  noInstallableVersion: '[{0}] 暂无可安装的版本包',
  titleDownloadVersion: '选择要下载的版本：{0}',
  titleInstallVersion: '选择要安装的版本：{0}',
  placeholderDownloadVersion: '选择一个版本下载 .vsix',
  placeholderInstallVersion: '选择一个版本安装',
  currentVersion: '当前版本',
  releasedOn: '发布于 {0}',
  versionAlreadyInstalled: '[{0}] 版本 {1} 已安装，无需重复安装',
  installingVersion: '正在安装 {0} {1}...',
  installSuccessReload: '[{0}] {1} 安装成功，请重新加载窗口生效',
  reload: '重新加载',
  versionOpFailed: '[{0}] {1}版本 {2} 失败：{3}',
  installOtherVersion: '安装其他版本',
  downloadOtherVersion: '下载其他版本',
  update: '更新',
  uninstall: '卸载',
  install: '安装',
  noManageAction: '[{0}] 无可执行的管理操作',
  copyExtId: '复制扩展 ID',
  managePlaceholder: '管理：{0}',
  copiedExtId: '已复制扩展 ID：{0}',
  updating: '正在更新 {0}...',
  uninstalling: '正在卸载 {0}...',
  installing: '正在安装 {0}...',
  noVsixFound: '[{0}] 未找到可下载的 VSIX 包',
  vsixFilter: 'VSIX 包',
  download: '下载',
  downloading: '正在下载 {0} {1}...',
  downloaded: '已下载：{0}',
  openContainingFolder: '打开所在目录',
  installingGeneric: '正在安装...',
  updatingGeneric: '正在更新...',
  uninstallingGeneric: '正在卸载...',
  installSuccessGeneric: '安装成功，请重新加载窗口生效',
  updateSuccessGeneric: '更新成功，请重新加载窗口生效',
  uninstallSuccessGeneric: '卸载成功',
  installHistory: '安装 {0} 的历史版本',
  downloadHistory: '下载 {0} 的历史版本 .vsix',
  selectOperation: '选择操作：{0}',
  marketplaceMicrosoft: 'Microsoft 市场',
  marketplaceOpenVsx: 'Open VSX 市场',
  marketplaceOther: '应用商店',
  debugLogOn: '插件中心调试日志已开启',
  debugLogOff: '插件中心调试日志已关闭',
};

const en: Dict = {
  sourceUrlEmpty: 'Source URL cannot be empty',
  sourceDataInvalid: 'Invalid source data',
  appIdMissing: 'Missing app id',
  openDetailFailed: 'Failed to open extension details: {0}',
  unknownMessage: 'Unknown message type: {0}',
  enable: 'Enable',
  disable: 'Disable',
  selectActionFor: '{0}: choose an action',
  noInstallableVersion: '[{0}] No installable version available',
  titleDownloadVersion: 'Select version to download: {0}',
  titleInstallVersion: 'Select version to install: {0}',
  placeholderDownloadVersion: 'Pick a version to download .vsix',
  placeholderInstallVersion: 'Pick a version to install',
  currentVersion: 'Current version',
  releasedOn: 'Released {0}',
  versionAlreadyInstalled: '[{0}] Version {1} is already installed',
  installingVersion: 'Installing {0} {1}...',
  installSuccessReload: '[{0}] {1} installed successfully. Reload window to activate',
  reload: 'Reload',
  versionOpFailed: '[{0}] Failed to {1} version {2}: {3}',
  installOtherVersion: 'Install Another Version...',
  downloadOtherVersion: 'Download Another Version...',
  update: 'Update',
  uninstall: 'Uninstall',
  install: 'Install',
  noManageAction: '[{0}] No management action available',
  copyExtId: 'Copy Extension ID',
  managePlaceholder: 'Manage: {0}',
  copiedExtId: 'Copied extension ID: {0}',
  updating: 'Updating {0}...',
  uninstalling: 'Uninstalling {0}...',
  installing: 'Installing {0}...',
  noVsixFound: '[{0}] No downloadable VSIX package found',
  vsixFilter: 'VSIX packages',
  download: 'Download',
  downloading: 'Downloading {0} {1}...',
  downloaded: 'Downloaded: {0}',
  openContainingFolder: 'Open Containing Folder',
  installingGeneric: 'Installing...',
  updatingGeneric: 'Updating...',
  uninstallingGeneric: 'Uninstalling...',
  installSuccessGeneric: 'Installed successfully. Reload window to activate',
  updateSuccessGeneric: 'Updated successfully. Reload window to activate',
  uninstallSuccessGeneric: 'Uninstalled successfully',
  installHistory: 'Install a previous version of {0}',
  downloadHistory: 'Download a previous version of {0} as .vsix',
  selectOperation: 'Choose an action: {0}',
  marketplaceMicrosoft: 'Microsoft Marketplace',
  marketplaceOpenVsx: 'Open VSX Marketplace',
  marketplaceOther: 'App Store',
  debugLogOn: 'App Store Hub debug logging enabled',
  debugLogOff: 'App Store Hub debug logging disabled',
};

let cachedLang: Language = 'auto';

export function setLang(lang: Language): void {
  cachedLang = lang;
}

export function resolveLang(): 'zh-cn' | 'en' {
  const cfg = cachedLang === 'auto' ? getLanguage() : cachedLang;
  if (cfg === 'en') return 'en';
  const vscodeLang = (vscode.env.language || '').toLowerCase();
  if (vscodeLang.startsWith('en')) return 'en';
  return 'zh-cn';
}

export function uiLocale(): 'zh-cn' | 'en' {
  return resolveLang();
}

export function t(key: string, ...args: Array<string | number>): string {
  const dict = resolveLang() === 'en' ? en : zh;
  let s = dict[key] ?? key;
  args.forEach((a, i) => {
    s = s.split(`{${i}}`).join(String(a));
  });
  return s;
}
