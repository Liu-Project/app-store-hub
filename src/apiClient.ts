import { httpRequest as netRequest, HttpError, type HttpResponse } from './netHttp';
import {
  getActiveSourceUrl,
  getConnTimeout,
  getProxyUrl,
  getRetryCount,
  getSources,
} from './config';
import { log, logErr } from './logger';

export interface AppVersion {
  version: string;
  date: string;
  changelog: string;
  hasPackage: boolean;
  /** 该版本 VSIX 的绝对下载 URL（来自 Gallery files[].source） */
  vsixUrl?: string;
}

export interface AppInfo {
  id: string;
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  icon: string;
  hasPackage: boolean;
  categories: string[];
  keywords: string[];
  license: string;
  engines: { vscode?: string };
  downloadCount: number;
  rating: number;
  ratingCount: number;
  tags: string[];
  versions: AppVersion[];
  readme: string;
  releaseDate: string;
  size: number;
  installed: boolean;
  installedVersion?: string;
  updatable?: boolean;
  /** 当前版本 VSIX 绝对下载 URL */
  vsixUrl?: string;
  /** README 绝对 URL（Gallery Content.Details source） */
  readmeUrl?: string;
  /** 变更日志绝对 URL（Gallery Content.Changelog source） */
  changelogUrl?: string;
  /** 发布者显示名（Gallery publisher.displayName） */
  publisherDisplayName?: string;
  /** 发布者域名已验证 / 官方验证（Gallery publisher.isDomainVerified / isVerified） */
  publisherVerified?: boolean;
  /** 更多信息 URL（Gallery moreInfoUrl） */
  moreInfoUrl?: string;
  /** 仓库 URL（Gallery repository） */
  repository?: string;
  /** 问题跟踪 URL（Gallery issues） */
  issues?: string;
  /** 许可证 URL（Gallery Microsoft.VisualStudio.Services.Content.License source） */
  licenseUrl?: string;
  /** 发布者域名（Gallery publisher.domain） */
  publisherDomain?: { link: string; verified: boolean };
  /** Manifest JSON 绝对 URL（Gallery Microsoft.VisualStudio.Code.Manifest source） */
  manifestUrl?: string;
  /** 最近更新时间（Gallery lastUpdated，用于详情页 Marketplace Info） */
  lastUpdated?: string;
}

export interface AppListResult {
  total: number;
  page: number;
  pageSize: number;
  list: AppInfo[];
}

export interface AppListQuery {
  keyword?: string;
  category?: string;
  publisher?: string;
  extensionName?: string;
  page?: number;
  pageSize?: number;
  /** Gallery sortBy：0=相关度/默认 1=最近更新 2=安装量 3=名称 6=评分 */
  sortBy?: number;
  /** Gallery sortOrder：0=默认 1=升序 2=降序 */
  sortOrder?: number;
  /** 精选视图：携带 filterType:7 */
  featured?: boolean;
  /** 标签过滤：携带 filterType:0 */
  tag?: string;
}

/** Gallery 排序枚举（对齐 VS Code 扩展市场） */
export const GALLERY_SORT = {
  Relevance: 0,
  LastUpdated: 1,
  Installs: 2,
  DisplayName: 3,
  Rating: 6,
} as const;

/** Gallery 排序方向：0=默认 1=升序 2=降序 */
export const GALLERY_SORT_ORDER = {
  Default: 0,
  Ascending: 1,
  Descending: 2,
} as const;

export interface CategoryInfo {
  id: string;
  name: string;
}

// ============ VS Code Gallery 协议类型 ============
export interface GalleryFile {
  assetType: string;
  source: string;
}

export interface GalleryVersion {
  version: string;
  lastUpdated: string;
  files: GalleryFile[];
  versionDescription?: string;
  /** 目标平台（如 linux-x64 / universal），缺失表示通用 */
  targetPlatform?: string;
  /** 版本属性（Microsoft.VisualStudio.Code.PreRelease / Engine 等） */
  properties?: Array<{ key: string; value: string }>;
}

/** Gallery 版本属性 key：预发布标记 */
export const GALLERY_PROP_PRE_RELEASE = 'Microsoft.VisualStudio.Code.PreRelease';

/** 该版本是否为预发布版本（对齐 VS Code gallery 属性判断） */
export function isPreReleaseVersion(v: GalleryVersion): boolean {
  const p = (v.properties || []).find((x) => x.key === GALLERY_PROP_PRE_RELEASE);
  return !!p && p.value === 'true';
}

/**
 * 目标平台兼容判断（对齐 VS Code isTargetPlatformCompatible）：
 * targetPlatform 未定义/universal 视为通用（兼容）；其余仅当与产品平台精确匹配时兼容。
 */
export function isTargetPlatformCompatible(
  versionTargetPlatform: string | undefined,
  productTargetPlatform: string
): boolean {
  if (
    !versionTargetPlatform ||
    versionTargetPlatform === 'universal' ||
    versionTargetPlatform === 'undefined'
  ) {
    return true;
  }
  return versionTargetPlatform === productTargetPlatform;
}

export interface GalleryExtension {
  publisher: {
    publisherId: string;
    publisherName: string;
    displayName: string;
    isDomainVerified?: boolean;
    isVerified?: boolean;
    /** 发布者域名（VS Code 用它展示已验证发布者的认证域名） */
    domain?: string;
  };
  extensionId: string;
  extensionName: string;
  displayName: string;
  shortDescription: string;
  versions: GalleryVersion[];
  categories: string[];
  tags: string[];
  statistics: { statisticName: string; value: number }[];
  iconUrl: string;
  lastUpdated: string;
  publishedDate: string;
  releaseDate: string;
  moreInfoUrl?: string;
  repository?: string;
  issues?: string;
}

export const GALLERY_ASSET_VSIX = 'Microsoft.VisualStudio.Services.VSIXPackage';
export const GALLERY_ASSET_ICON = 'Microsoft.VisualStudio.Services.Icons.Default';
export const GALLERY_ASSET_DETAILS = 'Microsoft.VisualStudio.Services.Content.Details';
export const GALLERY_ASSET_CHANGELOG = 'Microsoft.VisualStudio.Services.Content.Changelog';
export const GALLERY_ASSET_MANIFEST = 'Microsoft.VisualStudio.Code.Manifest';

/** 列表查询 flags：最新版本 + 统计 + 资产 + 文件 */
export const GALLERY_FLAGS_LIST = 950;
/** 详情查询 flags：全部历史版本 + 统计 + 资产 + 文件（去 LatestVersionOnly，加 IncludeVersions） */
export const GALLERY_FLAGS_DETAIL = 0x1b7;

/**
 * github.com/{owner}/{repo}/raw/{ref}/{path} → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 * README 常用 raw 图片链接；github.com 本身经代理时好时坏（可挂 10s+），
 * 直连 raw 子域可跳过一次重定向跳板，减少一次失败点。
 */
function rewriteRawGithubUrl(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.+)$/i.exec(url);
  if (!m) {
    return url;
  }
  const [, owner, repo, rest] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
}

/** 按 URL 后缀猜测图片 MIME（响应头无 content-type 时兜底） */
function guessMime(url: string): string {
  const p = url.toLowerCase().split(/[?#]/)[0];
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.ico')) return 'image/x-icon';
  if (p.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  /** getAppByName 结果缓存（仅缓存完整版本查询结果），避免重复触发大查询/限流 */
  private appCache = new Map<string, { t: number; app: AppInfo }>();
  private static readonly APP_CACHE_TTL = 5 * 60 * 1000;

  /** 外部图片 data URI 缓存（会话内）：详情页与面板共享同一 ApiClient，
   *  再次打开详情时 README 图片直接命中缓存立即显示，无需重新经代理下载大 GIF */
  private imageCache = new Map<string, string>();
  private static readonly IMAGE_CACHE_MAX = 200;

  /** 当前 VS Code 运行平台（Gallery 协议 targetPlatform 过滤用） */
  static targetPlatform(): string {
    const p = process.platform;
    const arch = process.arch;
    if (p === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
    if (p === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    if (p === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    return `${p}-${arch}`;
  }

  /** Gallery serviceUrl：在 baseUrl 基础上追加 /vscode/gallery（若未包含） */
  galleryEndpoint(): string {
    let base = this.baseUrl.replace(/\/+$/, '');
    if (!/\/vscode\/gallery$/.test(base) && !/_apis\/public\/gallery$/.test(base)) {
      base += '/vscode/gallery';
    }
    return base;
  }

  /**
   * 发起一次 HTTP 请求。
   * 连接失败自动重试（仅连接类错误 status=0 重试），重试策略由当前源的「并发」配置决定：
   * - concurrent=false（如微软市场，避免并发请求触发 IP Rate Limit）：顺序单连接重试；
   * - concurrent=true（如 open-vsx 不稳定源）：并发赛跑，同一轮最多 3 个连接，首个成功立即返回并取消其余连接。
   * @param retries 连接类错误的自动重试次数，只读查询传 getRetryCount()；写操作传 0。
   * @param timeoutMs 单次请求连接超时（毫秒）。
   * @param concurrent 是否使用并发赛跑重试。
   */
  async request<T>(
    path: string,
    options: RequestInit = {},
    retries = 0,
    timeoutMs?: number,
    concurrent = false,
    raw = false
  ): Promise<T> {
    const attempts = retries + 1;
    if (concurrent) {
      return this.raceWithConcurrency<T>(path, options, timeoutMs, attempts, raw);
    }
    return this.retrySequential<T>(path, options, timeoutMs, attempts, raw);
  }

  /** 顺序模式：每次单连接，仅连接类错误（status=0）重试，避免并发请求放大触发限流 */
  private async retrySequential<T>(
    path: string,
    options: RequestInit,
    timeoutMs: number | undefined,
    attempts: number,
    raw = false
  ): Promise<T> {
    let lastError: HttpError | undefined;
    for (let i = 0; i < attempts; i++) {
      const r = await this.attempt<T>(path, options, timeoutMs, undefined, raw);
      if (r.ok) {
        return r.value;
      }
      if (!(r.error instanceof HttpError && r.error.status === 0)) {
        throw r.error;
      }
      lastError = r.error;
      if (i < attempts - 1) {
        logErr(`[apiClient] 重试 ${i + 1}/${attempts}（顺序模式）：${r.error.message}`);
        await new Promise((s) => setTimeout(s, 250 + Math.random() * 400));
      }
    }
    throw new ApiError(
      0,
      `无法连接软件源 ${this.baseUrl}（${lastError ? lastError.message : '连接失败'}）。若网络受限，请在设置中配置代理（appStoreHub.proxy 或 http.proxy）`
    );
  }

  /** 并发模式：同一轮并发赛跑，首个成功立即返回并取消其余连接（AbortSignal 支持） */
  private async raceWithConcurrency<T>(
    path: string,
    options: RequestInit,
    timeoutMs: number | undefined,
    attempts: number,
    raw = false
  ): Promise<T> {
    const parallel = Math.max(1, Math.min(3, attempts));
    const rounds = Math.ceil(attempts / parallel);
    let lastError: HttpError | undefined;
    for (let r = 0; r < rounds; r++) {
      const batchSize = Math.min(parallel, attempts - r * parallel);
      const controller = new AbortController();
      const batch = Array.from({ length: batchSize }, () =>
        this.attempt<T>(path, options, timeoutMs, controller.signal, raw)
      );
      // 第一个成功即结算（不等其余连接），并取消仍挂起的连接
      const settled = await this.raceBatch(batch);
      if (settled.ok) {
        controller.abort();
        return settled.value;
      }
      if (settled.error && !(settled.error instanceof HttpError && settled.error.status === 0)) {
        controller.abort();
        throw settled.error;
      }
      if (settled.error) {
        lastError = settled.error;
      }
      controller.abort();
      if (r < rounds - 1) {
        // 整轮连接失败：短暂随机延迟后进入下一轮并发
        logErr(
          `[apiClient] 整轮连接失败（并发模式，第 ${r + 1}/${rounds} 轮）：${settled.error?.message ?? '未知'}`
        );
        await new Promise((s) => setTimeout(s, 250 + Math.random() * 400));
      }
    }
    throw new ApiError(
      0,
      `无法连接软件源 ${this.baseUrl}（${lastError ? lastError.message : '连接失败'}）。若网络受限，请在设置中配置代理（appStoreHub.proxy 或 http.proxy）`
    );
  }

  /** 当前激活源是否启用并发连接（按 baseUrl 匹配软件源配置） */
  private concurrentEnabled(): boolean {
    try {
      const sources = getSources();
      return !!sources.find((s) => s.url === this.baseUrl)?.concurrent;
    } catch {
      return false;
    }
  }

  /** 通用 GET：获取文本内容（绝对 URL 或相对路径），走当前源并发/代理/重试策略 */
  async getText(url: string): Promise<string> {
    return this.request<string>(
      url,
      { method: 'GET' },
      getRetryCount(),
      getConnTimeout(),
      this.concurrentEnabled(),
      true
    );
  }

  /** 通用 GET：获取 JSON（绝对 URL 或相对路径），走当前源并发/代理/重试策略 */
  async getJson<T = Record<string, unknown>>(url: string): Promise<T> {
    return this.request<T>(
      url,
      { method: 'GET' },
      getRetryCount(),
      getConnTimeout(),
      this.concurrentEnabled()
    );
  }

  /**
   * 获取二进制内容（图片等）并返回 data URI，供 webview 通过代理展示外部截图。
   * webview 的 <img> 由浏览器直连加载、不经过本扩展配置的代理，受限网络下会加载失败；
   * 改为经扩展主机（ApiClient/netHttp，带代理/并发/重试）下载后以 base64 data URI 回传。
   */
  async getImageDataUrl(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      return '';
    }
    // 跳过 github.com → raw.githubusercontent.com 的重定向跳板（github.com 经代理常挂起）
    const target = rewriteRawGithubUrl(url);
    // 缓存 key 用归一化后的 target：github.com/raw 与 raw.githubusercontent.com 两种形式共享缓存
    const cached = this.imageCache.get(target);
    if (cached) {
      return cached;
    }
    // 外部图片源（github raw、CDN 等）经代理时好时坏：连接要么 2~4s 成功要么挂起直到超时。
    // 图片下载提高并发（8）并缩短单连接超时上限（6s，仅覆盖连接建立阶段，已建立连接的
    // 传输不受此限制）：一轮 8 个并发里命中成功连接的概率 >98%，失败连接 6s 内淘汰，
    // 避免 10s×多轮 的长时间等待；仍保留第二轮兜底（attempts=10，rounds=2）
    const attempts = 10;
    const parallel = Math.min(8, attempts);
    const rounds = Math.ceil(attempts / parallel);
    const timeoutMs = Math.min(getConnTimeout(), 6000);
    const proxy = getProxyUrl();
    let lastErr: HttpError | undefined;
    for (let r = 0; r < rounds; r++) {
      const controller = new AbortController();
      const batchSize = Math.min(parallel, attempts - r * parallel);
      const batch: Promise<{ ok: true; value: HttpResponse } | { ok: false; error: HttpError }>[] =
        Array.from({ length: batchSize }, () =>
          netRequest(target, {
            method: 'GET',
            timeoutMs,
            proxy,
            binary: true,
            signal: controller.signal,
          }).then(
            (value) => ({ ok: true as const, value }),
            (e) => ({
              ok: false as const,
              error: e instanceof HttpError ? e : new HttpError(0, String(e?.message ?? e)),
            })
          )
        );
      const settled = await this.raceBatch(batch);
      if (settled.ok) {
        controller.abort();
        const res = settled.value;
        if (res.status >= 200 && res.status < 300 && res.body) {
          const ct = String(res.headers['content-type'] || '')
            .split(';')[0]
            .toLowerCase();
          const mime = ct || guessMime(url);
          const dataUrl = `data:${mime};base64,${res.body}`;
          if (this.imageCache.size >= ApiClient.IMAGE_CACHE_MAX) {
            const first = this.imageCache.keys().next().value;
            if (first !== undefined) {
              this.imageCache.delete(first);
            }
          }
          this.imageCache.set(target, dataUrl);
          return dataUrl;
        }
        lastErr = new HttpError(res.status, `HTTP ${res.status}`);
      } else {
        if (settled.error instanceof HttpError) {
          lastErr = settled.error;
        }
      }
      controller.abort();
      if (r < rounds - 1) {
        await new Promise((s) => setTimeout(s, 250 + Math.random() * 400));
      }
    }
    logErr(`[apiClient] 图片下载失败（${lastErr ? lastErr.message : '全部连接失败'}）：${url}`);
    return '';
  }

  /** 单次连接尝试：成功返回 {ok:true}，连接类错误返回 {ok:false}，其他错误直接抛出 */
  private async attempt<T>(
    path: string,
    options: RequestInit,
    timeoutMs?: number,
    signal?: AbortSignal,
    raw = false
  ): Promise<{ ok: true; value: T } | { ok: false; error: HttpError }> {
    const t0 = Date.now();
    try {
      const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
      const proxy = getProxyUrl();
      log(
        `[apiClient] ${options.method || 'GET'} ${url}${proxy ? `（代理 ${proxy}）` : '（直连）'}`
      );
      const res = await netRequest(url, {
        method: options.method || 'GET',
        headers: options.headers as Record<string, string> | undefined,
        body: options.body ? String(options.body) : undefined,
        timeoutMs,
        signal,
        proxy,
      });
      const value = (raw ? res.body : this.parseResponse<T>(res)) as T;
      if (raw && (res.status < 200 || res.status >= 300)) {
        throw new ApiError(res.status, `HTTP ${res.status}`);
      }
      log(`[apiClient] ${options.method || 'GET'} ${url} → ${res.status}（${Date.now() - t0}ms）`);
      return { ok: true as const, value };
    } catch (e) {
      if (e instanceof HttpError && e.status === 0) {
        logErr(
          `[apiClient] ${options.method || 'GET'} ${path} 连接失败：${e.message}（${Date.now() - t0}ms）`
        );
        return { ok: false as const, error: e };
      }
      logErr(
        `[apiClient] ${options.method || 'GET'} ${path} 失败：${e instanceof Error ? e.message : String(e)}（${Date.now() - t0}ms）`
      );
      throw e;
    }
  }

  /**
   * 并发批次的 race 结算：第一个成功（{ok:true}）立即 resolve；
   * 全部失败后 resolve {ok:false}（携带最后一个错误，若存在非连接类错误则优先返回它）。
   */
  private raceBatch<T>(
    batch: Promise<{ ok: true; value: T } | { ok: false; error: HttpError }>[]
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
    return new Promise((resolve) => {
      let pending = batch.length;
      let fatal: Error | undefined;
      for (const p of batch) {
        void p.then(
          (r) => {
            if (r.ok) {
              resolve(r);
              return;
            }
            pending -= 1;
            if (pending === 0) {
              resolve({ ok: false, error: fatal ?? r.error });
            }
          },
          (e: Error) => {
            fatal = fatal ?? e;
            pending -= 1;
            if (pending === 0) {
              resolve({ ok: false, error: e });
            }
          }
        );
      }
    });
  }

  /** 解析 HTTP 响应为 T（处理 204 / JSON / 非 2xx 状态码） */
  private parseResponse<T>(res: { status: number; body: string }): T {
    const { status, body } = res;
    if (status === 204) {
      return undefined as unknown as T;
    }
    let data: unknown = null;
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        /* non-json body */
      }
    }
    if (status < 200 || status >= 300) {
      const msg = (data as { message?: string } | null)?.message || `HTTP ${status}`;
      throw new ApiError(status, msg);
    }
    return data as T;
  }

  /** 执行一次 extensionquery（withTarget 决定是否携带 filterType:8 目标过滤） */
  private async queryOnce(
    query: AppListQuery,
    withTarget: boolean,
    flags = GALLERY_FLAGS_LIST
  ): Promise<AppListResult> {
    const criteria: Array<{ filterType: number; value: string }> = [];
    if (withTarget) {
      criteria.push({ filterType: 8, value: 'Microsoft.VisualStudio.Code' });
    }
    if (query.publisher && query.extensionName) {
      // 微软市场要求 filterType:7 必须是 "publisher.extension" 全名，且与 filterType:1 混用会返回 400；
      // 全名查询下 IncludeVersions 才返回全部历史版本（keyword 搜索只返回最新版）
      criteria.push({ filterType: 7, value: `${query.publisher}.${query.extensionName}` });
    } else {
      if (query.publisher) {
        criteria.push({ filterType: 1, value: query.publisher });
      }
      if (query.extensionName) {
        criteria.push({ filterType: 7, value: query.extensionName });
      }
    }
    if (query.category) {
      criteria.push({ filterType: 5, value: query.category });
    }
    if (query.keyword) {
      criteria.push({ filterType: 10, value: query.keyword });
    }
    if (query.tag) {
      criteria.push({ filterType: 0, value: query.tag });
    }
    if (query.featured) {
      criteria.push({ filterType: 7, value: 'Featured' });
    }
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    const body = {
      filters: [
        {
          criteria,
          pageNumber: page,
          pageSize,
          sortBy: query.sortBy ?? 0,
          sortOrder: query.sortOrder ?? 0,
        },
      ],
      assetTypes: [],
      flags,
    };
    const data = await this.request<{
      results?: Array<{
        extensions?: GalleryExtension[];
        resultMetadata?: Array<{
          metadataItems?: Array<{ name: string; value?: string; count?: number }>;
        }>;
      }>;
    }>(
      `${this.galleryEndpoint()}/extensionquery`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          platform: ApiClient.targetPlatform(),
          accept: 'application/json;api-version=3.0-preview.1',
        },
        body: JSON.stringify(body),
      },
      getRetryCount(),
      getConnTimeout(),
      this.concurrentEnabled()
    );
    const result = (data && data.results && data.results[0]) || {};
    const list = (result.extensions || []).map((e) => galleryToAppInfo(e));
    const meta = result.resultMetadata?.[0]?.metadataItems?.find((m) => m.name === 'TotalCount');
    // 兼容两种实现：标准 value 字段 / 部分源使用的 count 字段
    const total = Number(meta?.value ?? meta?.count) || list.length;
    log(
      `[apiClient] queryOnce ${this.galleryEndpoint()}/extensionquery criteria=${JSON.stringify(criteria)} flags=${flags} page=${page} → ${list.length} 条 total=${total}`
    );
    return { total, page, pageSize, list };
  }

  /**
   * 通过 Gallery extensionquery 协议查询扩展列表。
   * 兼容性策略：先带 filterType:8（VS Code 目标）查询；若结果为空，
   * 说明该源不支持 target 过滤（如 8890 本地源），降级为不带该条件重试。
   * flags 默认 950（最新版本）；传 0x1（IncludeVersions）可获取全部版本。
   */
  async queryExtensions(
    query: AppListQuery = {},
    flags = GALLERY_FLAGS_LIST
  ): Promise<AppListResult> {
    let result = await this.queryOnce(query, true, flags);
    if (!result.list.length) {
      const alt = await this.queryOnce(query, false, flags).catch(() => result);
      if (alt.list.length) {
        result = alt;
      }
    }
    return result;
  }

  /** 拉取全量扩展（供不支持过滤的源做客户端匹配，最多拉 maxPages 页；默认列表 flags，避免全量版本响应过大） */
  private async fetchAll(maxPages = 10, flags = GALLERY_FLAGS_LIST): Promise<AppInfo[]> {
    const list: AppInfo[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const r = await this.queryExtensions({ page: p, pageSize: 100 }, flags);
      list.push(...r.list);
      if (r.list.length < 100) {
        break;
      }
      if (list.length >= (r.total || 0)) {
        break;
      }
    }
    return list;
  }

  /** 通过 Gallery 协议查询单个扩展（按 publisher.extensionName） */
  async getAppByName(publisher: string, name: string): Promise<AppInfo> {
    const key = `${publisher}.${name}`;
    const hit = this.appCache.get(key);
    if (hit && Date.now() - hit.t < ApiClient.APP_CACHE_TTL) {
      return hit.app;
    }
    const { app, complete } = await this.getAppByNameUncached(publisher, name);
    if (complete) {
      this.appCache.set(key, { t: Date.now(), app });
    }
    return app;
  }

  private async getAppByNameUncached(
    publisher: string,
    name: string
  ): Promise<{ app: AppInfo; complete: boolean }> {
    // 优先尝试服务端过滤（全名 filterType:7，微软商店返回完整历史版本）
    try {
      const result = await this.queryExtensions(
        { publisher, extensionName: name, page: 1, pageSize: 10 },
        GALLERY_FLAGS_DETAIL
      );
      if (result.list.length) {
        return { app: result.list[0], complete: true };
      }
    } catch {
      /* 源不支持过滤时降级 */
    }
    // 降级一：searchText 查询后客户端匹配（官方商店等不支持 filterType:1/7 的源）
    try {
      const result = await this.queryExtensions(
        { keyword: name, page: 1, pageSize: 100 },
        GALLERY_FLAGS_DETAIL
      );
      const found = result.list.find((a) => a.publisher === publisher && a.name === name);
      if (found) {
        return { app: found, complete: false };
      }
    } catch {
      /* 继续降级 */
    }
    // 降级二：列表全量拉取后客户端匹配（用列表 flags，避免全量版本响应过大导致极慢）
    const all = await this.fetchAll(10, GALLERY_FLAGS_LIST);
    const found = all.find((a) => a.publisher === publisher && a.name === name);
    if (!found) {
      throw new ApiError(404, `扩展不存在：${publisher}.${name}`);
    }
    // 匹配到后尝试用全名再查一次以获取完整历史版本（源恢复时可用）
    try {
      const full = await this.queryExtensions(
        { publisher, extensionName: name, page: 1, pageSize: 1 },
        GALLERY_FLAGS_DETAIL
      );
      if (full.list.length) {
        return { app: full.list[0], complete: true };
      }
    } catch {
      /* 忽略 */
    }
    return { app: found, complete: false };
  }

  /** 获取单个应用：id 支持 "publisher.name" 或纯 "name" 两种形态 */
  async getApp(id: string): Promise<AppInfo> {
    if (id.includes('.')) {
      const idx = id.indexOf('.');
      return this.getAppByName(id.slice(0, idx), id.slice(idx + 1));
    }
    try {
      const result = await this.queryExtensions(
        { extensionName: id, page: 1, pageSize: 10 },
        GALLERY_FLAGS_DETAIL
      );
      if (result.list.length) {
        return result.list[0];
      }
    } catch {
      /* 降级 */
    }
    try {
      const result = await this.queryExtensions(
        { keyword: id, page: 1, pageSize: 100 },
        GALLERY_FLAGS_DETAIL
      );
      const found = result.list.find((a) => a.name === id);
      if (found) {
        return found;
      }
    } catch {
      /* 继续降级 */
    }
    const all = await this.fetchAll(10, GALLERY_FLAGS_LIST);
    const found = all.find((a) => a.name === id);
    if (!found) {
      throw new ApiError(404, `应用不存在：${id}`);
    }
    try {
      const full = await this.queryExtensions(
        { publisher: found.publisher, extensionName: found.name, page: 1, pageSize: 1 },
        GALLERY_FLAGS_DETAIL
      );
      if (full.list.length) {
        return full.list[0];
      }
    } catch {
      /* 忽略 */
    }
    return found;
  }

  /** 获取某版本的 VSIX 下载 URL（优先 files[].source 绝对 URL） */
  async getVsixUrl(pub: string, name: string, version: string): Promise<string> {
    const app = await this.getAppByName(pub, name);
    const v = app.versions.find((x) => x.version === version) || app.versions[0];
    return (v && v.vsixUrl) || app.vsixUrl || '';
  }

  /** 分类：Gallery 协议无独立端点，从扩展 categories 字段聚合 */
  async getCategories(): Promise<CategoryInfo[]> {
    const all = await this.fetchAll(10, GALLERY_FLAGS_DETAIL);
    const map = new Map<string, string>();
    all.forEach((a) => {
      (a.categories || []).forEach((c) => map.set(c, c));
    });
    return Array.from(map, ([id, name]) => ({ id, name }));
  }

  async health(): Promise<{ status: string; time: string }> {
    return this.request(
      '/api/health',
      {},
      getRetryCount(),
      getConnTimeout(),
      this.concurrentEnabled()
    );
  }

  // ============ 安装状态记录（仅本地 3000 后端支持，纯 Gallery 源会失败） ============

  async install(id: string, version?: string): Promise<AppInfo> {
    return this.request(`/api/apps/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      body: JSON.stringify({ version: version ?? null }),
    });
  }

  async uninstall(id: string): Promise<AppInfo> {
    return this.request(`/api/apps/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
      body: '{}',
    });
  }

  async update(id: string): Promise<AppInfo> {
    return this.request(`/api/apps/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: '{}',
    });
  }
}

/** 将 Gallery 扩展对象映射为插件中心内部 AppInfo */
export function galleryToAppInfo(
  e: GalleryExtension,
  opts: { targetPlatform?: string; includePreRelease?: boolean } = {}
): AppInfo {
  const productTargetPlatform = opts.targetPlatform ?? ApiClient.targetPlatform();
  const allVersions = e.versions || [];
  const top = allVersions[0] || { version: '', files: [], lastUpdated: '' };
  const version = top.version || '';
  const vsix = (top.files || []).find((f) => f.assetType.includes('VSIXPackage'))?.source || '';
  const icon =
    e.iconUrl || (top.files || []).find((f) => f.assetType.includes('Icons.Default'))?.source || '';
  const readmeUrl =
    (top.files || []).find((f) => f.assetType.includes('Content.Details'))?.source || '';
  const changelogUrl =
    (top.files || []).find((f) => f.assetType.includes('Content.Changelog'))?.source || '';
  const licenseUrl =
    (top.files || []).find((f) => f.assetType.includes('Content.License'))?.source || '';
  const manifestUrl =
    (top.files || []).find((f) => f.assetType.includes('Microsoft.VisualStudio.Code.Manifest'))
      ?.source || '';
  const stats: Record<string, number> = {};
  (e.statistics || []).forEach((s) => {
    stats[s.statisticName] = s.value;
  });
  const includePreRelease = opts.includePreRelease ?? isPreReleaseVersion(top);
  const seen = new Set<string>();
  const versions: AppVersion[] = [];
  for (const v of allVersions) {
    // 对齐 VS Code：仅保留兼容当前 targetPlatform 的版本（未定义/universal/精确匹配）
    if (!isTargetPlatformCompatible(v.targetPlatform, productTargetPlatform)) {
      continue;
    }
    // release 通道：跳过预发布版本
    if (!includePreRelease && isPreReleaseVersion(v)) {
      continue;
    }
    // 按版本号去重（同版本号只保留一条，保留首个即市场返回的最新）
    if (seen.has(v.version)) {
      continue;
    }
    seen.add(v.version);
    versions.push({
      version: v.version,
      date: v.lastUpdated ? v.lastUpdated.slice(0, 10) : '',
      changelog: v.versionDescription || '',
      hasPackage: !!(v.files || []).some((f) => f.assetType.includes('VSIXPackage')),
      vsixUrl: (v.files || []).find((f) => f.assetType.includes('VSIXPackage'))?.source,
    });
  }
  return {
    id: e.publisher?.publisherName
      ? `${e.publisher.publisherName}.${e.extensionName}`
      : e.extensionName,
    name: e.extensionName,
    displayName: e.displayName,
    publisher: (e.publisher && e.publisher.publisherName) || '',
    version,
    description: e.shortDescription || '',
    icon,
    hasPackage: !!vsix,
    categories: e.categories || [],
    keywords: e.tags || [],
    license: '',
    engines: { vscode: '' },
    downloadCount: stats.install || 0,
    rating: stats.averagerating || 0,
    ratingCount: stats.ratingcount || 0,
    tags: e.tags || [],
    versions,
    readme: '',
    releaseDate: (e.releaseDate || e.publishedDate || '').slice(0, 10),
    size: 0,
    installed: false,
    vsixUrl: vsix,
    readmeUrl,
    changelogUrl,
    publisherDisplayName: e.publisher?.displayName || '',
    publisherVerified: !!(e.publisher?.isDomainVerified || e.publisher?.isVerified),
    moreInfoUrl: e.moreInfoUrl || '',
    repository: e.repository || '',
    issues: e.issues || '',
    licenseUrl,
    publisherDomain: e.publisher?.domain
      ? { link: e.publisher.domain, verified: !!e.publisher.isDomainVerified }
      : undefined,
    manifestUrl,
    lastUpdated: e.lastUpdated || '',
  };
}

export function createApiClient(): ApiClient {
  return new ApiClient(getActiveSourceUrl());
}
