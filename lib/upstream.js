'use strict';
// Connectors to the upstream (paid) proxy: HTTP CONNECT and SOCKS5 with user/password auth.
const net = require('net');

const TIMEOUT = 15000;

function err(message, code) { const e = new Error(message); e.code = code; return e; }

function readBytes(socket, n, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    const timer = setTimeout(() => { cleanup(); reject(err('timeout', 'ETIMEDOUT')); }, timeout);
    const onData = (d) => {
      chunks.push(d); len += d.length;
      if (len >= n) {
        cleanup(); socket.pause();
        const all = Buffer.concat(chunks);
        if (all.length > n) socket.unshift(all.subarray(n));
        resolve(all.subarray(0, n));
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(err('connection closed', 'ECONNRESET')); };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onErr); socket.off('end', onEnd); socket.off('close', onEnd);
    }
    socket.on('data', onData); socket.on('error', onErr); socket.on('end', onEnd); socket.on('close', onEnd);
    socket.resume();
  });
}

function readUntilHeaderEnd(socket, timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(err('timeout', 'ETIMEDOUT')); }, timeout);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i !== -1) {
        cleanup(); socket.pause();
        const rest = buf.subarray(i + 4);
        if (rest.length) socket.unshift(rest);
        resolve(buf.subarray(0, i).toString('latin1'));
      } else if (buf.length > 65536) { cleanup(); reject(err('header too large', 'EPROTO')); }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(err('connection closed', 'ECONNRESET')); };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('error', onErr); socket.off('end', onEnd); socket.off('close', onEnd);
    }
    socket.on('data', onData); socket.on('error', onErr); socket.on('end', onEnd); socket.on('close', onEnd);
    socket.resume();
  });
}

function dial(up) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: up.host, port: up.port });
    s.setNoDelay(true);
    const timer = setTimeout(() => { s.destroy(); reject(err('connect timeout', 'ETIMEDOUT')); }, TIMEOUT);
    s.once('connect', () => { clearTimeout(timer); s.removeAllListeners('error'); resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function httpConnect(up, host, port) {
  const s = await dial(up);
  try {
    const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n`;
    if (up.username || up.password) {
      req += 'Proxy-Authorization: Basic ' + Buffer.from(`${up.username || ''}:${up.password || ''}`).toString('base64') + '\r\n';
    }
    s.write(req + '\r\n');
    const head = await readUntilHeaderEnd(s);
    const m = head.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    const status = m ? +m[1] : 0;
    if (status === 200) return s;
    s.destroy();
    throw err(`Upstream proxy replied ${status || 'invalid response'}`, status === 407 ? 'AUTH' : 'CONNECT');
  } catch (e) { s.destroy(); throw e; }
}

async function socks5Connect(up, host, port) {
  const s = await dial(up);
  try {
    const hasAuth = !!(up.username || up.password);
    s.write(Buffer.from(hasAuth ? [5, 2, 0, 2] : [5, 1, 0]));
    const sel = await readBytes(s, 2);
    if (sel[0] !== 5) throw err('Not a SOCKS5 server', 'EPROTO');
    if (sel[1] === 2) {
      const u = Buffer.from(up.username || ''), p = Buffer.from(up.password || '');
      s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const a = await readBytes(s, 2);
      if (a[1] !== 0) throw err('SOCKS5 authentication failed', 'AUTH');
    } else if (sel[1] !== 0) {
      throw err('SOCKS5: no acceptable auth method', 'AUTH');
    }
    let addr;
    if (net.isIPv4(host)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
    else if (net.isIPv6(host)) {
      addr = Buffer.concat([Buffer.from([4]), ipv6ToBuf(host)]);
    } else { const h = Buffer.from(host); addr = Buffer.concat([Buffer.from([3, h.length]), h]); }
    const pb = Buffer.alloc(2); pb.writeUInt16BE(port);
    s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]));
    const hd = await readBytes(s, 4);
    if (hd[1] !== 0) throw err(`SOCKS5 connect failed (code ${hd[1]})`, 'CONNECT');
    const rest = hd[3] === 1 ? 6 : hd[3] === 4 ? 18 : (await readBytes(s, 1))[0] + 2;
    await readBytes(s, rest);
    return s;
  } catch (e) { s.destroy(); throw e; }
}

function ipv6ToBuf(ip) {
  let [h, t] = ip.split('::');
  const a = h ? h.split(':') : [], b = t ? t.split(':') : [];
  const full = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  const buf = Buffer.alloc(16);
  full.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}

function connectVia(up, host, port) {
  return up.protocol === 'socks5' ? socks5Connect(up, host, port) : httpConnect(up, host, port);
}

// Probe: succeeds if the upstream is reachable and accepts our credentials.
async function probe(up, version) {
  const target = Number(version) === 6 ? 'ipv6.google.com' : 'example.com';
  try {
    const s = await connectVia(up, target, 443);
    s.destroy();
    return { ok: true };
  } catch (e) {
    if (e.code === 'CONNECT') return { ok: true, note: e.message }; // reachable + authenticated, target refused
    return { ok: false, code: e.code || 'ERR', message: e.message };
  }
}

module.exports = { connectVia, probe, dial };
