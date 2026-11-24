'use strict';
// Domain routing rules — same semantics as the mobile app:
// rules are applied top-down, first match wins, default action = "proxy".
// Host entries: "vk.com" (exact), "*.vk.com" / ".ru" (subdomains), "1.2.3.0/24", "1.2.3.4", any glob with "*".

const { domainToASCII } = require('url');
const net = require('net');

function normHost(h) {
  let s = String(h || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^.*@/, '');
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  else if (/^[^:]+:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  s = s.replace(/\.$/, '');
  if (s && /[^\x00-\x7f]/.test(s.replace(/^\*\./, ''))) {
    const pre = s.startsWith('*.') ? '*.' : '';
    s = pre + (domainToASCII(s.replace(/^\*\./, '')) || s);
  }
  return s;
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function compileEntry(raw) {
  const cidr = String(raw || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr && net.isIPv4(cidr[1]) && +cidr[2] <= 32) {
    const bits = +cidr[2];
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    const base = (ipv4ToInt(cidr[1]) & mask) >>> 0;
    return (h) => net.isIPv4(h) && ((ipv4ToInt(h) & mask) >>> 0) === base;
  }
  const e = normHost(raw);
  if (!e) return null;
  if (e.startsWith('.')) { const suf = e; const bare = e.slice(1); return (h) => h.endsWith(suf) || h === bare; }
  if (e.includes('*')) {
    const re = new RegExp('^' + e.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return (h) => re.test(h);
  }
  return (h) => h === e;
}

function isPrivateOrLocal(h) {
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv6(h)) return h === '::1' || /^f[cd]/.test(h) || /^fe80/.test(h);
  if (!net.isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function compileRules(domainRules) {
  const compiled = (Array.isArray(domainRules) ? domainRules : []).map((r) => ({
    action: r && r.action === 'proxy' ? 'proxy' : 'direct',
    tests: (Array.isArray(r && r.hosts) ? r.hosts : []).map(compileEntry).filter(Boolean),
  })).filter((r) => r.tests.length);
  return function decide(host) {
    const h = normHost(host);
    if (isPrivateOrLocal(h)) return 'direct';
    for (const r of compiled) if (r.tests.some((t) => t(h))) return r.action;
    return 'proxy';
  };
}

module.exports = { compileRules, normHost };
