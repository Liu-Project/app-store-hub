import * as vscode from 'vscode';

const SECTION = 'appStoreHub';
const DEFAULT_SOURCES = [
  {
    label: 'VS Code Marketplace',
    url: 'https://marketplace.visualstudio.com/_apis/public/gallery',
    concurrent: false,
  },
  { label: 'Open VSX', url: 'https://open-vsx.org/vscode/gallery', concurrent: true },
  { label: '本地开发源', url: 'http://127.0.0.1:3000', concurrent: false },
];

export interface SourceConfig {
  label: string;
  url: string;
  /** 是否使用并发连接：勾选后请求失败时并发赛跑，适合不稳定源（如 open-vsx）；稳定源建议关闭，避免并发请求触发限流 */
  concurrent?: boolean;
}

export type InstallMode = 'auto' | 'manual';

export type Language = 'auto' | 'zh-cn' | 'en';

/** 界面语言：auto 跟随 VS Code 界面语言（zh 前缀为中文，其余为英文），可显式指定 zh-cn / en */
export function getLanguage(): Language {
  const v = vscode.workspace.getConfiguration(SECTION).get<string>('language', 'auto');
  return v === 'zh-cn' || v === 'en' ? v : 'auto';
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getSources(): SourceConfig[] {
  const arr = vscode.workspace.getConfiguration(SECTION).get<SourceConfig[]>('sources', []);
  const list = arr
    .filter((s) => s && typeof s.url === 'string' && s.url.trim())
    .map((s) => ({
      label: s.label || s.url,
      url: normalizeUrl(s.url),
      concurrent: !!s.concurrent,
    }));
  return list.length ? list : DEFAULT_SOURCES.map((s) => ({ ...s }));
}

export function getActiveSourceUrl(): string {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const active = cfg.get<string>('activeSource', '');
  const sources = getSources();
  const matched = active
    ? sources.find((s) => normalizeUrl(s.url) === normalizeUrl(active))
    : undefined;
  return matched ? matched.url : sources[0].url;
}

export function setActiveSource(url: string): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update('activeSource', normalizeUrl(url), vscode.ConfigurationTarget.Global);
}

export function setSources(sources: SourceConfig[]): Thenable<void> {
  const list = sources
    .filter((s) => s && s.url && s.url.trim())
    .map((s) => ({
      label: s.label || s.url,
      url: normalizeUrl(s.url),
      concurrent: !!s.concurrent,
    }));
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const currentActive = cfg.get<string>('activeSource', '');
  const stillExists = list.some((s) => normalizeUrl(s.url) === normalizeUrl(currentActive));
  return cfg.update('sources', list, vscode.ConfigurationTarget.Global).then(() => {
    if (!stillExists && list.length) {
      return cfg.update('activeSource', list[0].url, vscode.ConfigurationTarget.Global);
    }
    return undefined;
  });
}

export function getInstallMode(): InstallMode {
  return vscode.workspace.getConfiguration(SECTION).get<InstallMode>('installMode', 'auto');
}

/** 连接软件源失败时的自动重试次数（默认 4，即最多尝试 5 次） */
export function getRetryCount(): number {
  const n = vscode.workspace.getConfiguration(SECTION).get<number>('retry', 4);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** 单次请求的连接超时（毫秒，默认 20000）：open-vsx 等慢源经代理响应可达 10~15s，8s idle 超时会误杀连接导致加载失败 */
export function getConnTimeout(): number {
  const n = vscode.workspace.getConfiguration(SECTION).get<number>('connTimeout', 20000);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 20000;
}

/**
 * 代理地址解析（对齐 VS Code 内置扩展商城）：
 * 优先级：appStoreHub.proxy > http.proxy（VS Code 标准设置）> 系统环境变量 https_proxy/http_proxy 等。
 * VS Code 从桌面图标启动时扩展进程不会继承终端导出的代理变量，必须显式配置代理才能正常访问软件源。
 */
export function getProxyUrl(): string {
  try {
    const own = vscode.workspace.getConfiguration(SECTION).get<string>('proxy', '');
    if (own && own.trim()) {
      return own.trim();
    }
    const httpProxy = vscode.workspace.getConfiguration('http').get<string>('proxy', '');
    if (httpProxy && httpProxy.trim()) {
      return httpProxy.trim();
    }
  } catch {
    /* 配置读取异常时回退环境变量 */
  }
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    ''
  );
}
