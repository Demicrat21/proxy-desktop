'use strict';
// Local forwarding proxy (127.0.0.1:<random>). The OS points at it; for every connection it
// decides DIRECT or UPSTREAM according to the user's domain rules, so upstream credentials never
// need to be known by other programs, and SOCKS5-with-password works even where Windows can't.
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const { compileRules } = require('./rules');
const { connectVia } = require('./upstream');

function splitHostPort(s, defPort) {
  const m = String(s).match(/^\[([^\]]+)\](?::(\d+))?$/) || String(s).match(/^([^:]+)(?::(\d+))?$/);
  return m ? { host: m[1], port: m[2] ? +m[2] : defPort } : { host: String(s), port: defPort };
}

class ProxyCore extends EventEmitter {
  constructor() {
    super();
    this.server = null; this.upstream = null; this.decide = compileRules([]);
    this.sockets = new Set(); this.stats = { direct: 0, proxied: 0, errors: 0 };
  }

  get port() { return this.server ? this.server.address().port : null; }

  updateRules(rules) { this.decide = compileRules(rules); this.emit('rules', rules); }

  async start(upstream, rules) {
    await this.stop();
    this.upstream = upstream; this.decide = compileRules(rules);
    this.stats = { direct: 0, proxied: 0, errors: 0 };
    const server = http.createServer((req, res) => this._onRequest(req, res));
    server.keepAliveTimeout = 30000;
    server.on('connect', (req, sock, head) => this._onConnect(req, sock, head));
    server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); s.on('error', () => {}); });
    server.on('clientError', (e, s) => { try { s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server;
    return this.port;
  }

  async stop() {
    const s = this.server; this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    await new Promise((r) => s.close(() => r()));
  }

  async _open(host, port) {
    if (this.decide(host) === 'direct') {
      this.stats.direct++;
      return new Promise((resolve, reject) => {
        const s = net.connect({ host, port });
        s.setNoDelay(true);
        s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
        s.once('error', reject);
      });
    }
    this.stats.proxied++;
    return connectVia(this.upstream, host, port);
  }

  async _onConnect(req, client, head) {
    const { host, port } = splitHostPort(req.url, 443);
    try {
      const remote = await this._open(host, port);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) remote.write(head);
      remote.pipe(client); client.pipe(remote);
      const kill = () => { remote.destroy(); client.destroy(); };
      remote.on('error', kill); client.on('error', kill);
      remote.on('close', () => client.destroy()); client.on('close', () => remote.destroy());
      remote.resume();
    } catch (e) {
      this.stats.errors++; this.emit('connect-error', host, e);
      try { client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`); } catch (_) {}
    }
  }

  async _onRequest(req, res) {
    let u;
    try { u = new URL(req.url); } catch (_) { res.writeHead(400); return res.end('Bad proxy request'); }
    if (u.protocol !== 'http:') { res.writeHead(400); return res.end('Only http:// is supported here'); }
    const host = u.hostname.replace(/^\[|\]$/g, ''); const port = u.port ? +u.port : 80;
    const headers = { ...req.headers };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    try {
      let out;
      const onResp = (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); };
      if (this.decide(host) === 'proxy' && this.upstream.protocol !== 'socks5') {
        // Plain HTTP through an HTTP upstream: forward as an absolute-URI request + Proxy-Authorization.
        this.stats.proxied++;
        const up = this.upstream;
        if (up.username || up.password) {
          headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${up.username || ''}:${up.password || ''}`).toString('base64');
        }
        out = http.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers, agent: false }, onResp);
      } else {
        const remote = await this._open(host, port);
        remote.resume(); // connectors leave the socket paused after the handshake
        out = http.request({
          method: req.method, path: u.pathname + u.search, headers,
          createConnection: () => remote, agent: null,
        }, onResp);
      }
      out.on('error', (e) => { this.stats.errors++; if (process.env.P6_DEBUG) console.error('out error', e); if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(out);
      res.on('close', () => out.destroy());
    } catch (e) {
      this.stats.errors++; this.emit('connect-error', host, e);
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.end();
    }
  }
}

module.exports = { ProxyCore };
