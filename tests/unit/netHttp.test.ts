// eslint-disable-next-line @typescript-eslint/no-var-requires
const assert = require('assert');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveUrl,
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
      // 模拟一个接受连接但永不响应的服务器，用于触发连接阶段超时
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

    it('连接挂起时在超时时间内 reject', async () => {
      const start = Date.now();
      await assert.rejects(
        httpRequest(`http://127.0.0.1:${port}/x`, { timeoutMs: 600 }),
        (e: unknown) => e instanceof HttpError
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `应快速超时，实际用时 ${elapsed}ms`);
    });
  });

  describe('HTTP 请求行', () => {
    let server: net.Server;
    let hPort: number;
    let seenRequestLine: string | null = null;

    before(async () => {
      server = net.createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const sep = buf.indexOf('\r\n\r\n');
          if (sep < 0) {
            return;
          }
          const head = buf.slice(0, sep).toString('latin1');
          seenRequestLine = head.split('\r\n')[0];
          socket.end(
            'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok'
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      hPort = (server.address() as net.AddressInfo).port;
    });

    after(() => {
      server.close();
    });

    it('请求行使用 origin-form（path 而非 absolute-form 完整 URL）', async () => {
      const res = await httpRequest(`http://127.0.0.1:${hPort}/test?q=1`, { timeoutMs: 5000 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'ok');
      assert.strictEqual(seenRequestLine, 'GET /test?q=1 HTTP/1.1', '请求行应为 origin-form');
    });
  });
});
