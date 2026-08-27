/**
 * chart.js — กราฟแท่งเทียนวาดเองบน Canvas (ไม่พึ่งไลบรารีภายนอก)
 * รองรับ: EMA, Bollinger, แนวรับ-ต้าน, จุดสัญญาณ, เส้นแผนเทรด (Entry/SL/TP),
 *         แผงย่อย Volume / RSI / MACD, crosshair, ซูมด้วยลูกกลิ้ง, ลากเลื่อน
 */

const COL = {
  bg: '#0b1020', grid: 'rgba(148,163,184,0.10)', text: '#94a3b8', textStrong: '#e2e8f0',
  up: '#22c55e', down: '#ef4444', upFill: 'rgba(34,197,94,0.85)', downFill: 'rgba(239,68,68,0.85)',
  ema20: '#facc15', ema50: '#38bdf8', ema200: '#f472b6',
  bb: 'rgba(148,163,184,0.35)', bbFill: 'rgba(56,189,248,0.05)',
  sup: 'rgba(34,197,94,0.55)', res: 'rgba(239,68,68,0.55)',
  entry: '#e2e8f0', sl: '#ef4444', tp: '#22c55e', vwap: '#a78bfa',
  cross: 'rgba(226,232,240,0.45)',
};

export class Chart {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.candles = [];
    this.ind = null;
    this.setup = null;
    this.markers = [];
    this.view = { count: 140, offset: 0 }; // offset = จำนวนแท่งที่เลื่อนถอยจากขวาสุด
    this.panels = { volume: true, rsi: true, macd: true };
    this.mouse = null;
    this.drag = null;
    this.showLevels = true;
    this.showBB = true;
    this._bind();
  }

  _bind() {
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = Math.sign(e.deltaY);
      const next = Math.round(this.view.count * (dir > 0 ? 1.15 : 0.87));
      this.view.count = Math.max(30, Math.min(600, next));
      this.render();
    }, { passive: false });

    cv.addEventListener('mousedown', (e) => { this.drag = { x: e.offsetX, offset: this.view.offset }; });
    window.addEventListener('mouseup', () => { this.drag = null; });
    cv.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY };
      if (this.drag) {
        const bw = this.plot ? this.plot.barW : 6;
        const shift = Math.round((e.offsetX - this.drag.x) / bw);
        this.view.offset = Math.max(0, Math.min(this.candles.length - 20, this.drag.offset + shift));
      }
      this.render();
    });
    cv.addEventListener('mouseleave', () => { this.mouse = null; this.render(); });

    // สัมผัสบนมือถือ: ลากเพื่อเลื่อนกราฟ
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) this.drag = { x: e.touches[0].clientX - cv.getBoundingClientRect().left, offset: this.view.offset };
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
      if (this.drag && e.touches.length === 1) {
        const x = e.touches[0].clientX - cv.getBoundingClientRect().left;
        const bw = this.plot ? this.plot.barW : 6;
        this.view.offset = Math.max(0, Math.min(this.candles.length - 20, this.drag.offset + Math.round((x - this.drag.x) / bw)));
        this.render();
      }
    }, { passive: true });
    cv.addEventListener('touchend', () => { this.drag = null; });
  }

  setData({ candles, ind, setup, markers, levels }) {
    if (candles) this.candles = candles;
    if (ind !== undefined) this.ind = ind;
    if (setup !== undefined) this.setup = setup;
    if (markers !== undefined) this.markers = markers || [];
    if (levels !== undefined) this.levels = levels || [];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    this.cv.width = Math.max(320, r.width * dpr);
    this.cv.height = Math.max(280, r.height * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width; this.H = r.height;
    this.render();
  }

  render() {
    const g = this.g;
    if (!this.W) this.resize();
    const W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, W, H);
    if (!this.candles.length) {
      g.fillStyle = COL.text; g.font = '14px system-ui'; g.textAlign = 'center';
      g.fillText('กำลังโหลดข้อมูล…', W / 2, H / 2);
      return;
    }

    const padR = 62, padL = 6, padT = 8, padB = 22;
    const sub = [];
    if (this.panels.volume) sub.push({ key: 'volume', h: 0.10 });
    if (this.panels.rsi) sub.push({ key: 'rsi', h: 0.15 });
    if (this.panels.macd) sub.push({ key: 'macd', h: 0.15 });
    const subTotal = sub.reduce((a, s) => a + s.h, 0);
    const usableH = H - padT - padB;
    const priceH = usableH * (1 - subTotal);

    const n = this.candles.length;
    const end = Math.max(20, n - this.view.offset);
    const start = Math.max(0, end - this.view.count);
    const vis = this.candles.slice(start, end);
    const plotW = W - padL - padR;
    const barW = plotW / Math.max(1, vis.length);
    this.plot = { start, end, barW, padL, padR, padT, priceH, plotW };

    // ── สเกลราคา ────────────────────────────────────────────────────────
    let min = Infinity, max = -Infinity;
    for (const c of vis) { if (c.l < min) min = c.l; if (c.h > max) max = c.h; }
    const addRange = (v) => { if (v === null || v === undefined || Number.isNaN(v)) return; if (v < min) min = v; if (v > max) max = v; };
    if (this.ind && this.showBB) for (let i = start; i < end; i++) { addRange(this.ind.bb.upper[i]); addRange(this.ind.bb.lower[i]); }
    if (this.setup) [this.setup.entry, this.setup.sl, this.setup.tp1, this.setup.tp2, this.setup.tp3].forEach(addRange);
    const pad = (max - min) * 0.08 || 1;
    min -= pad; max += pad;
    const yP = (p) => padT + ((max - p) / (max - min)) * priceH;
    const xI = (i) => padL + (i - start + 0.5) * barW;
    this.yP = yP; this.xI = xI; this.min = min; this.max = max;

    // ── เส้นกริดและแกนราคา ──────────────────────────────────────────────
    g.font = '11px ui-monospace, monospace';
    g.textAlign = 'left';
    const steps = 6;
    for (let s = 0; s <= steps; s++) {
      const p = min + ((max - min) * s) / steps;
      const y = yP(p);
      g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.fillStyle = COL.text;
      g.fillText(p.toFixed(2), W - padR + 6, y + 3.5);
    }

    // ── Bollinger ───────────────────────────────────────────────────────
    if (this.ind && this.showBB) {
      this._line(this.ind.bb.upper, start, end, COL.bb, 1);
      this._line(this.ind.bb.lower, start, end, COL.bb, 1);
      this._line(this.ind.bb.mid, start, end, 'rgba(148,163,184,0.5)', 1, [4, 4]);
    }

    // ── แนวรับ/แนวต้าน ─────────────────────────────────────────────────
    if (this.showLevels && this.levels) {
      const drawn = [];
      for (const lv of this.levels) {
        if (lv.price < min || lv.price > max) continue;
        const y = yP(lv.price);
        g.strokeStyle = lv.type === 'support' ? COL.sup : COL.res;
        g.lineWidth = Math.min(2.5, 0.6 + lv.touches * 0.35);
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
        g.setLineDash([]);
        // ป้ายกำกับ: วางชิดขวา และข้ามป้ายที่จะทับกับป้ายก่อนหน้า
        if (drawn.some((yy) => Math.abs(yy - y) < 13)) continue;
        drawn.push(y);
        // ป้ายแนวรับ/ต้านวางชิดซ้าย ส่วนป้ายแผนเทรด (Entry/SL/TP) อยู่ชิดขวา จะได้ไม่ทับกัน
        g.fillStyle = lv.type === 'support' ? COL.sup : COL.res;
        g.font = '10px system-ui';
        g.fillText(`${lv.type === 'support' ? 'รับ' : 'ต้าน'} ${lv.price.toFixed(2)} · แตะ ${lv.touches} ครั้ง`, padL + 5, y - 3);
      }
    }

    // ── แท่งเทียน ───────────────────────────────────────────────────────
    const bodyW = Math.max(1, barW * 0.62);
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      const x = xI(i);
      const up = c.c >= c.o;
      g.strokeStyle = up ? COL.up : COL.down;
      g.lineWidth = Math.max(1, barW * 0.1);
      g.beginPath(); g.moveTo(x, yP(c.h)); g.lineTo(x, yP(c.l)); g.stroke();
      const yo = yP(c.o), yc = yP(c.c);
      g.fillStyle = up ? COL.upFill : COL.downFill;
      g.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
    }

    // ── เส้นค่าเฉลี่ย ───────────────────────────────────────────────────
    if (this.ind) {
      this._line(this.ind.ema20, start, end, COL.ema20, 1.4);
      this._line(this.ind.ema50, start, end, COL.ema50, 1.4);
      this._line(this.ind.ema200, start, end, COL.ema200, 1.6);
      if (this.panels.vwap !== false) this._line(this.ind.vwap, start, end, COL.vwap, 1, [3, 3]);
    }

    // ── แผนเทรดปัจจุบัน ────────────────────────────────────────────────
    if (this.setup) {
      const rows = [
        { p: this.setup.tp3, c: COL.tp, label: `TP3 ${this.setup.tp3.toFixed(2)}` },
        { p: this.setup.tp2, c: COL.tp, label: `TP2 ${this.setup.tp2.toFixed(2)}` },
        { p: this.setup.tp1, c: COL.tp, label: `TP1 ${this.setup.tp1.toFixed(2)}` },
        { p: this.setup.entry, c: COL.entry, label: `เข้า ${this.setup.entry.toFixed(2)}` },
        { p: this.setup.sl, c: COL.sl, label: `SL ${this.setup.sl.toFixed(2)}` },
      ];
      // แรเงาโซนกำไร/ขาดทุน
      const yEntry = yP(this.setup.entry);
      g.fillStyle = 'rgba(34,197,94,0.07)';
      g.fillRect(padL, Math.min(yEntry, yP(this.setup.tp2)), plotW, Math.abs(yP(this.setup.tp2) - yEntry));
      g.fillStyle = 'rgba(239,68,68,0.09)';
      g.fillRect(padL, Math.min(yEntry, yP(this.setup.sl)), plotW, Math.abs(yP(this.setup.sl) - yEntry));
      for (const r of rows) {
        if (r.p < min || r.p > max) continue;
        const y = yP(r.p);
        g.strokeStyle = r.c; g.lineWidth = 1; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
        g.setLineDash([]);
        g.fillStyle = r.c; g.font = '10px ui-monospace, monospace';
        g.textAlign = 'right';
        g.fillText(r.label, W - padR - 4, y - 3);
        g.textAlign = 'left';
      }
    }

    // ── จุดสัญญาณย้อนหลัง ───────────────────────────────────────────────
    for (const m of this.markers) {
      if (m.index < start || m.index >= end) continue;
      const c = this.candles[m.index];
      const x = xI(m.index);
      const y = m.side > 0 ? yP(c.l) + 12 : yP(c.h) - 12;
      g.fillStyle = m.side > 0 ? COL.up : COL.down;
      g.beginPath();
      if (m.side > 0) { g.moveTo(x, y - 9); g.lineTo(x - 5, y); g.lineTo(x + 5, y); }
      else { g.moveTo(x, y + 9); g.lineTo(x - 5, y); g.lineTo(x + 5, y); }
      g.closePath(); g.fill();
    }

    // ── เส้นราคาปัจจุบัน ────────────────────────────────────────────────
    const last = this.candles[n - 1];
    const yLast = yP(last.c);
    if (yLast > padT && yLast < padT + priceH) {
      g.strokeStyle = last.c >= last.o ? COL.up : COL.down;
      g.setLineDash([5, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, yLast); g.lineTo(W - padR, yLast); g.stroke();
      g.setLineDash([]);
      g.fillStyle = last.c >= last.o ? COL.up : COL.down;
      g.fillRect(W - padR + 2, yLast - 8, padR - 4, 16);
      g.fillStyle = '#0b1020'; g.font = 'bold 11px ui-monospace, monospace';
      g.fillText(last.c.toFixed(2), W - padR + 5, yLast + 3.5);
    }

    // ── แผงย่อย ────────────────────────────────────────────────────────
    let y0 = padT + priceH;
    for (const s of sub) {
      const h = usableH * s.h;
      this._drawSub(s.key, y0, h, start, end, padL, W - padR);
      y0 += h;
    }

    // ── แกนเวลา ────────────────────────────────────────────────────────
    g.fillStyle = COL.text; g.font = '10px system-ui'; g.textAlign = 'center';
    const tickEvery = Math.max(1, Math.floor(vis.length / 7));
    for (let i = start; i < end; i += tickEvery) {
      const d = new Date(this.candles[i].t);
      const lbl = d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const x = Math.max(padL + g.measureText(lbl).width / 2, Math.min(W - padR - g.measureText(lbl).width / 2, xI(i)));
      g.fillText(lbl, x, H - 7);
    }
    g.textAlign = 'left';

    if (this.mouse) this._crosshair(padL, W - padR, padT, H - padB);
  }

  _line(series, start, end, color, width = 1, dash = null) {
    const g = this.g;
    g.strokeStyle = color; g.lineWidth = width;
    if (dash) g.setLineDash(dash);
    g.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      const v = series[i];
      if (v === null || v === undefined) { started = false; continue; }
      const x = this.xI(i), y = this.yP(v);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();
    if (dash) g.setLineDash([]);
  }

  _drawSub(key, top, h, start, end, x0, x1) {
    const g = this.g;
    g.strokeStyle = COL.grid;
    g.beginPath(); g.moveTo(x0, top); g.lineTo(x1, top); g.stroke();
    g.fillStyle = COL.text; g.font = '10px system-ui';
    const inner = h - 10;
    const barW = this.plot.barW;

    if (key === 'volume') {
      let vmax = 0;
      for (let i = start; i < end; i++) vmax = Math.max(vmax, this.candles[i].v);
      for (let i = start; i < end; i++) {
        const c = this.candles[i];
        const bh = vmax ? (c.v / vmax) * inner : 0;
        g.fillStyle = c.c >= c.o ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)';
        g.fillRect(this.xI(i) - barW * 0.31, top + h - bh - 4, Math.max(1, barW * 0.62), bh);
      }
      g.fillStyle = COL.text; g.fillText('Volume', x0 + 4, top + 11);
      return;
    }

    if (key === 'rsi' && this.ind) {
      const y = (v) => top + 6 + ((100 - v) / 100) * inner;
      for (const lvl of [70, 50, 30]) {
        g.strokeStyle = lvl === 50 ? COL.grid : 'rgba(148,163,184,0.25)';
        g.setLineDash(lvl === 50 ? [] : [3, 4]);
        g.beginPath(); g.moveTo(x0, y(lvl)); g.lineTo(x1, y(lvl)); g.stroke();
        g.setLineDash([]);
        g.fillStyle = COL.text; g.fillText(String(lvl), x1 + 4, y(lvl) + 3);
      }
      g.strokeStyle = '#c084fc'; g.lineWidth = 1.3; g.beginPath();
      let st = false;
      for (let i = start; i < end; i++) {
        const v = this.ind.rsi[i];
        if (v === null) { st = false; continue; }
        const px = this.xI(i), py = y(v);
        if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
      }
      g.stroke();
      const lastRsi = this.ind.rsi[end - 1];
      g.fillStyle = COL.text;
      g.fillText(`RSI(14) ${lastRsi !== null ? lastRsi.toFixed(1) : '-'}`, x0 + 4, top + 11);
      return;
    }

    if (key === 'macd' && this.ind) {
      let mmax = 1e-9;
      for (let i = start; i < end; i++) {
        for (const v of [this.ind.macd.line[i], this.ind.macd.signal[i], this.ind.macd.hist[i]]) {
          if (v !== null) mmax = Math.max(mmax, Math.abs(v));
        }
      }
      const y = (v) => top + 6 + inner / 2 - (v / mmax) * (inner / 2);
      g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(x0, y(0)); g.lineTo(x1, y(0)); g.stroke();
      for (let i = start; i < end; i++) {
        const hv = this.ind.macd.hist[i];
        if (hv === null) continue;
        const prev = this.ind.macd.hist[i - 1];
        const rising = prev === null ? true : hv > prev;
        g.fillStyle = hv >= 0 ? (rising ? 'rgba(34,197,94,0.8)' : 'rgba(34,197,94,0.35)')
                              : (rising ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.8)');
        const yy = y(hv), y0v = y(0);
        g.fillRect(this.xI(i) - barW * 0.28, Math.min(yy, y0v), Math.max(1, barW * 0.56), Math.abs(yy - y0v));
      }
      const drawL = (series, color) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
        let st = false;
        for (let i = start; i < end; i++) {
          const v = series[i];
          if (v === null) { st = false; continue; }
          const px = this.xI(i), py = y(v);
          if (!st) { g.moveTo(px, py); st = true; } else g.lineTo(px, py);
        }
        g.stroke();
      };
      drawL(this.ind.macd.line, '#38bdf8');
      drawL(this.ind.macd.signal, '#fb923c');
      g.fillStyle = COL.text; g.fillText('MACD(12,26,9)', x0 + 4, top + 11);
    }
  }

  _crosshair(x0, x1, y0, y1) {
    const g = this.g;
    const { x, y } = this.mouse;
    if (x < x0 || x > x1) return;
    const i = Math.round((x - this.plot.padL) / this.plot.barW - 0.5) + this.plot.start;
    if (i < 0 || i >= this.candles.length) return;
    const c = this.candles[i];
    g.strokeStyle = COL.cross; g.setLineDash([3, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(this.xI(i), y0); g.lineTo(this.xI(i), y1); g.stroke();
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.setLineDash([]);

    const price = this.min + ((y1 - y - (y1 - y0) * 0) / 1) * 0; // ป้ายราคาตามแกน Y
    const yy = Math.max(this.plot.padT, Math.min(this.plot.padT + this.plot.priceH, y));
    const pv = this.max - ((yy - this.plot.padT) / this.plot.priceH) * (this.max - this.min);
    g.fillStyle = 'rgba(226,232,240,0.9)';
    g.fillRect(x1 + 2, yy - 8, 58, 16);
    g.fillStyle = '#0b1020'; g.font = '11px ui-monospace, monospace';
    g.fillText(pv.toFixed(2), x1 + 5, yy + 3.5);
    void price;

    // กล่องข้อมูลแท่ง
    const txt = [
      new Date(c.t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }),
      `O ${c.o.toFixed(2)}  H ${c.h.toFixed(2)}`,
      `L ${c.l.toFixed(2)}  C ${c.c.toFixed(2)}`,
      `เปลี่ยน ${(((c.c - c.o) / c.o) * 100).toFixed(2)}%`,
    ];
    if (this.ind && this.ind.rsi[i] !== null) txt.push(`RSI ${this.ind.rsi[i].toFixed(1)}`);
    g.font = '11px system-ui';
    const w = Math.max(...txt.map((t) => g.measureText(t).width)) + 14;
    const bx = Math.min(x + 12, x1 - w), by = Math.max(y0 + 4, y - 70);
    g.fillStyle = 'rgba(2,6,23,0.92)';
    g.strokeStyle = 'rgba(148,163,184,0.3)';
    g.beginPath(); g.roundRect(bx, by, w, txt.length * 15 + 10, 6); g.fill(); g.stroke();
    g.fillStyle = COL.textStrong;
    txt.forEach((t, k) => g.fillText(t, bx + 7, by + 18 + k * 15));
  }

  scrollToEnd() { this.view.offset = 0; this.render(); }
}
