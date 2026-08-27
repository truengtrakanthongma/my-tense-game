/**
 * alerts.js — ระบบแจ้งเตือน: เสียง + แจ้งเตือนเบราว์เซอร์ + พูดไทย + Webhook (Discord ฯลฯ)
 * และ "กฎเตือนส่วนตัว" เช่น ราคาทะลุ 3400 หรือ RSI ต่ำกว่า 30
 */

const LS_KEY = 'goldtrader.alerts.v1';

export class AlertCenter {
  constructor() {
    this.log = [];
    this.rules = [];
    this.sound = true;
    this.speak = false;
    this.desktop = false;
    this.webhookUrl = '';
    this.cooldownMs = 5 * 60 * 1000;
    this._lastSignalAt = 0;
    this._lastSignalSide = 0;
    this.audioCtx = null;
    this.onUpdate = () => {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      this.log = raw.log || [];
      this.rules = raw.rules || [];
      this.sound = raw.sound !== false;
      this.speak = !!raw.speak;
      this.desktop = !!raw.desktop;
      this.webhookUrl = raw.webhookUrl || '';
      this.cooldownMs = raw.cooldownMs || this.cooldownMs;
    } catch (e) { /* เริ่มใหม่ถ้าอ่านไม่ได้ */ }
  }

  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        log: this.log.slice(0, 200), rules: this.rules, sound: this.sound,
        speak: this.speak, desktop: this.desktop, webhookUrl: this.webhookUrl, cooldownMs: this.cooldownMs,
      }));
    } catch (e) { /* โควตาเต็มก็ข้าม */ }
  }

  async requestDesktopPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') { this.desktop = true; this.save(); return 'granted'; }
    const res = await Notification.requestPermission();
    this.desktop = res === 'granted';
    this.save();
    return res;
  }

  /** เล่นเสียงเตือน — ซื้อ = โทนไล่ขึ้น, ขาย = โทนไล่ลง, เตือนทั่วไป = ปี๊บสั้น */
  playSound(kind = 'info') {
    if (!this.sound) return;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const seq = kind === 'buy' ? [523, 659, 784] : kind === 'sell' ? [784, 659, 440] : [880, 880];
      seq.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const t0 = ctx.currentTime + i * 0.16;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.16);
      });
    } catch (e) { /* เบราว์เซอร์บล็อกเสียงก่อนผู้ใช้กดจอ */ }
  }

  saySomething(text) {
    if (!this.speak || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'th-TH';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (e) { /* ไม่มีเสียงไทยก็ข้าม */ }
  }

  async sendWebhook(payload) {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: payload.text, username: 'Gold Signal Bot', ...payload.extra }),
      });
    } catch (e) { /* ปลายทางบล็อก CORS ก็ไม่ต้องรบกวนผู้ใช้ */ }
  }

  /** ยิงแจ้งเตือน 1 รายการ (บันทึกลง log + เสียง + desktop + webhook) */
  fire({ kind = 'info', title, body, price, score, meta }) {
    const entry = { id: Date.now() + Math.random(), ts: Date.now(), kind, title, body, price, score, meta };
    this.log.unshift(entry);
    this.log = this.log.slice(0, 200);
    this.save();
    this.playSound(kind === 'buy' || kind === 'sell' ? kind : 'info');
    if (kind === 'buy') this.saySomething('สัญญาณซื้อทองคำ');
    if (kind === 'sell') this.saySomething('สัญญาณขายทองคำ');
    if (this.desktop && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag: 'gold-' + kind, silent: false }); } catch (e) { /* ignore */ }
    }
    this.sendWebhook({ text: `**${title}**\n${body}` });
    this.onUpdate(entry);
    return entry;
  }

  /** กันเตือนรัว: สัญญาณทิศเดิมต้องเว้นระยะตาม cooldown */
  shouldFireSignal(side) {
    const now = Date.now();
    if (side === this._lastSignalSide && now - this._lastSignalAt < this.cooldownMs) return false;
    this._lastSignalAt = now;
    this._lastSignalSide = side;
    return true;
  }

  resetCooldown() { this._lastSignalAt = 0; this._lastSignalSide = 0; }

  addRule(rule) {
    this.rules.push({ id: Date.now() + Math.random(), active: true, ...rule });
    this.save();
  }

  removeRule(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * ตรวจกฎเตือนส่วนตัวกับสถานะล่าสุด
   * @param {{price:number, rsi:number, score:number}} state
   */
  checkRules(state) {
    for (const r of this.rules) {
      if (!r.active) continue;
      let hit = false, label = '';
      if (r.type === 'price_above' && state.price >= r.value) { hit = true; label = `ราคาทะลุขึ้นเหนือ ${r.value}`; }
      if (r.type === 'price_below' && state.price <= r.value) { hit = true; label = `ราคาหลุดลงต่ำกว่า ${r.value}`; }
      if (r.type === 'rsi_above' && state.rsi !== null && state.rsi >= r.value) { hit = true; label = `RSI ขึ้นเหนือ ${r.value} (ตอนนี้ ${state.rsi.toFixed(1)})`; }
      if (r.type === 'rsi_below' && state.rsi !== null && state.rsi <= r.value) { hit = true; label = `RSI ลงต่ำกว่า ${r.value} (ตอนนี้ ${state.rsi.toFixed(1)})`; }
      if (!hit) continue;
      if (r.lastFired && Date.now() - r.lastFired < 60000) continue;
      r.lastFired = Date.now();
      if (r.once) r.active = false;
      this.fire({ kind: 'rule', title: '🔔 กฎเตือนส่วนตัวทำงาน', body: `${label} · ราคาปัจจุบัน ${state.price.toFixed(2)}`, price: state.price });
      this.save();
    }
  }

  clearLog() { this.log = []; this.save(); }
}
