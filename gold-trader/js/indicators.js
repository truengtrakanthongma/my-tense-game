/**
 * indicators.js — ตัวชี้วัดทางเทคนิค (pure functions)
 *
 * กติกาสำคัญ: ทุกฟังก์ชันเป็น "causal" คือค่าที่ index i คำนวณจากข้อมูล 0..i เท่านั้น
 * ห้ามมองอนาคต (no look-ahead) เพราะ backtest กับสัญญาณสดใช้โค้ดชุดเดียวกัน
 * ผลลัพธ์เป็น array ยาวเท่าอินพุตเสมอ ช่วง warm-up เป็น null
 */

export const nz = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? d : v);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(v)) { sum = 0; continue; }
    sum += v;
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (RMA) — ใช้ใน RSI / ATR / ADX */
export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += nz(values[i]);
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + nz(values[i])) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const ch = values[i] - values[i - 1];
    gains[i] = ch > 0 ? ch : 0;
    losses[i] = ch < 0 ? -ch : 0;
  }
  // seed ที่ index = period
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) { avgG += gains[i]; avgL += losses[i]; }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < n; i++) {
    avgG = (avgG * (period - 1) + gains[i]) / period;
    avgL = (avgL * (period - 1) + losses[i]) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalP = 9) {
  const emaF = ema(values, fast);
  const emaS = ema(values, slow);
  const line = values.map((_, i) => (emaF[i] === null || emaS[i] === null ? null : emaF[i] - emaS[i]));
  const firstValid = line.findIndex((v) => v !== null);
  const sig = new Array(values.length).fill(null);
  const hist = new Array(values.length).fill(null);
  if (firstValid >= 0) {
    const compact = line.slice(firstValid).map((v) => nz(v));
    const sigCompact = ema(compact, signalP);
    for (let i = 0; i < sigCompact.length; i++) {
      const idx = i + firstValid;
      sig[idx] = sigCompact[i];
      if (sigCompact[i] !== null && line[idx] !== null) hist[idx] = line[idx] - sigCompact[i];
    }
  }
  return { line, signal: sig, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const n = values.length;
  const mid = sma(values, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const width = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : null;
    const range = upper[i] - lower[i];
    pctB[i] = range === 0 ? 0.5 : (values[i] - lower[i]) / range;
  }
  return { mid, upper, lower, width, pctB };
}

export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
}

export function atr(candles, period = 14) {
  return rma(trueRange(candles), period);
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3, smoothK = 3) {
  const n = candles.length;
  const raw = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    raw[i] = hh === ll ? 50 : ((candles[i].c - ll) / (hh - ll)) * 100;
  }
  const kLine = smoothK > 1 ? smoothNulls(raw, smoothK) : raw;
  const dLine = smoothNulls(kLine, dPeriod);
  return { k: kLine, d: dLine };
}

function smoothNulls(values, period) {
  const out = new Array(values.length).fill(null);
  const buf = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    buf.push(values[i]);
    if (buf.length > period) buf.shift();
    if (buf.length === period) out[i] = buf.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

/** ADX + Directional Index — วัด "ความแรงของเทรนด์" */
export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(candles), period);
  const pDM = rma(plusDM, period);
  const mDM = rma(minusDM, period);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (tr[i] === null || tr[i] === 0 || pDM[i] === null) continue;
    plusDI[i] = (pDM[i] / tr[i]) * 100;
    minusDI[i] = (mDM[i] / tr[i]) * 100;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
  }
  const adxLine = smoothNulls(dx, period);
  return { adx: adxLine, plusDI, minusDI };
}

export function obv(candles) {
  const out = new Array(candles.length).fill(null);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].c - candles[i - 1].c);
    acc += dir * candles[i].v;
    out[i] = acc;
  }
  return out;
}

/** VWAP รายวัน (anchor ที่ต้นวัน UTC) — ราคาเฉลี่ยถ่วงน้ำหนักปริมาณ */
export function vwapDaily(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].t).getUTCDate();
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const typical = (candles[i].h + candles[i].l + candles[i].c) / 3;
    pv += typical * candles[i].v;
    vol += candles[i].v;
    out[i] = vol > 0 ? pv / vol : candles[i].c;
  }
  return out;
}

/** ความชันของเส้น (normalize เป็น % ต่อแท่ง) ใช้บอกว่าเทรนด์ "กำลังเร่ง" หรือ "แผ่ว" */
export function slopePct(values, lookback = 5) {
  const out = new Array(values.length).fill(null);
  for (let i = lookback; i < values.length; i++) {
    const a = values[i - lookback], b = values[i];
    if (a === null || b === null || a === 0) continue;
    out[i] = ((b - a) / Math.abs(a)) * 100 / lookback;
  }
  return out;
}

export function highest(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function lowest(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

/** ส่วนเบี่ยงเบนมาตรฐานของผลตอบแทน (annualise ไม่ได้เพราะ TF ต่างกัน) */
export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  const m = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}
