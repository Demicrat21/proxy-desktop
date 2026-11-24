'use strict';
// Windows system proxy (WinINET / "Settings → Network → Proxy") management with crash-safe restore.
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const isWin = process.platform === 'win32';
const REG = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe') : 'reg';
const NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'];
const BYPASS = '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;169.254.*';

function parseRegQuery(out, name) {
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/);
    if (m && m[1].toLowerCase() === name.toLowerCase()) {
      return { type: m[2], value: m[2] === 'REG_DWORD' ? String(parseInt(m[3], 16)) : m[3].trim() };
    }
  }
  return null;
}

function regGet(name) {
  try { return parseRegQuery(execFileSync(REG, ['query', KEY, '/v', name], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), name); }
  catch (_) { return null; }
}
function regSet(name, type, value) {
  execFileSync(REG, ['add', KEY, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true, stdio: 'ignore' });
}
function regDel(name) {
  try { execFileSync(REG, ['delete', KEY, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
}

const PS = '$s=\'[DllImport("wininet.dll",SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);\';' +
  '$t=Add-Type -MemberDefinition $s -Name W -Namespace N -PassThru;' +
  '$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null';
const PSARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', PS];

function refresh(sync) {
  if (!isWin) return;
  try {
    if (sync) execFileSync('powershell.exe', PSARGS, { windowsHide: true, stdio: 'ignore', timeout: 8000 });
    else execFile('powershell.exe', PSARGS, { windowsHide: true, timeout: 8000 }, () => {});
  } catch (_) {}
}

class SystemProxy {
  constructor(backupFile) { this.backupFile = backupFile; }

  get supported() { return isWin; }

  enable(hostPort) {
    if (!isWin) return { supported: false };
    if (!fs.existsSync(this.backupFile)) { // keep the ORIGINAL settings across reconnects
      const prev = {};
      for (const n of NAMES) prev[n] = regGet(n);
      fs.writeFileSync(this.backupFile, JSON.stringify({ prev, ours: hostPort }));
    }
    regSet('ProxyServer', 'REG_SZ', hostPort);
    regSet('ProxyOverride', 'REG_SZ', BYPASS);
    regSet('ProxyEnable', 'REG_DWORD', 1);
    regDel('AutoConfigURL');
    refresh(false);
    return { supported: true };
  }

  // sync=true on app exit. Safe to call any time (also used to recover after a crash).
  restore(sync) {
    if (!isWin || !fs.existsSync(this.backupFile)) return false;
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(this.backupFile, 'utf8')).prev || {}; } catch (_) {}
    for (const n of NAMES) {
      const v = prev[n];
      if (v && v.value !== undefined && v.value !== '') regSet(n, v.type, v.value);
      else if (n === 'ProxyEnable') regSet(n, 'REG_DWORD', 0);
      else regDel(n);
    }
    try { fs.unlinkSync(this.backupFile); } catch (_) {}
    refresh(!!sync);
    return true;
  }
}

module.exports = { SystemProxy, parseRegQuery };
