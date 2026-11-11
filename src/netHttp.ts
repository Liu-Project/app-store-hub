import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { log, logErr } from './logger';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface ResolvedUrl {
  secure: boolean;
  hostname: string;
  port: number;
  host: string;
  path: string;
}

export function resolveUrl(url: string): ResolvedUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new HttpError(0, `URL 无效：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(0, `不支持的协议：${parsed.protocol}`);
  }
  const secure = parsed.protocol === 'https:';
  return {
    secure,
    hostname: parsed.hostname,
    port: Number(parsed.port) || (secure ? 443 : 80),
    host: parsed.host,
    path: parsed.pathname + parsed.search,
  };
}

// ============ 重定向 ============

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function redirectLocation(status: number, headers: Record<string, string>): string | undefined {
  if (!REDIRECT_CODES.has(status)) {
    return undefined;
  }
  const loc = headers['location'];
  return loc && loc.trim() ? loc.trim() : undefined;
}

/** 跟随重定向循环：single 返回响应，含 3xx+Location 时自动跳转，最多 MAX_REDIRECTS 次 */
async function withRedirects(
  initial: string,
  single: (url: string) => Promise<HttpResponse>
): Promise<HttpResponse> {
  let url = initial;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await single(url);
    const loc = redirectLocation(res.status, res.headers);
    if (loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(0, `重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
}

// ============ HTTP 请求 ============

/**
 * 构造请求选项并发出请求。
 * 刻意不传 agent / ca：代理行为完全交由 VS Code 扩展宿主的代理机制
 * （http.proxy + http.noProxy + http.proxySupport + 环境变量，经 @vscode/proxy-agent 补丁）
 * 决定，与 VS Code 内置插件商城保持严格一致。
 */
function buildRequest(
  resolved: ResolvedUrl,
  method: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): http.ClientRequest {
  // 不传 agent / 不设 Connection 头：连接管理与代理行为完全交由 VS Code 扩展宿主的
  // 代理机制（http.proxy + http.noProxy + http.proxySupport + 环境变量，经 @vscode/proxy-agent
  // 补丁）决定，与 VS Code 内置插件商城保持严格一致。
  const opts: http.RequestOptions = {
    host: resolved.hostname,
    port: resolved.port,
    path: resolved.path,
    method,
    headers,
    timeout: timeoutMs,
  };
  if (signal) {
    opts.signal = signal;
  }
  return (resolved.secure ? https : http).request(opts);
}

export function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    /** 取消信号：abort 时销毁连接（用于并发赛跑时取消其余连接） */
    signal?: AbortSignal;
    /** 二进制响应：body 以 base64 返回（供图片等代理为 data URI），不按 UTF-8 解码 */
    binary?: boolean;
  } = {}
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15000;
  // 文本/JSON 响应请求 gzip（CDN 大文件可压缩数倍）；二进制下载不启用以免落盘损坏
  const reqHeaders: Record<string, string> = { ...(options.headers || {}) };
  if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'accept-encoding')) {
    reqHeaders['Accept-Encoding'] = 'gzip';
  }
  const single = (target: string): Promise<HttpResponse> => {
    const resolved = resolveUrl(target);
    log(`[netHttp] ${options.method || 'GET'} ${target}`);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      const req = buildRequest(
        resolved,
        options.method || 'GET',
        reqHeaders,
        timeoutMs,
        options.signal
      );
      req.on('timeout', () => {
        req.destroy(new HttpError(0, '请求超时'));
      });
      req.on('error', (e) => {
        logErr(`[netHttp] ${options.method || 'GET'} ${target} 失败：${e.message}`);
        fail(e instanceof HttpError ? e : new HttpError(0, e.message));
      });
      req.on('response', (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const headers = res.headers as Record<string, string>;
        if (redirectLocation(status, headers)) {
          // 重定向：销毁当前连接（避免 keep-alive 连接池复用已用连接），交由 withRedirects 重新请求
          req.destroy();
          resolve({ status, headers, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('error', (e) => fail(new HttpError(0, e.message)));
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          let bodyBuf = Buffer.concat(chunks);
          try {
            if (
              String(res.headers['content-encoding'] || '')
                .toLowerCase()
                .includes('gzip')
            ) {
              bodyBuf = zlib.gunzipSync(bodyBuf);
            }
          } catch (e) {
            fail(e instanceof Error ? new HttpError(0, e.message) : new HttpError(0, String(e)));
            return;
          }
          resolve({
            status,
            headers,
            body: options.binary ? bodyBuf.toString('base64') : bodyBuf.toString('utf8'),
          });
        });
      });
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  };
  return withRedirects(url, single);
}

// ============ 文件下载 ============

export function downloadFile(url: string, dest: string, timeoutMs = 30000): Promise<void> {
  const single = (target: string): Promise<HttpResponse> => {
    const resolved = resolveUrl(target);
    return new Promise((resolve, reject) => {
      let cleaned = false;
      let expectedLength: number | null = null;
      const cleanup = () => {
        if (!cleaned) {
          cleaned = true;
          // 同步删除：reject 抛出前必须确保临时文件已清理（异步 unlink 与 reject 存在竞态，
          // 调用方捕获错误时文件可能仍未删除）
          try {
            fs.unlinkSync(dest);
          } catch {
            /* 文件可能尚未创建或已被删除，忽略 */
          }
        }
      };
      const req = buildRequest(resolved, 'GET', {}, timeoutMs);
      const fileStream = fs.createWriteStream(dest);
      req.on('timeout', () => {
        req.destroy();
        fileStream.destroy();
        cleanup();
        reject(new HttpError(0, '下载超时'));
      });
      req.on('error', (e) => {
        fileStream.destroy();
        cleanup();
        reject(
          expectedLength !== null && fileStream.bytesWritten < expectedLength
            ? new HttpError(0, '下载不完整：文件被中断')
            : new HttpError(0, e.message)
        );
      });
      req.on('response', (res: http.IncomingMessage) => {
        if (redirectLocation(res.statusCode || 0, res.headers as Record<string, string>)) {
          // 重定向：关闭当前连接，交由 withRedirects 重新请求
          req.destroy();
          fileStream.destroy();
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string>,
            body: '',
          });
          return;
        }
        if (res.statusCode !== 200) {
          req.destroy();
          fileStream.destroy();
          cleanup();
          reject(new HttpError(res.statusCode || 0, `下载失败：HTTP ${res.statusCode}`));
          return;
        }
        const cl = Number(res.headers['content-length']);
        expectedLength = Number.isFinite(cl) && cl > 0 ? cl : null;
        const truncated = () => expectedLength !== null && fileStream.bytesWritten < expectedLength;
        // 服务器声明了 Content-Length 但提前断连：res 触发 error/aborted，需识别为「不完整」并清理
        res.on('error', (e) => {
          fileStream.destroy();
          cleanup();
          reject(
            truncated()
              ? new HttpError(0, '下载不完整：文件被中断')
              : new HttpError(0, `下载失败：${e.message}`)
          );
        });
        res.on('aborted', () => {
          fileStream.destroy();
          cleanup();
          reject(
            truncated()
              ? new HttpError(0, '下载不完整：文件被中断')
              : new HttpError(0, '下载失败：连接中断')
          );
        });
        res.pipe(fileStream);
      });
      fileStream.on('finish', () => {
        if (expectedLength !== null && fileStream.bytesWritten < expectedLength) {
          cleanup();
          reject(new HttpError(0, '下载不完整：文件被中断'));
          return;
        }
        resolve({ status: 200, headers: {}, body: '' });
      });
      fileStream.on('error', (e) => {
        cleanup();
        reject(new HttpError(0, e.message));
      });
      req.end();
    });
  };
  return withRedirects(url, single).then((res) => {
    if (res.status !== 200) {
      throw new HttpError(res.status, `下载失败：HTTP ${res.status}`);
    }
  });
}

// ============ 兼容导出（chunked 解码，供测试使用） ============

export function decodeChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) {
      throw new HttpError(0, 'chunked 数据不完整（缺少块结束符）');
    }
    const sizeHex = buf.slice(i, lineEnd).toString('latin1').split(';')[0].trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size < 0) {
      throw new HttpError(0, 'chunked 数据格式错误');
    }
    if (size === 0) {
      break;
    }
    const start = lineEnd + 2;
    if (buf.length < start + size) {
      throw new HttpError(0, 'chunked 数据不完整（块数据不足）');
    }
    parts.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(parts);
}
