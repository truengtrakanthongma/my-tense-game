/**
 * signals.js — เครื่องยนต์วิเคราะห์สัญญาณซื้อ/ขาย (Confluence Engine)
 *
 * แนวคิด: ไม่มีตัวชี้วัดตัวไหนแม่นพอด้วยตัวเอง เราจึงให้ "หลายปัจจัยโหวต"
 * แต่ละปัจจัยคืนค่า side (+1 ซื้อ / -1 ขาย / 0 ไม่ออกเสียง), strength (0-1) และ "เหตุผลภาษาไทย"
 * คะแนนรวม = ผลรวม(น้ำหนัก × ความแรง × ทิศทาง) / น้ำหนักรวม × 100  → ช่วง -100..+100
 *
 * *** สำคัญ: ฟังก์ชัน scoreAt() ใช้ทั้งตอนวิเคราะห์สดและตอน backtest ***
 * ดังนั้น "ความน่าจะเป็น" ที่แสดงบนหน้าจอ จึงเป็นสถิติของกฎชุดเดียวกันจริง ๆ
 */

import * as ta from './indicators.js';
import { detectPatterns } from './patterns.js';
import { findPivots, clusterLevels, nearestLevels, marketStructure, rsiDivergence, nearestRound } from './levels.js';

export const DEFAULT_CFG = {
  emaFast: 20, emaMid: 50, emaSlow: 200,
  rsiPeriod: 14, atrPeriod: 14, adxPeriod: 14,
  bbPeriod: 20, bbMult: 2,
  stochK: 14, stochD: 3, stochSmooth: 3,
  pivotK: 3,
  zoneAtrMult: 0.4,   // ความกว้างของโซนแนวรับ/ต้าน เทียบกับ ATR (แคบ = โซนคมชัดขึ้น)
  slAtrMult: 1.5,
  maxSlAtrMult: 3.0,
  threshold: 35,       // คะแนนขั้นต่ำที่ถือว่าเป็นสัญญาณ
  adxTrendMin: 22,     // ADX เกินนี้ = โหมดเทรนด์, ต่ำกว่า = โหมดกรอบ
  minAtrPct: 0.02,     // ผันผวนต่ำกว่านี้ = ตลาดตาย ไม่คุ้มค่าสเปรด (%)
  maxAtrPct: 1.5,      // ผันผวนสูงกว่านี้ = ข่าวแรง/เสี่ยงเกิน (%)
};

export const WEIGHTS = {
  emaTrend: 16, adxTrend: 12, macdMom: 12, rsiMom: 10, structure: 12,
  patterns: 10, volume: 8, bands: 8, levels: 10, divergence: 10, vwap: 6, stoch: 6,
};
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

/** คำนวณ series ทั้งหมดรอบเดียว แล้ว scoreAt() แค่อ่านค่าที่ index i (เร็วและไม่มี look-ahead) */
export function buildContext(candles, cfg = DEFAULT_CFG) {
  const close = candles.map((c) => c.c);
  const vol = candles.map((c) => c.v);
  const macdRes = ta.macd(close, 12, 26, 9);
  const bb = ta.bollinger(close, cfg.bbPeriod, cfg.bbMult);
  const adxRes = ta.adx(candles, cfg.adxPeriod);
  const stochRes = ta.stochastic(candles, cfg.stochK, cfg.stochD, cfg.stochSmooth);
  const atrSeries = ta.atr(candles, cfg.atrPeriod);
  const pivots = findPivots(candles, cfg.pivotK);
  // แนวรับ/ต้านใช้ swing ที่ "ใหญ่กว่า" (มองซ้าย-ขวากว้างขึ้น) เพื่อให้ได้แนวที่มีนัยจริง
  // ส่วน pivot ชุดปกติยังใช้สำหรับวาง SL และอ่านโครงสร้างตลาด
  const majorPivots = findPivots(candles, cfg.pivotK + 3);
  // ใช้ ATR ช่วง 200 แท่งแรกกำหนดความกว้างของโซน (จำนวนคงที่ ไม่ใช่สัดส่วน)
  // เพื่อให้ค่านี้ไม่ขึ้นกับความยาวข้อมูล และไม่ดึงข้อมูลอนาคตเข้ามาเป็นพารามิเตอร์
  const warm = atrSeries.slice(0, 200).filter((v) => v !== null);
  const medianAtr = median(warm.length ? warm : atrSeries.filter((v) => v !== null)) || (close[close.length - 1] * 0.002);

  return {
    cfg, candles, close, vol,
    ema20: ta.ema(close, cfg.emaFast),
    ema50: ta.ema(close, cfg.emaMid),
    ema200: ta.ema(close, cfg.emaSlow),
    rsi: ta.rsi(close, cfg.rsiPeriod),
    macd: macdRes,
    bb,
    bbWidthLow: rollingMin(bb.width, 20),
    adx: adxRes,
    stoch: stochRes,
    atr: atrSeries,
    volSma: ta.sma(vol, 20),
    obv: ta.obv(candles),
    obvSlope: ta.slopePct(ta.obv(candles), 5),
    vwap: ta.vwapDaily(candles),
    pivots,
    zones: clusterLevels(majorPivots, medianAtr * (cfg.zoneAtrMult || 0.4)),
    majorPivots,
    ema50Slope: ta.slopePct(ta.ema(close, cfg.emaMid), 5),
  };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity, ok = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] === null) continue;
      ok = true;
      if (values[j] < m) m = values[j];
    }
    out[i] = ok ? m : null;
  }
  return out;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * ให้คะแนนที่แท่ง i (ใช้ข้อมูล 0..i เท่านั้น)
 * @returns {{score:number, side:number, factors:Array, regime:string, atrPct:number}}
 */
export function scoreAt(ctx, i) {
  const { cfg, candles } = ctx;
  const c = candles[i];
  const price = c.c;
  const atrVal = ctx.atr[i];
  const factors = [];
  if (atrVal === null || ctx.ema50[i] === null) {
    return { score: 0, side: 0, factors, regime: 'warmup', atrPct: 0, ready: false };
  }
  const atrPct = (atrVal / price) * 100;
  const adxVal = ctx.adx.adx[i];
  const regime = adxVal !== null && adxVal >= cfg.adxTrendMin ? 'trend' : 'range';

  const push = (key, name, side, strength, reason, extra = {}) => {
    if (!side || strength <= 0) return;
    factors.push({
      key, name, side, strength: clamp(strength, 0, 1), weight: WEIGHTS[key],
      contribution: WEIGHTS[key] * clamp(strength, 0, 1) * side, reason, ...extra,
    });
  };

  // ── 1) แนวโน้มจากการเรียงตัวของเส้นค่าเฉลี่ย ────────────────────────────
  const e20 = ctx.ema20[i], e50 = ctx.ema50[i], e200 = ctx.ema200[i];
  if (e20 !== null && e50 !== null) {
    const full = e200 !== null;
    if (price > e20 && e20 > e50 && (!full || e50 > e200)) {
      push('emaTrend', 'EMA Alignment', 1, full && e50 > e200 ? 1 : 0.7,
        `ราคา (${price.toFixed(2)}) ยืนเหนือ EMA20 (${e20.toFixed(2)}) > EMA50 (${e50.toFixed(2)})${full && e50 > e200 ? ` > EMA200 (${e200.toFixed(2)}) เรียงตัวสมบูรณ์` : ''} = ผู้ซื้อคุมเกมทุกกรอบเวลา`);
    } else if (price < e20 && e20 < e50 && (!full || e50 < e200)) {
      push('emaTrend', 'EMA Alignment', -1, full && e50 < e200 ? 1 : 0.7,
        `ราคา (${price.toFixed(2)}) หลุดใต้ EMA20 (${e20.toFixed(2)}) < EMA50 (${e50.toFixed(2)})${full && e50 < e200 ? ` < EMA200 (${e200.toFixed(2)}) เรียงตัวสมบูรณ์` : ''} = ผู้ขายคุมเกมทุกกรอบเวลา`);
    } else if (price > e50 && ctx.ema50Slope[i] > 0) {
      push('emaTrend', 'EMA Alignment', 1, 0.35, `ราคายืนเหนือ EMA50 และ EMA50 ยังชี้ขึ้น = เทรนด์ขาขึ้นระยะกลางยังไม่เสีย แต่ระยะสั้นยังไม่เรียงตัว`);
    } else if (price < e50 && ctx.ema50Slope[i] < 0) {
      push('emaTrend', 'EMA Alignment', -1, 0.35, `ราคาอยู่ใต้ EMA50 และ EMA50 ชี้ลง = เทรนด์ขาลงระยะกลางยังคุมอยู่`);
    }
  }

  // ── 2) ความแรงของเทรนด์ (ADX/DI) ────────────────────────────────────────
  const pDI = ctx.adx.plusDI[i], mDI = ctx.adx.minusDI[i];
  if (adxVal !== null && pDI !== null) {
    if (adxVal >= cfg.adxTrendMin) {
      const s = clamp((adxVal - 18) / 27, 0.2, 1);
      if (pDI > mDI) push('adxTrend', 'ADX / DI', 1, s, `ADX = ${adxVal.toFixed(1)} (เกิน ${cfg.adxTrendMin} = มีเทรนด์จริง) และ +DI ${pDI.toFixed(1)} > -DI ${mDI.toFixed(1)} = แรงซื้อเหนือกว่า`);
      else push('adxTrend', 'ADX / DI', -1, s, `ADX = ${adxVal.toFixed(1)} (เกิน ${cfg.adxTrendMin} = มีเทรนด์จริง) และ -DI ${mDI.toFixed(1)} > +DI ${pDI.toFixed(1)} = แรงขายเหนือกว่า`);
    }
  }

  // ── 3) โมเมนตัม MACD ────────────────────────────────────────────────────
  const h = ctx.macd.hist[i], hPrev = ctx.macd.hist[i - 1];
  if (h !== null && hPrev !== null) {
    const norm = clamp(Math.abs(h) / (atrVal * 0.6), 0, 1);
    const rising = h > hPrev;
    if (h > 0 && rising) push('macdMom', 'MACD', 1, Math.max(0.45, norm), `MACD histogram เป็นบวกและกำลังขยายตัว (${hPrev.toFixed(2)} → ${h.toFixed(2)}) = โมเมนตัมขาขึ้นกำลังเร่ง`);
    else if (h < 0 && !rising) push('macdMom', 'MACD', -1, Math.max(0.45, norm), `MACD histogram เป็นลบและกำลังขยายตัว (${hPrev.toFixed(2)} → ${h.toFixed(2)}) = โมเมนตัมขาลงกำลังเร่ง`);
    else if (h > 0 && !rising) push('macdMom', 'MACD', 1, 0.2, `MACD ยังเป็นบวกแต่เริ่มหดตัว = ขาขึ้นยังอยู่ แต่แรงส่งเริ่มแผ่ว ระวังพักฐาน`);
    else if (h < 0 && rising) push('macdMom', 'MACD', -1, 0.2, `MACD ยังเป็นลบแต่เริ่มหดตัว = ขาลงยังอยู่ แต่แรงขายเริ่มลด ระวังเด้ง`);
    if (hPrev <= 0 && h > 0) push('macdMom', 'MACD Cross', 1, 0.9, 'MACD ตัดขึ้นเหนือเส้นสัญญาณในแท่งนี้ = จุดกลับตัวโมเมนตัมฝั่งซื้อ');
    if (hPrev >= 0 && h < 0) push('macdMom', 'MACD Cross', -1, 0.9, 'MACD ตัดลงใต้เส้นสัญญาณในแท่งนี้ = จุดกลับตัวโมเมนตัมฝั่งขาย');
  }

  // ── 4) RSI (ตีความตาม regime) ───────────────────────────────────────────
  const r = ctx.rsi[i];
  if (r !== null) {
    if (regime === 'trend') {
      if (r > 55 && r < 78) push('rsiMom', 'RSI Momentum', 1, clamp((r - 50) / 25, 0, 1), `RSI = ${r.toFixed(1)} อยู่โซนแข็งแรงฝั่งซื้อ (55-78) ในตลาดมีเทรนด์ = ไปต่อได้ ไม่ใช่สัญญาณขาย`);
      else if (r < 45 && r > 22) push('rsiMom', 'RSI Momentum', -1, clamp((50 - r) / 25, 0, 1), `RSI = ${r.toFixed(1)} อยู่โซนอ่อนแรง (22-45) ในตลาดมีเทรนด์ = แรงขายยังคุม`);
      else if (r >= 78) push('rsiMom', 'RSI Overheat', -1, 0.3, `RSI = ${r.toFixed(1)} ร้อนแรงเกินไป เสี่ยงย่อพักตัว ไม่ควรไล่ราคาซื้อตรงนี้`);
      else if (r <= 22) push('rsiMom', 'RSI Oversold', 1, 0.3, `RSI = ${r.toFixed(1)} ขายมากเกินไป เสี่ยงเด้งกลับ ไม่ควรไล่ขายตรงนี้`);
    } else {
      if (r < 32) push('rsiMom', 'RSI Mean-Revert', 1, clamp((32 - r) / 20, 0.3, 1), `ตลาดออกข้าง (ADX ${adxVal ? adxVal.toFixed(1) : '-'}) + RSI = ${r.toFixed(1)} ต่ำกว่า 32 = ราคาถูกกดลงเกินไป สถิติมักเด้งกลับเข้าค่ากลาง`);
      else if (r > 68) push('rsiMom', 'RSI Mean-Revert', -1, clamp((r - 68) / 20, 0.3, 1), `ตลาดออกข้าง (ADX ${adxVal ? adxVal.toFixed(1) : '-'}) + RSI = ${r.toFixed(1)} สูงกว่า 68 = ราคาถูกดันขึ้นเกินไป สถิติมักย่อกลับ`);
    }
  }

  // ── 5) โครงสร้างตลาด (Swing HH/HL) ──────────────────────────────────────
  const ms = marketStructure(ctx.pivots, i);
  if (ms.side !== 0) push('structure', 'Market Structure', ms.side, 0.85, `โครงสร้างราคาเป็น${ms.label}: ${ms.detail}`);

  // ── 6) รูปแบบแท่งเทียน ──────────────────────────────────────────────────
  const pats = detectPatterns(candles, i, atrVal);
  const patNet = pats.reduce((a, p) => a + p.side * p.strength, 0);
  if (patNet !== 0) {
    const best = pats.filter((p) => p.side === Math.sign(patNet)).sort((a, b) => b.strength - a.strength)[0];
    push('patterns', `Price Action: ${best.name}`, Math.sign(patNet), clamp(Math.abs(patNet), 0, 1), best.reason);
  }

  // ── 7) ปริมาณการซื้อขายยืนยัน ───────────────────────────────────────────
  if (ctx.volSma[i] && ctx.vol[i] > 0) {
    const ratio = ctx.vol[i] / ctx.volSma[i];
    const dir = Math.sign(c.c - c.o);
    if (ratio > 1.25 && dir !== 0) {
      push('volume', 'Volume Confirm', dir, clamp((ratio - 1) / 1.5, 0.3, 1), `ปริมาณซื้อขายแท่งนี้สูงกว่าค่าเฉลี่ย 20 แท่ง ${ratio.toFixed(2)} เท่า และแท่งปิด${dir > 0 ? 'บวก' : 'ลบ'} = มีเงินจริงหนุนการเคลื่อนไหว ไม่ใช่การแกว่งลอย ๆ`);
    } else if (ratio < 0.6) {
      factors.push({ key: 'volume', name: 'Volume Warning', side: 0, strength: 0, weight: 0, contribution: 0,
        reason: `ปริมาณซื้อขายเบาบาง (${(ratio * 100).toFixed(0)}% ของค่าเฉลี่ย) = การเคลื่อนไหวนี้ขาดแรงยืนยัน ระวังสัญญาณหลอก` });
    }
  }

  // ── 8) Bollinger: บีบตัว-เบรกเอาต์ / ราคาสุดขอบ ─────────────────────────
  const bbU = ctx.bb.upper[i], bbL = ctx.bb.lower[i], pctB = ctx.bb.pctB[i], w = ctx.bb.width[i];
  if (bbU !== null && pctB !== null) {
    const squeeze = ctx.bbWidthLow[i] !== null && w <= ctx.bbWidthLow[i] * 1.08;
    if (squeeze && c.c > bbU) push('bands', 'BB Squeeze Breakout', 1, 0.95, `แบนด์บีบแคบสุดในรอบ 20 แท่ง (width ${w.toFixed(2)}%) แล้วราคาปิดทะลุขอบบน = พลังงานที่สะสมไว้ระเบิดออกฝั่งขึ้น`);
    else if (squeeze && c.c < bbL) push('bands', 'BB Squeeze Breakdown', -1, 0.95, `แบนด์บีบแคบสุดในรอบ 20 แท่ง (width ${w.toFixed(2)}%) แล้วราคาปิดหลุดขอบล่าง = พลังงานที่สะสมไว้ระเบิดออกฝั่งลง`);
    else if (regime === 'range' && pctB <= 0.05) push('bands', 'BB Lower Band', 1, 0.7, `ราคาแตะขอบล่าง Bollinger (%B = ${pctB.toFixed(2)}) ในตลาดออกข้าง = โซนรับเชิงสถิติ`);
    else if (regime === 'range' && pctB >= 0.95) push('bands', 'BB Upper Band', -1, 0.7, `ราคาแตะขอบบน Bollinger (%B = ${pctB.toFixed(2)}) ในตลาดออกข้าง = โซนต้านเชิงสถิติ`);
    else if (regime === 'trend' && pctB > 0.75 && pctB < 1.05) push('bands', 'Band Ride', 1, 0.35, `ราคาเกาะครึ่งบนของ Bollinger (%B = ${pctB.toFixed(2)}) = พฤติกรรม "band riding" ของเทรนด์ขาขึ้นที่แข็งแรง`);
    else if (regime === 'trend' && pctB < 0.25 && pctB > -0.05) push('bands', 'Band Ride', -1, 0.35, `ราคาเกาะครึ่งล่างของ Bollinger (%B = ${pctB.toFixed(2)}) = พฤติกรรมของเทรนด์ขาลงที่แข็งแรง`);
  }

  // ── 9) แนวรับ-แนวต้าน ───────────────────────────────────────────────────
  const { support, resistance } = nearestLevels(ctx.zones, price, i);
  if (support && (price - support.price) / atrVal < 0.6 && ms.side >= 0) {
    push('levels', 'Support Test', 1, clamp(support.touches / 4, 0.35, 1),
      `ราคาอยู่ห่างแนวรับ ${support.price.toFixed(2)} เพียง ${((price - support.price) / atrVal).toFixed(2)} ATR และแนวนี้ถูกทดสอบมาแล้ว ${support.touches} ครั้ง = โซนที่มีคำสั่งซื้อรออยู่จริง (ความเสี่ยงต่อไม้ต่ำเพราะตั้ง SL ใต้แนวได้ใกล้)`);
  }
  if (resistance && (resistance.price - price) / atrVal < 0.6 && ms.side <= 0) {
    push('levels', 'Resistance Test', -1, clamp(resistance.touches / 4, 0.35, 1),
      `ราคาอยู่ห่างแนวต้าน ${resistance.price.toFixed(2)} เพียง ${((resistance.price - price) / atrVal).toFixed(2)} ATR และแนวนี้ถูกทดสอบมาแล้ว ${resistance.touches} ครั้ง = โซนที่มีคำสั่งขายรออยู่จริง`);
  }
  // เบรกแนวต้าน/หลุดแนวรับด้วยแท่งปิด
  const prevClose = candles[i - 1].c;
  const prevLv = nearestLevels(ctx.zones, prevClose, i - 1);
  if (prevLv.resistance && c.c > prevLv.resistance.price && prevClose <= prevLv.resistance.price) {
    push('levels', 'Resistance Break', 1, 0.85, `แท่งนี้ปิดทะลุแนวต้าน ${prevLv.resistance.price.toFixed(2)} ที่กดราคามา ${prevLv.resistance.touches} ครั้ง = แนวต้านเดิมมีโอกาสกลายเป็นแนวรับใหม่ (role reversal)`);
  }
  if (prevLv.support && c.c < prevLv.support.price && prevClose >= prevLv.support.price) {
    push('levels', 'Support Break', -1, 0.85, `แท่งนี้ปิดหลุดแนวรับ ${prevLv.support.price.toFixed(2)} ที่รับราคามา ${prevLv.support.touches} ครั้ง = แนวรับเดิมมีโอกาสกลายเป็นแนวต้านใหม่`);
  }

  // ── 10) RSI Divergence ──────────────────────────────────────────────────
  const div = rsiDivergence(candles, ctx.rsi, ctx.pivots, i);
  if (div) push('divergence', div.type, div.side, 0.85, div.detail);

  // ── 11) VWAP ────────────────────────────────────────────────────────────
  if (ctx.vwap[i]) {
    const dev = (price - ctx.vwap[i]) / atrVal;
    if (Math.abs(dev) > 0.15) {
      push('vwap', 'VWAP Position', Math.sign(dev), clamp(Math.abs(dev) / 2, 0.2, 1),
        `ราคาอยู่${dev > 0 ? 'เหนือ' : 'ใต้'} VWAP ของวัน (${ctx.vwap[i].toFixed(2)}) ${Math.abs(dev).toFixed(2)} ATR = ต้นทุนเฉลี่ยของคนที่ถืออยู่${dev > 0 ? 'กำไร ฝั่งซื้อได้เปรียบ' : 'ขาดทุน ฝั่งขายได้เปรียบ'}`);
    }
  }

  // ── 12) Stochastic ──────────────────────────────────────────────────────
  const sk = ctx.stoch.k[i], sd = ctx.stoch.d[i], skP = ctx.stoch.k[i - 1], sdP = ctx.stoch.d[i - 1];
  if (sk !== null && sd !== null && skP !== null && sdP !== null) {
    if (skP <= sdP && sk > sd && sk < 45) push('stoch', 'Stochastic Cross', 1, 0.8, `Stochastic %K ตัดขึ้นเหนือ %D ในโซนต่ำ (${sk.toFixed(0)}) = จังหวะกลับตัวจากการย่อ`);
    else if (skP >= sdP && sk < sd && sk > 55) push('stoch', 'Stochastic Cross', -1, 0.8, `Stochastic %K ตัดลงใต้ %D ในโซนสูง (${sk.toFixed(0)}) = จังหวะกลับตัวจากการเด้ง`);
  }

  // ปัจจัยเดียวกันอาจถูก push หลายครั้ง (เช่น MACD ทั้งทิศทางและจุดตัด)
  // ต้องจำกัดผลรวมของแต่ละปัจจัยไม่ให้เกินน้ำหนักที่กำหนด ไม่งั้นจะเป็นการนับซ้ำ
  const byKey = new Map();
  for (const f of factors) {
    if (!byKey.has(f.key)) byKey.set(f.key, []);
    byKey.get(f.key).push(f);
  }
  for (const [key, list] of byKey) {
    const cap = WEIGHTS[key] || 0;
    const sum = list.reduce((a, f) => a + f.contribution, 0);
    if (cap > 0 && Math.abs(sum) > cap) {
      const scale = cap / Math.abs(sum);
      for (const f of list) { f.contribution *= scale; f.capped = true; }
    }
  }

  const raw = factors.reduce((a, f) => a + f.contribution, 0);
  const score = clamp((raw / TOTAL_WEIGHT) * 100, -100, 100);
  return {
    score, side: Math.sign(score), factors, regime, atrPct,
    ready: true, adx: adxVal, rsi: r, atr: atrVal,
    support: support ? support.price : null,
    resistance: resistance ? resistance.price : null,
    structure: ms,
  };
}

/** รวมคะแนนหลายกรอบเวลา — กรอบใหญ่คือ "กระแสน้ำ" กรอบเล็กคือ "จังหวะเข้า" */
export function combineTimeframes(entry, htf1, htf2) {
  const w = [0.55, 0.30, 0.15];
  const parts = [entry, htf1, htf2].map((s) => (s && s.ready ? s.score : 0));
  let total = parts[0] * w[0] + parts[1] * w[1] + parts[2] * w[2];
  const notes = [];
  // ถ้ากรอบเล็กสวนกรอบใหญ่ที่มีเทรนด์แรง → ลดคะแนนลง เพราะสถิติแพ้บ่อย
  if (htf1 && htf1.ready && Math.sign(parts[0]) !== 0 && Math.sign(parts[1]) !== 0 && Math.sign(parts[0]) !== Math.sign(parts[1])) {
    total *= 0.6;
    notes.push('สัญญาณกรอบเล็กสวนทางกรอบใหญ่ — ตัดคะแนนลง 40% เพราะการเทรดสวนเทรนด์หลักมีอัตราชนะต่ำกว่า');
  } else if (htf1 && htf1.ready && Math.sign(parts[0]) === Math.sign(parts[1]) && parts[0] !== 0) {
    notes.push('กรอบเล็กและกรอบใหญ่ไปทางเดียวกัน — เป็นเงื่อนไขที่ทำให้ระยะทางกำไรมักไกลกว่าปกติ');
  }
  return { score: clamp(total, -100, 100), parts, notes };
}

/**
 * สร้างแผนเทรด: จุดเข้า / จุดตัดขาดทุน / เป้าทำกำไร / ขนาดไม้
 * ใช้ ATR เป็นตัวกำหนดระยะ เพราะ SL ต้องกว้างพอที่ "noise ปกติ" จะไม่เขี่ยออก
 */
export function buildSetup(ctx, i, scored, opts = {}) {
  const cfg = ctx.cfg;
  const {
    account = 1000, riskPct = 1, contractSize = 100, // XAU/USD 1 lot = 100 ออนซ์
    side = scored.side, entryPrice = ctx.candles[i].c,
  } = opts;
  if (!side) return null;
  const atrVal = scored.atr || ctx.atr[i];
  const notes = [];

  // SL: ใช้ค่าที่กว้างกว่าระหว่าง ATR กับใต้/เหนือ swing ล่าสุด แต่ไม่เกินเพดาน
  let slDist = atrVal * cfg.slAtrMult;
  const usable = ctx.pivots.filter((p) => p.confirmedAt <= i && i - p.index < 40);
  const lastLow = [...usable].reverse().find((p) => p.type === 'low');
  const lastHigh = [...usable].reverse().find((p) => p.type === 'high');
  if (side > 0 && lastLow && entryPrice > lastLow.price) {
    const structDist = entryPrice - lastLow.price + atrVal * 0.15;
    if (structDist > slDist && structDist <= atrVal * cfg.maxSlAtrMult) {
      slDist = structDist;
      notes.push(`ขยาย SL ไปใต้ swing low ที่ ${lastLow.price.toFixed(2)} เพื่อไม่ให้โดนไส้เทียนเขี่ยออกก่อนราคาไปตามทาง`);
    }
  }
  if (side < 0 && lastHigh && entryPrice < lastHigh.price) {
    const structDist = lastHigh.price - entryPrice + atrVal * 0.15;
    if (structDist > slDist && structDist <= atrVal * cfg.maxSlAtrMult) {
      slDist = structDist;
      notes.push(`ขยาย SL ไปเหนือ swing high ที่ ${lastHigh.price.toFixed(2)} เพื่อกันการ stop hunt`);
    }
  }
  slDist = Math.min(slDist, atrVal * cfg.maxSlAtrMult);

  const sl = side > 0 ? entryPrice - slDist : entryPrice + slDist;
  const tp1 = side > 0 ? entryPrice + slDist : entryPrice - slDist;
  const tp2 = side > 0 ? entryPrice + slDist * 2 : entryPrice - slDist * 2;
  let tp3 = side > 0 ? entryPrice + slDist * 3 : entryPrice - slDist * 3;

  // ถ้ามีแนวต้าน/แนวรับใหญ่ขวางอยู่ก่อนถึงเป้า ให้ย้ายเป้าสุดท้ายมาไว้ก่อนแนวนั้น
  const { support, resistance } = nearestLevels(ctx.zones, entryPrice, i);
  if (side > 0 && resistance) {
    if (resistance.price < tp1) notes.push(`⚠ มีแนวต้าน ${resistance.price.toFixed(2)} ขวางก่อนถึงเป้าแรก — ระยะกำไรถูกจำกัด ควรลดขนาดไม้หรือรอเบรกก่อน`);
    else if (resistance.price < tp3) { tp3 = resistance.price; notes.push(`ปรับเป้าสุดท้ายมาที่แนวต้าน ${resistance.price.toFixed(2)} (ขายก่อนแนวต้านดีกว่าหวังทะลุ)`); }
  }
  if (side < 0 && support) {
    if (support.price > tp1) notes.push(`⚠ มีแนวรับ ${support.price.toFixed(2)} รองรับก่อนถึงเป้าแรก — ระยะกำไรถูกจำกัด`);
    else if (support.price > tp3) { tp3 = support.price; notes.push(`ปรับเป้าสุดท้ายมาที่แนวรับ ${support.price.toFixed(2)}`); }
  }

  const round = nearestRound(entryPrice, 50);
  if (side > 0 && round.distAbove < slDist) notes.push(`เลขกลม ${round.above} อยู่ใกล้ (ห่าง ${round.distAbove.toFixed(2)}) — ทองมักมีแรงขายรอที่เลขกลม เผื่อทยอยปิดบางส่วนก่อน`);
  if (side < 0 && round.distBelow < slDist) notes.push(`เลขกลม ${round.below} อยู่ใกล้ (ห่าง ${round.distBelow.toFixed(2)}) — มักมีแรงซื้อรับที่เลขกลม เผื่อทยอยปิดบางส่วนก่อน`);

  const riskMoney = account * (riskPct / 100);
  const lots = slDist > 0 ? riskMoney / (slDist * contractSize) : 0;

  return {
    side, entry: entryPrice, sl, tp1, tp2, tp3,
    slDist, slAtr: slDist / atrVal, atr: atrVal,
    rr3: Math.abs(tp3 - entryPrice) / slDist,
    riskMoney, lots, oz: lots * contractSize,
    notes,
    plan: side > 0
      ? `เข้าซื้อ (Buy) ที่ ${entryPrice.toFixed(2)} · ตัดขาดทุน ${sl.toFixed(2)} (-${slDist.toFixed(2)}) · เป้า 1R ${tp1.toFixed(2)} / 2R ${tp2.toFixed(2)} / สุดท้าย ${tp3.toFixed(2)}`
      : `เข้าขาย (Sell) ที่ ${entryPrice.toFixed(2)} · ตัดขาดทุน ${sl.toFixed(2)} (+${slDist.toFixed(2)}) · เป้า 1R ${tp1.toFixed(2)} / 2R ${tp2.toFixed(2)} / สุดท้าย ${tp3.toFixed(2)}`,
  };
}

/** จัดอันดับเหตุผล เพื่อโชว์ "ทำไมถึงควรเข้า" และ "อะไรค้านอยู่" */
export function explain(scored) {
  const pro = scored.factors.filter((f) => Math.sign(f.contribution) === scored.side && f.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const con = scored.factors.filter((f) => f.contribution !== 0 && Math.sign(f.contribution) !== scored.side)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const neutral = scored.factors.filter((f) => f.contribution === 0);
  return { pro, con, neutral };
}

/** ป้ายระดับสัญญาณ — อิงกับเกณฑ์ที่ผู้ใช้ตั้งไว้ เพื่อไม่ให้ข้อความขัดกับการตัดสินใจ */
export function scoreLabel(score, threshold = 35) {
  const a = Math.abs(score);
  if (a < threshold) return { text: 'ยังไม่ถึงเกณฑ์', cls: 'grade-e' };
  if (a >= Math.max(60, threshold * 1.7)) return { text: 'สัญญาณแข็งแรงมาก', cls: 'grade-a' };
  if (a >= Math.max(45, threshold * 1.3)) return { text: 'สัญญาณแข็งแรง', cls: 'grade-b' };
  return { text: 'สัญญาณพอใช้', cls: 'grade-c' };
}
