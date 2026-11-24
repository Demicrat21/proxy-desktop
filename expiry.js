'use strict';
// Desktop replacement for the Android "proxy is about to expire" notifications.
const fs = require('fs');

// Reminders: 3 days before, 1 day before, and once when it has expired.
const T = {
  ru: {
    title: 'Proxy6',
    soon: (n, d) => `Прокси ${n} истекает ${d}`,
    today: (n) => `Прокси ${n} истекает сегодня`,
    expired: (n) => `Срок прокси ${n} истёк`,
  },
  en: {
    title: 'Proxy6',
    soon: (n, d) => `Proxy ${n} expires on ${d}`,
    today: (n) => `Proxy ${n} expires today`,
    expired: (n) => `Proxy ${n} has expired`,
  },
};

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

class ExpiryNotifier {
  constructor(file, notify) { this.file = file; this.notify = notify; this.state = { lang: 'ru', proxies: [], sent: {} }; this.timer = null; this._load(); }
  _load() { try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (_) {} }
  _save() { try { fs.writeFileSync(this.file, JSON.stringify(this.state)); } catch (_) {} }

  sync({ lang, proxies }) {
    this.state.lang = lang === 'en' ? 'en' : 'ru';
    this.state.proxies = Array.isArray(proxies) ? proxies : [];
    this._save(); this.check();
  }
  clear() { this.state = { lang: this.state.lang, proxies: [], sent: {} }; this._save(); }

  start() { this.stop(); this.timer = setInterval(() => this.check(), 30 * 60 * 1000); this.timer.unref && this.timer.unref(); this.check(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  check(now = new Date()) {
    const t = T[this.state.lang] || T.ru;
    for (const p of this.state.proxies) {
      const end = parseDate(p.dateEnd); if (!end) continue;
      const msLeft = end - now; const daysLeft = msLeft / 86400000;
      let level = null;
      if (msLeft <= 0) level = -1; else if (daysLeft <= 1) level = 1; else if (daysLeft <= 3) level = 3;
      if (level === null) continue;
      const key = `${p.id}:${p.dateEnd}:${level}`;
      if (this.state.sent[key]) continue;
      this.state.sent[key] = Date.now();
      const name = `${p.country ? p.country.toUpperCase() + ' · ' : ''}${p.host || p.ip || p.id}`;
      const sameDay = end.toDateString() === now.toDateString();
      const body = level === -1 ? t.expired(name) : sameDay ? t.today(name) : t.soon(name, end.toLocaleDateString(this.state.lang === 'ru' ? 'ru-RU' : 'en-GB'));
      this.notify(t.title, body);
    }
    const ids = new Set(this.state.proxies.map((p) => `${p.id}:${p.dateEnd}:`));
    for (const k of Object.keys(this.state.sent)) if (![...ids].some((i) => k.startsWith(i))) delete this.state.sent[k];
    this._save();
  }
}

module.exports = { ExpiryNotifier, parseDate };
