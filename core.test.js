'use strict';
// Self-contained test: mock target server + mock HTTP-upstream (auth) + mock SOCKS5-upstream (auth).
const http = require('http');
const net = require('net');
const assert = require('assert');
const { ProxyCore } = require('../lib/proxy-core');
const { probe } = require('../lib/upstream');
const { compileRules } = require('../lib/rules');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  // ---- rules ----
  const d = compileRules([
    { action: 'direct', hosts: ['*.ru', 'vk.com', '*.vk.com', '1.1.1.0/24', '.example.su', 'ozon.*'] },
  ]);
  assert.strictEqual(d('yandex.ru'), 'direct');
  assert.strictEqual(d('m.vk.com'), 'direct');
  assert.strictEqual(d('vk.com'), 'direct');
  assert.strictEqual(d('1.1.1.77'), 'direct');
  assert.strictEqual(d('1.1.2.77'), 'proxy');
  assert.strictEqual(d('a.example.su'), 'direct');
  assert.strictEqual(d('google.com'), 'proxy');
  assert.strictEqual(d('notvk.com'), 'proxy');
  assert.strictEqual(d('192.168.1.5'), 'direct');
  assert.strictEqual(d('localhost'), 'direct');
  assert.strictEqual(compileRules([{ action: 'direct', hosts: ['*.рф'] }])('xn--e1afmkfd.xn--p1ai'), 'direct');
  console.log('rules ok');

  // ---- target ----
  const hits = { target: 0 };
  const target = http.createServer((req, res) => { hits.target++; res.end('hello-from-target:' + req.url); });
  const tport = await listen(target);

  // ---- HTTP upstream with Basic auth ----
  const seen = { connect: 0, plain: 0 };
  const AUTH = 'Basic ' + Buffer.from('user:pass').toString('base64');
  const httpUp = http.createServer((req, res) => {
    seen.plain++;
    if (req.headers['proxy-authorization'] !== AUTH) { res.writeHead(407); return res.end(); }
    const u = new URL(req.url);
    http.get({ host: u.hostname === 'example.com' ? '127.0.0.1' : u.hostname, port: u.port, path: u.pathname }, (r) => r.pipe(res.writeHead(r.statusCode, r.headers) && res));
  });
  httpUp.on('connect', (req, sock) => {
    seen.connect++;
    if (req.headers['proxy-authorization'] !== AUTH) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [h, p] = req.url.split(':');
    const t = net.connect(+p, h === 'example.com' ? '127.0.0.1' : h, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); t.pipe(sock); sock.pipe(t); });
    t.on('error', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  const hport = await listen(httpUp);

  // ---- SOCKS5 upstream with user/pass ----
  const socksUp = net.createServer((c) => {
    let st = 0, buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (st === 0 && buf.length >= 4) { c.write(Buffer.from([5, 2])); st = 1; buf = Buffer.alloc(0); }
      else if (st === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ul = buf[1], user = buf.slice(2, 2 + ul).toString(), pl = buf[2 + ul], pass = buf.slice(3 + ul, 3 + ul + pl).toString();
        if (user === 'user' && pass === 'pass') { c.write(Buffer.from([1, 0])); st = 2; } else { c.end(Buffer.from([1, 1])); }
        buf = Buffer.alloc(0);
      } else if (st === 2 && buf.length >= 7) {
        let host, port;
        if (buf[3] === 3) { host = buf.slice(5, 5 + buf[4]).toString(); port = buf.readUInt16BE(5 + buf[4]); }
        else if (buf[3] === 1) { host = [...buf.slice(4, 8)].join('.'); port = buf.readUInt16BE(8); }
        st = 3;
        const t = net.connect(port, host === 'example.com' ? '127.0.0.1' : host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); t.pipe(c); c.pipe(t);
        });
        t.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
    c.on('error', () => {});
  });
  const sport = await listen(socksUp);

  const viaProxy = (cport, path, host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cport, path: `http://${host}:${tport}${path}`, headers: { Host: `${host}:${tport}` } }, (r) => {
      let b = ''; r.on('data', (x) => (b += x)); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
  const viaConnect = (cport, host) => new Promise((resolve, reject) => {
    const s = net.connect(cport, '127.0.0.1', () => s.write(`CONNECT ${host}:${tport} HTTP/1.1\r\nHost: ${host}:${tport}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n') && !buf.includes('GET')) {
        if (!buf.startsWith('HTTP/1.1 200')) { s.destroy(); return resolve({ status: buf.split(' ')[1] }); }
        if (!s._sent) { s._sent = true; buf = ''; s.write(`GET /tls-like HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`); }
      }
      if (s._sent && buf.includes('hello-from-target')) { s.destroy(); resolve({ status: 200, body: buf }); }
    });
    s.on('error', reject);
  });

  // ---- probes ----
  assert.deepStrictEqual((await probe({ protocol: 'http', host: '127.0.0.1', port: hport, username: 'user', password: 'pass' }, 4)).ok, true);
  const bad = await probe({ protocol: 'http', host: '127.0.0.1', port: hport, username: 'user', password: 'WRONG' }, 4);
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 'AUTH');
  assert.strictEqual((await probe({ protocol: 'socks5', host: '127.0.0.1', port: sport, username: 'user', password: 'pass' }, 4)).ok, true);
  assert.strictEqual((await probe({ protocol: 'socks5', host: '127.0.0.1', port: sport, username: 'user', password: 'x' }, 4)).code, 'AUTH');
  console.log('probe ok');

  // ---- core: HTTP upstream ----
  const core = new ProxyCore();
  let cport = await core.start({ protocol: 'http', host: '127.0.0.1', port: hport, username: 'user', password: 'pass' },
    [{ action: 'direct', hosts: ['direct.test'] }]);
  let r = await viaConnect(cport, 'example.com');
  assert.strictEqual(r.status, 200); assert(r.body.includes('hello-from-target'));
  assert.strictEqual(seen.connect >= 3, true);
  const before = seen.plain;
  r = await viaProxy(cport, '/plain', 'example.com');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body, 'hello-from-target:/plain');
  assert.strictEqual(seen.plain, before + 1, 'plain http must go through upstream');
  console.log('core http-upstream ok');

  // live rule update: make example.com direct -> must NOT touch the upstream any more
  core.updateRules([{ action: 'direct', hosts: ['example.com'] }]);
  const cBefore = seen.connect, pBefore = seen.plain;
  // 'example.com' doesn't resolve here, so a direct attempt must fail with 502 (proves it did not use upstream)
  r = await viaConnect(cport, 'example.com');
  assert.strictEqual(r.status, '502'); assert.strictEqual(seen.connect, cBefore); assert.strictEqual(seen.plain, pBefore);
  console.log('live rules ok');
  await core.stop();

  // ---- core: SOCKS5 upstream ----
  cport = await core.start({ protocol: 'socks5', host: '127.0.0.1', port: sport, username: 'user', password: 'pass' }, []);
  r = await viaConnect(cport, 'example.com');
  assert.strictEqual(r.status, 200); assert(r.body.includes('hello-from-target'));
  r = await viaProxy(cport, '/via-socks', 'example.com');
  assert.strictEqual(r.body, 'hello-from-target:/via-socks');
  console.log('core socks5-upstream ok');
  await core.stop();

  [target, httpUp, socksUp].forEach((s) => s.close());
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
