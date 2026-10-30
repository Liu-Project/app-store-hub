import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as zlib from 'zlib';
import type { Socket } from 'net';
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

interface ProxyInfo {
  hostname: string;
  port: number;
  secure: boolean;
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

// ============ 代理支持 ============

export function parseProxyUrl(raw: string | undefined): ProxyInfo | null {
  if (!raw) {
    return null;
  }
  let s = raw.trim();
  if (!s) {
    return null;
  }
  let secure = false;
  if (s.startsWith('http://')) {
    s = s.slice('http://'.length);
  } else if (s.startsWith('https://')) {
    secure = true;
    s = s.slice('https://'.length);
  } else if (s.startsWith('socks://') || s.startsWith('socks5://')) {
    // SOCKS 代理不支持，忽略
    return null;
  } else if (s.startsWith('socks4://')) {
    return null;
  }
  const idx = s.lastIndexOf(':');
  if (idx < 0) {
    return { hostname: s, port: secure ? 443 : 80, secure };
  }
  let hostname: string;
  let portStr: string;
  if (s.startsWith('[')) {
    // IPv6 字面量：[::1]:8080
    const end = s.indexOf(']');
    if (end < 0 || s.slice(end + 1) === '') {
      return { hostname: s, port: secure ? 443 : 80, secure };
    }
    hostname = s.slice(0, end + 1);
    portStr = s.slice(end + 2);
  } else {
    hostname = s.slice(0, idx);
    portStr = s.slice(idx + 1);
  }
  const port = Number(portStr) || (secure ? 443 : 80);
  return { hostname, port, secure };
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((n) => Number(n));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function matchesCidr(host: string, rule: string): boolean {
  const slash = rule.indexOf('/');
  if (slash < 0) {
    return false;
  }
  const ipPart = rule.slice(0, slash);
  const prefix = Number(rule.slice(slash + 1));
  const hostMatch = IPV4_RE.exec(host);
  if (
    !hostMatch ||
    !IPV4_RE.test(ipPart) ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ipPart) & mask) === (ipv4ToInt(host) & mask);
}

export function shouldBypassProxy(hostname: string): boolean {
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (!noProxy.trim()) {
    return false;
  }
  const h = hostname.toLowerCase();
  return noProxy
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule === '*') {
        return true;
      }
      if (rule.includes('/')) {
        return matchesCidr(h, rule);
      }
      if (rule.startsWith('.')) {
        return h.endsWith(rule) || h === rule.slice(1);
      }
      if (rule.includes('*')) {
        const re = new RegExp(
          '^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
        );
        return re.test(h);
      }
      return h === rule || h.endsWith('.' + rule);
    });
}

function resolveProxy(target: ResolvedUrl, configuredProxy?: string): ProxyInfo | null {
  if (shouldBypassProxy(target.hostname)) {
    return null;
  }
  // 优先使用调用方注入的代理（对齐 VS Code：http.proxy 设置等），其次回退环境变量
  if (configuredProxy) {
    return parseProxyUrl(configuredProxy);
  }
  const env = target.secure
    ? process.env.https_proxy || process.env.HTTPS_PROXY
    : process.env.http_proxy || process.env.HTTP_PROXY;
  return parseProxyUrl(env || process.env.all_proxy || process.env.ALL_PROXY);
}

function connect(
  url: ResolvedUrl,
  timeoutMs: number,
  signal?: AbortSignal,
  proxy?: string
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const sockets = new Set<Socket>();
    const onError = (e: Error) => fail(new HttpError(0, e.message));
    const onAbort = () => fail(new HttpError(0, '请求已取消'));
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      sockets.forEach((s) => s.destroy());
      sockets.clear();
    };
    const fail = (e: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      cleanup();
      reject(e);
    };
    const done = (s: Socket) => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (timer) {
        clearTimeout(timer);
      }
      resolve(s);
    };
    timer = setTimeout(() => fail(new HttpError(0, '连接超时')), timeoutMs);

    if (signal) {
      if (signal.aborted) {
        fail(new HttpError(0, '请求已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const resolvedProxy = resolveProxy(url, proxy);
    if (!resolvedProxy) {
      log(
        `[netHttp] connect 直连 ${url.secure ? 'https' : 'http'}://${url.hostname}:${url.port}${url.path}`
      );
      // 直连
      let s: Socket;
      if (url.secure) {
        s = tls.connect(
          {
            host: url.hostname,
            port: url.port,
            servername: url.hostname,
            rejectUnauthorized: false,
          },
          () => {
            s.removeListener('error', onError);
            done(s);
          }
        );
      } else {
        s = net.connect({ host: url.hostname, port: url.port }, () => {
          s.removeListener('error', onError);
          done(s);
        });
      }
      sockets.add(s);
      s.on('error', onError);
      return;
    }

    // 走代理：先建立到代理的 TCP 连接
    log(
      `[netHttp] connect 经代理 ${resolvedProxy.hostname}:${resolvedProxy.port} 访问 ${url.secure ? 'https' : 'http'}://${url.hostname}:${url.port}${url.path}`
    );
    const proxyOpts: net.NetConnectOpts = {
      host: resolvedProxy.hostname,
      port: resolvedProxy.port,
    };
    const raw = net.connect(proxyOpts, () => {
      raw.removeListener('error', onError);
      if (!url.secure) {
        // HTTP：直接通过代理，请求行用完整 URL
        done(raw);
        return;
      }
      // HTTPS：先发 CONNECT 建立隧道，再在隧道内做 TLS
      const connectReq =
        `CONNECT ${url.hostname}:${url.port} HTTP/1.1\r\n` +
        `Host: ${url.hostname}:${url.port}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`;
      raw.write(connectReq);
    });
    sockets.add(raw);
    raw.on('error', onError);

    if (url.secure) {
      // 等待 CONNECT 响应后建立 TLS
      let buf = Buffer.alloc(0);
      raw.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) {
          return;
        }
        const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
        const m = statusLine.match(/HTTP\/\d(?:\.\d)? (\d+)/);
        const status = m ? Number(m[1]) : 0;
        raw.removeAllListeners('data');
        if (status !== 200) {
          fail(new HttpError(0, `代理 CONNECT 失败：HTTP ${status}`));
          return;
        }
        const tlsSocket = tls.connect({
          socket: raw,
          servername: url.hostname,
          rejectUnauthorized: false,
        });
        sockets.add(tlsSocket);
        tlsSocket.on('error', onError);
        tlsSocket.on('secureConnect', () => {
          tlsSocket.removeListener('error', onError);
          done(tlsSocket);
        });
      });
    }
  });
}

function buildHead(
  method: string,
  url: ResolvedUrl,
  headers: Record<string, string>,
  body?: string
): string {
  const h: Record<string, string> = {
    Host: url.host,
    Connection: 'close',
    'Content-Type': 'application/json',
    ...headers,
  };
  if (body) {
    h['Content-Length'] = String(Buffer.byteLength(body));
  }
  let head = `${method} ${url.path} HTTP/1.1\r\n`;
  for (const k of Object.keys(h)) {
    head += `${k}: ${h[k]}\r\n`;
  }
  head += '\r\n';
  return head;
}

function parseHeaders(headerText: string): { status: number; headers: Record<string, string> } {
  const lines = headerText.split('\r\n');
  const m = lines[0].match(/HTTP\/\d(?:\.\d)? (\d+)/);
  const status = m ? Number(m[1]) : 0;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx > 0) {
      const k = lines[i].slice(0, idx).trim().toLowerCase();
      headers[k] = lines[i].slice(idx + 1).trim();
    }
  }
  return { status, headers };
}

export function decodeChunked(buf: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  const parts: Buffer<ArrayBuffer>[] = [];
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

export function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    /** 显式代理地址（如 http://host:port）；未设置时回退环境变量 https_proxy/http_proxy */
    proxy?: string;
    /** 取消信号：abort 时销毁连接（用于并发赛跑时取消其余连接） */
    signal?: AbortSignal;
    /** 二进制响应：body 以 base64 返回（供图片等代理为 data URI），不按 UTF-8 解码 */
    binary?: boolean;
  } = {}
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 15000;
  // 文本/JSON 响应请求 gzip（CDN 大文件如 Python 的 614KB changelog 可压缩 6 倍，
  // 下载从 ~9s 降到 ~1.8s）；二进制下载（downloadFile）不启用以免落盘损坏
  const reqHeaders: Record<string, string> = { ...(options.headers || {}) };
  if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'accept-encoding')) {
    reqHeaders['Accept-Encoding'] = 'gzip';
  }
  const single = (target: string): Promise<HttpResponse> => {
    const resolved = resolveUrl(target);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      connect(resolved, timeoutMs, options.signal, options.proxy)
        .then((socket) => {
          socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            fail(new HttpError(0, '请求超时'));
          });
          const proxy = resolveProxy(resolved, options.proxy);
          // HTTPS 走代理时为 CONNECT 隧道，请求行必须用 origin-form；
          // 仅 HTTP 走代理时请求行才使用完整 URL（absolute-form）
          const headTarget =
            proxy && !resolved.secure
              ? { ...resolved, path: `http://${resolved.host}${resolved.path}` }
              : resolved;
          const head = buildHead(options.method || 'GET', headTarget, reqHeaders, options.body);
          socket.write(head + (options.body || ''));
          let received = Buffer.alloc(0);
          socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
          });
          socket.on('end', () => {
            if (settled) {
              return;
            }
            const sep = received.indexOf('\r\n\r\n');
            if (sep < 0) {
              fail(new HttpError(0, '响应格式错误'));
              return;
            }
            const { status, headers } = parseHeaders(received.slice(0, sep).toString('latin1'));
            let bodyBuf = received.slice(sep + 4);
            try {
              if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
                bodyBuf = decodeChunked(bodyBuf);
              } else if (headers['content-length']) {
                bodyBuf = bodyBuf.slice(0, Number(headers['content-length']));
              }
              if ((headers['content-encoding'] || '').toLowerCase().includes('gzip')) {
                bodyBuf = zlib.gunzipSync(bodyBuf);
              }
            } catch (e) {
              fail(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            settled = true;
            resolve({
              status,
              headers,
              body: options.binary ? bodyBuf.toString('base64') : bodyBuf.toString('utf8'),
            });
          });
          socket.on('error', (e) => {
            logErr(`[netHttp] ${options.method || 'GET'} ${target} 传输错误：${e.message}`);
            fail(new HttpError(0, e.message));
          });
        })
        .catch((e) => {
          logErr(`[netHttp] ${options.method || 'GET'} ${target} 连接失败：${e.message}`);
          fail(new HttpError(0, e.message));
        });
    });
  };
  return withRedirects(url, single);
}

export function downloadFile(
  url: string,
  dest: string,
  timeoutMs = 30000,
  proxy?: string
): Promise<void> {
  const single = (target: string): Promise<HttpResponse> => {
    const resolved = resolveUrl(target);
    return new Promise((resolve, reject) => {
      let cleaned = false;
      let expectedLength: number | null = null;
      const cleanup = () => {
        if (!cleaned) {
          cleaned = true;
          fs.unlink(dest, () => undefined);
        }
      };
      connect(resolved, timeoutMs, undefined, proxy)
        .then((socket) => {
          socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            cleanup();
            reject(new HttpError(0, '下载超时'));
          });
          const proxyInfo = resolveProxy(resolved, proxy);
          const headTarget =
            proxyInfo && !resolved.secure
              ? { ...resolved, path: `http://${resolved.host}${resolved.path}` }
              : resolved;
          const head = buildHead('GET', headTarget, {});
          socket.write(head);
          const fileStream = fs.createWriteStream(dest);
          let bodyStarted = false;
          let headerBuf = Buffer.alloc(0);
          socket.on('data', (chunk: Buffer) => {
            if (bodyStarted) {
              return;
            }
            headerBuf = Buffer.concat([headerBuf, chunk]);
            const sep = headerBuf.indexOf('\r\n\r\n');
            if (sep >= 0) {
              bodyStarted = true;
              const { status, headers } = parseHeaders(headerBuf.slice(0, sep).toString('latin1'));
              if (redirectLocation(status, headers)) {
                // 重定向：关闭当前连接，交由 withRedirects 重新请求
                socket.destroy();
                fileStream.destroy();
                resolve({ status, headers, body: '' });
                return;
              }
              if (status !== 200) {
                socket.destroy();
                fileStream.destroy();
                cleanup();
                reject(new HttpError(status, `下载失败：HTTP ${status}`));
                return;
              }
              if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
                socket.destroy();
                fileStream.destroy();
                cleanup();
                reject(new HttpError(0, '暂不支持 chunked 下载'));
                return;
              }
              const cl = Number(headers['content-length']);
              expectedLength = Number.isFinite(cl) && cl > 0 ? cl : null;
              const rest = headerBuf.slice(sep + 4);
              if (rest.length) {
                fileStream.write(rest);
              }
              socket.pipe(fileStream);
            }
          });
          socket.on('end', () => {
            fileStream.end();
          });
          fileStream.on('finish', () => {
            if (expectedLength !== null && fileStream.bytesWritten < expectedLength) {
              cleanup();
              reject(new HttpError(0, '下载不完整：文件被中断'));
              return;
            }
            resolve({ status: 200, headers: {}, body: '' });
          });
          socket.on('error', (e) => {
            fileStream.destroy();
            cleanup();
            reject(new HttpError(0, e.message));
          });
        })
        .catch((e) => reject(new HttpError(0, e.message)));
    });
  };
  return withRedirects(url, single).then((res) => {
    if (res.status !== 200) {
      throw new HttpError(res.status, `下载失败：HTTP ${res.status}`);
    }
  });
}
