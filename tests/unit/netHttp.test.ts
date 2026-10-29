// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveUrl,
  parseProxyUrl,
  shouldBypassProxy,
  decodeChunked,
  httpRequest,
  downloadFile,
  HttpError,
} = require('../../src/netHttp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const net = require('net');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

describe('netHttp 纯函数', () => {
  describe('resolveUrl', () => {
    it('解析 http URL', () => {
      const u = resolveUrl('http://example.com:8080/a/b?c=1');
      assert.strictEqual(u.secure, false);
      assert.strictEqual(u.hostname, 'example.com');
      assert.strictEqual(u.port, 8080);
      assert.strictEqual(u.path, '/a/b?c=1');
    });

    it('https 默认端口 443', () => {
      const u = resolveUrl('https://example.com/x');
      assert.strictEqual(u.secure, true);
      assert.strictEqual(u.port, 443);
    });

    it('非法 URL 抛出 HttpError', () => {
      assert.throws(() => resolveUrl('not-a-url'), /URL 无效/);
    });

    it('不支持的协议抛出', () => {
      assert.throws(() => resolveUrl('ftp://example.com'), /不支持的协议/);
    });
  });

  describe('parseProxyUrl', () => {
    it('空值返回 null', () => {
      assert.strictEqual(parseProxyUrl(undefined), null);
      assert.strictEqual(parseProxyUrl('  '), null);
    });

    it('解析 host:port', () => {
      const p = parseProxyUrl('127.0.0.1:8080');
      assert.deepStrictEqual(p, { hostname: '127.0.0.1', port: 8080, secure: false });
    });

    it('解析 http:// 前缀', () => {
      const p = parseProxyUrl('http://proxy.corp:3128');
      assert.deepStrictEqual(p, { hostname: 'proxy.corp', port: 3128, secure: false });
    });

    it('SOCKS 代理忽略', () => {
      assert.strictEqual(parseProxyUrl('socks5://127.0.0.1:1080'), null);
    });

    it('IPv6 代理地址解析', () => {
      assert.deepStrictEqual(parseProxyUrl('[::1]:8080'), {
        hostname: '[::1]',
        port: 8080,
        secure: false,
      });
      assert.deepStrictEqual(parseProxyUrl('http://[::1]'), {
        hostname: '[::1]',
        port: 80,
        secure: false,
      });
    });
  });

  describe('shouldBypassProxy', () => {
    const original = process.env.NO_PROXY;
    const originalLower = process.env.no_proxy;
    beforeEach(() => {
      delete process.env.no_proxy;
      delete process.env.NO_PROXY;
    });
    after(() => {
      if (original === undefined) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = original;
      }
      if (originalLower === undefined) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLower;
      }
    });

    it('未配置时不过滤', () => {
      assert.strictEqual(shouldBypassProxy('example.com'), false);
    });

    it('精确匹配', () => {
      process.env.NO_PROXY = 'example.com';
      assert.strictEqual(shouldBypassProxy('example.com'), true);
      assert.strictEqual(shouldBypassProxy('other.com'), false);
    });

    it('通配符与后缀匹配', () => {
      process.env.NO_PROXY = '*.corp, internal.local';
      assert.strictEqual(shouldBypassProxy('a.corp'), true);
      assert.strictEqual(shouldBypassProxy('internal.local'), true);
      assert.strictEqual(shouldBypassProxy('sub.internal.local'), true);
      assert.strictEqual(shouldBypassProxy('public.com'), false);
    });

    it('IPv4 CIDR 匹配', () => {
      process.env.NO_PROXY = '10.0.0.0/8, 127.0.0.0/8';
      assert.strictEqual(shouldBypassProxy('10.1.2.3'), true);
      assert.strictEqual(shouldBypassProxy('127.0.0.1'), true);
      assert.strictEqual(shouldBypassProxy('192.168.1.1'), false);
    });

    it('非法 CIDR 规则忽略', () => {
      process.env.NO_PROXY = '10.0.0.0/999';
      assert.strictEqual(shouldBypassProxy('10.1.2.3'), false);
      process.env.NO_PROXY = 'not-an-ip/8';
      assert.strictEqual(shouldBypassProxy('10.1.2.3'), false);
    });
  });

  describe('decodeChunked', () => {
    it('解码 chunked 数据', () => {
      const buf = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
      const out = decodeChunked(buf);
      assert.strictEqual(out.toString('utf8'), 'hello world');
    });

    it('忽略扩展与空 chunk', () => {
      const buf = Buffer.from('5;ext=1\r\nhello\r\n0\r\n\r\n');
      const out = decodeChunked(buf);
      assert.strictEqual(out.toString('utf8'), 'hello');
    });

    it('块数据不足时抛出 HttpError', () => {
      const buf = Buffer.from('5\r\nhello\r\n6\r\n wo');
      assert.throws(() => decodeChunked(buf), /chunked 数据不完整/);
    });

    it('缺少块结束符时抛出 HttpError', () => {
      const buf = Buffer.from('5\r\nhello\r\n6\r\nworld');
      assert.throws(() => decodeChunked(buf), /chunked 数据不完整/);
    });

    it('非法块大小抛出 HttpError', () => {
      const buf = Buffer.from('zz\r\nhello\r\n0\r\n\r\n');
      assert.throws(() => decodeChunked(buf), /chunked 数据格式错误/);
    });
  });

  describe('重定向支持', () => {
    let server: net.Server;
    let port: number;
    before(async () => {
      server = net.createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const sep = buf.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const head = buf.slice(0, sep).toString('latin1');
          const first = head.split('\r\n')[0];
          const isRedirect = /^GET \/redirect /.test(first);
          const isTarget = /^GET \/target\//.test(first);
          if (isRedirect) {
            socket.end(
              'HTTP/1.1 302 Found\r\nLocation: /target/file.bin\r\nContent-Length: 0\r\n\r\n'
            );
          } else if (isTarget) {
            socket.end(
              'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: application/octet-stream\r\n\r\nhello'
            );
          } else {
            socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
          }
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const addr = server.address() as net.AddressInfo;
      port = addr.port;
    });
    after(() => {
      server.close();
    });

    it('httpRequest 跟随 302 重定向', async () => {
      const res = await httpRequest(`http://127.0.0.1:${port}/redirect`, { timeoutMs: 5000 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'hello');
    });

    it('downloadFile 跟随 302 重定向并落盘', async () => {
      const dest = path.join(os.tmpdir(), `redirect-test-${Date.now()}.bin`);
      await downloadFile(`http://127.0.0.1:${port}/redirect`, dest, 5000);
      assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello');
      fs.unlinkSync(dest);
    });

    it('404 下载抛出 HttpError', async () => {
      const dest = path.join(os.tmpdir(), `redirect-test-${Date.now()}.bin`);
      await assert.rejects(
        downloadFile(`http://127.0.0.1:${port}/nope`, dest, 5000),
        (e: unknown) => e instanceof HttpError && e.status === 404
      );
    });
  });

  describe('下载完整性', () => {
    let server: net.Server;
    let port: number;
    before(async () => {
      server = net.createServer((socket) => {
        socket.on('data', () => {
          // 声明 Content-Length: 100，但实际只发送 5 字节后关闭连接
          socket.end(
            'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/octet-stream\r\n\r\nhello'
          );
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const addr = server.address() as net.AddressInfo;
      port = addr.port;
    });
    after(() => {
      server.close();
    });

    it('下载不完整时抛出 HttpError 并清理文件', async () => {
      const dest = path.join(os.tmpdir(), `trunc-${Date.now()}.bin`);
      await assert.rejects(
        downloadFile(`http://127.0.0.1:${port}/x`, dest, 5000),
        (e: unknown) => e instanceof HttpError && e.message.includes('不完整')
      );
      assert.strictEqual(fs.existsSync(dest), false, '不完整的文件应被清理');
    });
  });

  describe('连接阶段超时', () => {
    let server: net.Server;
    let port: number;
    before(async () => {
      // 模拟一个接受连接但永不响应的代理，用于触发连接阶段（CONNECT 握手）超时
      server = net.createServer(() => {
        /* 不响应 */
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const addr = server.address() as net.AddressInfo;
      port = addr.port;
    });
    after(() => {
      server.close();
    });

    it('HTTPS 走挂起代理时在超时时间内 reject', async () => {
      const savedHttp = process.env.http_proxy;
      const savedHttps = process.env.https_proxy;
      const savedNoProxy = process.env.no_proxy;
      const savedNoProxyU = process.env.NO_PROXY;
      delete process.env.no_proxy;
      delete process.env.NO_PROXY;
      process.env.https_proxy = `http://127.0.0.1:${port}`;
      process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      try {
        const start = Date.now();
        await assert.rejects(
          httpRequest('https://example.com/x', { timeoutMs: 600 }),
          (e: unknown) => e instanceof HttpError
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 5000, `应快速超时，实际用时 ${elapsed}ms`);
      } finally {
        if (savedHttp === undefined) {
          delete process.env.http_proxy;
        } else {
          process.env.http_proxy = savedHttp;
        }
        if (savedHttps === undefined) {
          delete process.env.https_proxy;
        } else {
          process.env.https_proxy = savedHttps;
        }
        delete process.env.HTTP_PROXY;
        if (savedNoProxy === undefined) {
          delete process.env.no_proxy;
        } else {
          process.env.no_proxy = savedNoProxy;
        }
        if (savedNoProxyU === undefined) {
          delete process.env.NO_PROXY;
        } else {
          process.env.NO_PROXY = savedNoProxyU;
        }
      }
    });
  });

  describe('HTTPS 代理隧道请求行', () => {
    let httpsServer: import('https').Server;
    let proxyServer: net.Server;
    let hPort: number;
    let pPort: number;
    let seenRequestLine: string | null = null;
    const savedHttp = process.env.http_proxy;
    const savedHttps = process.env.https_proxy;
    const savedNoProxy = process.env.no_proxy;
    const savedNoProxyU = process.env.NO_PROXY;

    before(async function () {
      const https = require('https');
      const { execFileSync } = require('child_process');
      // 用 openssl 生成临时自签名证书（若 openssl 不可用则跳过本组测试）
      let key: Buffer, cert: Buffer;
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appstore-tls-'));
        execFileSync('openssl', [
          'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'),
          '-out', path.join(dir, 'cert.pem'), '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
        ], { stdio: 'pipe' });
        key = fs.readFileSync(path.join(dir, 'key.pem'));
        cert = fs.readFileSync(path.join(dir, 'cert.pem'));
      } catch {
        this.skip();
        return;
      }
      httpsServer = https.createServer({ key, cert }, (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
        seenRequestLine = `${req.method} ${req.url}`;
        res.writeHead(200, { 'Content-Length': 2 });
        res.end('ok');
      });
      proxyServer = net.createServer((socket) => {
        let buf = Buffer.alloc(0);
        let target: net.Socket | null = null;
        socket.on('data', function onData(chunk: Buffer) {
          if (target) {
            target.write(chunk);
            return;
          }
          buf = Buffer.concat([buf, chunk]);
          const sep = buf.indexOf('\r\n\r\n');
          if (sep < 0) {
            return;
          }
          const head = buf.slice(0, sep).toString('latin1');
          const m = /^CONNECT ([^\s]+)/.exec(head);
          const hp = (m ? m[1] : '127.0.0.1:1').split(':');
          target = net.connect(Number(hp[1]), hp[0], () => {
            socket.removeListener('data', onData);
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            const rest = buf.slice(sep + 4);
            if (rest.length) {
              target!.write(rest);
            }
            socket.pipe(target);
            target!.pipe(socket);
          });
        });
      });
      await new Promise<void>((r) => httpsServer.listen(0, '127.0.0.1', r));
      await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
      hPort = (httpsServer.address() as net.AddressInfo).port;
      pPort = (proxyServer.address() as net.AddressInfo).port;
    });

    after(() => {
      delete process.env.no_proxy;
      delete process.env.NO_PROXY;
      if (savedHttp === undefined) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = savedHttp;
      }
      if (savedHttps === undefined) {
        delete process.env.https_proxy;
      } else {
        process.env.https_proxy = savedHttps;
      }
      delete process.env.HTTP_PROXY;
      if (savedNoProxy === undefined) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = savedNoProxy;
      }
      if (savedNoProxyU === undefined) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = savedNoProxyU;
      }
      if (httpsServer) {
        httpsServer.close();
      }
      if (proxyServer) {
        proxyServer.close();
      }
    });

    it('CONNECT 隧道内请求行使用 origin-form', async function () {
      if (!httpsServer) {
        this.skip();
        return;
      }
      delete process.env.no_proxy;
      delete process.env.NO_PROXY;
      process.env.http_proxy = `http://127.0.0.1:${pPort}`;
      process.env.https_proxy = `http://127.0.0.1:${pPort}`;
      const res = await httpRequest(`https://127.0.0.1:${hPort}/test?q=1`, { timeoutMs: 5000 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(seenRequestLine, 'GET /test?q=1', '隧道内应为 origin-form 请求行');
    });
  });
});
