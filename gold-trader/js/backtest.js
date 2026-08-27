/**
 * backtest.js — ทดสอบกฎสัญญาณย้อนหลังบนข้อมูลจริงที่โหลดมา
 *
 * เหตุผลที่ต้องมี: ตัวเลข "ความน่าจะเป็น" ที่ไม่ได้มาจากสถิติ คือการเดา
 * ที่นี่เราจึงจำลองการเทรดตามกฎเดียวกับสัญญาณสด (scoreAt + buildSetup) ทุกแท่งย้อนหลัง
 * แล้วนับว่า "แตะเป้า 1R ก่อนโดน SL" กี่ครั้ง → นั่นคือความน่าจะเป็นที่รายงานบนหน้าจอ
 *
 * ข้อจำกัดที่ต้องรู้ (เขียนไว้ให้ผู้ใช้เห็นบนหน้าจอด้วย):
 *  - ใช้ข้อมูลแท่งเทียน ไม่ใช่ tick — ถ้าแท่งเดียวแตะทั้ง SL และ TP เรานับเป็น "แพ้" เสมอ (อนุรักษ์นิยม)
 *  - อดีตไม่รับประกันอนาคต ตลาดเปลี่ยน regime ได้
 *  - ยิ่งจำนวนตัวอย่างน้อย ยิ่งเชื่อถือได้น้อย
 */

import { scoreAt, buildSetup } from './signals.js';

export const DEFAULT_BT = {
  threshold: 35,
  maxHold: 60,        // ถือไม้ได้สูงสุดกี่แท่ง ก่อนตัดออกที่ราคาตลาด
  spread: 0.30,       // ต้นทุนสเปรด USD ต่อออนซ์ (ทองคำ spot ทั่วไป 0.2-0.4)
  slippage: 0.10,     // สลิปเพจตอนโดน SL
  warmup: 210,        // ต้องมีแท่งพอให้ EMA200 นิ่งก่อน
  useFilters: true,
};

export function runBacktest(ctx, opts = {}) {
  const o = { ...DEFAULT_BT, ...opts };
  const { candles, cfg } = ctx;
  const n = candles.length;
  const trades = [];
  let i = Math.max(o.warmup, 2);

  while (i < n - 2) {
    const s = scoreAt(ctx, i);
    if (!s.ready || Math.abs(s.score) < o.threshold) { i++; continue; }
    if (o.useFilters && (s.atrPct < cfg.minAtrPct || s.atrPct > cfg.maxAtrPct)) { i++; continue; }

    const side = Math.sign(s.score);
    const rawEntry = candles[i + 1].o;
    const entry = side > 0 ? rawEntry + o.spread / 2 : rawEntry - o.spread / 2;
    const setup = buildSetup(ctx, i, { ...s, side }, { entryPrice: entry });
    if (!setup || setup.slDist <= 0) { i++; continue; }

    const { sl, tp1, tp2, slDist } = setup;
    let exitIdx = null, result = null, rMultiple = 0, hit1R = false;
    let maxFav = 0, maxAdv = 0;

    for (let j = i + 1; j <= Math.min(i + o.maxHold, n - 1); j++) {
      const b = candles[j];
      const fav = side > 0 ? (b.h - entry) / slDist : (entry - b.l) / slDist;
      const adv = side > 0 ? (entry - b.l) / slDist : (b.h - entry) / slDist;
      if (fav > maxFav) maxFav = fav;
      if (adv > maxAdv) maxAdv = adv;

      const hitSL = side > 0 ? b.l <= sl : b.h >= sl;
      const hitTP1 = side > 0 ? b.h >= tp1 : b.l <= tp1;
      const hitTP2 = side > 0 ? b.h >= tp2 : b.l <= tp2;

      // แท่งเดียวแตะทั้งคู่ = นับแพ้ (ไม่รู้ลำดับจริงจากข้อมูลแท่งเทียน)
      if (hitSL && !hit1R) {
        exitIdx = j; result = 'loss';
        rMultiple = -1 - o.slippage / slDist;
        break;
      }
      if (hitTP1 && !hit1R) {
        hit1R = true;
        // แผนบริหารไม้: ปิดครึ่งที่ 1R แล้วเลื่อน SL มาที่ทุน
        if (hitTP2) { exitIdx = j; result = 'win2R'; rMultiple = 0.5 * 1 + 0.5 * 2; break; }
        continue;
      }
      if (hit1R) {
        if (hitTP2) { exitIdx = j; result = 'win2R'; rMultiple = 0.5 + 1; break; }
        const hitBE = side > 0 ? b.l <= entry : b.h >= entry;
        if (hitBE) { exitIdx = j; result = 'win1R-be'; rMultiple = 0.5; break; }
      }
    }

    if (exitIdx === null) {
      exitIdx = Math.min(i + o.maxHold, n - 1);
      const last = candles[exitIdx].c;
      const openR = side > 0 ? (last - entry) / slDist : (entry - last) / slDist;
      result = 'timeout';
      rMultiple = hit1R ? 0.5 + Math.max(0, openR) * 0.5 : openR;
    }

    const d = new Date(candles[i + 1].t);
    trades.push({
      index: i, entryIndex: i + 1, exitIndex: exitIdx, t: candles[i + 1].t,
      side, score: s.score, absScore: Math.abs(s.score), regime: s.regime,
      entry, sl, tp1, tp2, slDist, result, rMultiple, hit1R, maxFav, maxAdv,
      bars: exitIdx - i, hourTh: (d.getUTCHours() + 7) % 24,
    });
    i = exitIdx + 1; // ไม้เดียวต่อครั้ง (ไม่ซ้อนไม้ = ใกล้เคียงการเทรดจริง)
  }

  return summarize(trades, o);
}

function summarize(trades, o) {
  const n = trades.length;
  const wins1R = trades.filter((t) => t.hit1R).length;
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rMultiple < 0).reduce((a, t) => a + t.rMultiple, 0));
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);

  let peak = 0, dd = 0, eq = 0, maxDD = 0, streak = 0, maxLossStreak = 0;
  const equity = [];
  for (const t of trades) {
    eq += t.rMultiple;
    equity.push({ t: t.t, eq });
    if (eq > peak) peak = eq;
    dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
    if (t.rMultiple < 0) { streak++; if (streak > maxLossStreak) maxLossStreak = streak; } else streak = 0;
  }

  const bands = [
    { min: o.threshold, max: 45, label: `${o.threshold}-45` },
    { min: 45, max: 60, label: '45-60' },
    { min: 60, max: 75, label: '60-75' },
    { min: 75, max: 101, label: '75+' },
  ].map((b) => {
    const list = trades.filter((t) => t.absScore >= b.min && t.absScore < b.max);
    const w = list.filter((t) => t.hit1R).length;
    return { ...b, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  const sessions = [
    { key: 'asia', label: 'เอเชีย (07:00-14:00 น.)', from: 7, to: 14 },
    { key: 'london', label: 'ลอนดอน (14:00-20:00 น.)', from: 14, to: 20 },
    { key: 'overlap', label: 'ลอนดอน×นิวยอร์ก (20:00-24:00 น.)', from: 20, to: 24 },
    { key: 'late', label: 'ดึก-เช้ามืด (00:00-07:00 น.)', from: 0, to: 7 },
  ].map((s) => {
    const list = trades.filter((t) => t.hourTh >= s.from && t.hourTh < s.to);
    const w = list.filter((t) => t.hit1R).length;
    return { ...s, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  const bySide = [1, -1].map((sd) => {
    const list = trades.filter((t) => t.side === sd);
    const w = list.filter((t) => t.hit1R).length;
    return { side: sd, n: list.length, winRate: list.length ? (w / list.length) * 100 : null,
      avgR: list.length ? list.reduce((a, t) => a + t.rMultiple, 0) / list.length : null };
  });

  const wonTrades = trades.filter((t) => t.hit1R);
  return {
    trades, equity, bands, sessions, bySide,
    stats: {
      n,
      winRate: n ? (wins1R / n) * 100 : null,
      expectancy: n ? totalR / n : null,
      totalR,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      maxDD, maxLossStreak,
      avgBars: n ? trades.reduce((a, t) => a + t.bars, 0) / n : null,
      avgMaxFav: n ? trades.reduce((a, t) => a + t.maxFav, 0) / n : null,
      avgMaxFavWinners: wonTrades.length ? wonTrades.reduce((a, t) => a + t.maxFav, 0) / wonTrades.length : null,
      avgMaxAdv: n ? trades.reduce((a, t) => a + t.maxAdv, 0) / n : null,
      timeouts: trades.filter((t) => t.result === 'timeout').length,
    },
    opts: o,
  };
}

/**
 * แปลงคะแนนสัญญาณสด → ความน่าจะเป็นเชิงสถิติ (จาก band ที่ใกล้เคียงที่สุด)
 * ถ้าตัวอย่างน้อยกว่า 20 ไม้ จะบอกตรง ๆ ว่าเชื่อถือได้จำกัด
 */
export function probabilityFor(score, bt) {
  if (!bt || !bt.stats.n) return { p: null, n: 0, note: 'ยังไม่มีผล backtest — กดปุ่ม "ทดสอบย้อนหลัง" ก่อน' };
  const a = Math.abs(score);
  const band = bt.bands.find((b) => a >= b.min && a < b.max);
  if (band && band.n >= 20) {
    return { p: band.winRate, n: band.n, band: band.label, avgR: band.avgR,
      note: `จากสัญญาณคะแนน ${band.label} ที่เกิดขึ้นจริง ${band.n} ครั้งในข้อมูลชุดนี้` };
  }
  if (band && band.n > 0) {
    return { p: band.winRate, n: band.n, band: band.label, avgR: band.avgR, weak: true,
      note: `ตัวอย่างเพียง ${band.n} ครั้ง (น้อยกว่า 20) — ตัวเลขนี้ยังแกว่งสูง ใช้ค่ารวมทั้งระบบ ${bt.stats.winRate.toFixed(0)}% ประกอบด้วย` };
  }
  return { p: bt.stats.winRate, n: bt.stats.n, weak: true,
    note: `ไม่มีสัญญาณคะแนนระดับนี้ในอดีต ใช้อัตราชนะรวมของระบบแทน (${bt.stats.n} ไม้)` };
}

/** ช่วงความเชื่อมั่น 95% แบบ Wilson — บอกว่าอัตราชนะที่วัดได้ "แกว่งได้แค่ไหน" */
export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { low: ((centre - margin) / denom) * 100, high: ((centre + margin) / denom) * 100 };
}
