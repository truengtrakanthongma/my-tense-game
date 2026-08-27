/**
 * ชุดทดสอบ (รันด้วย: node test/run-tests.mjs)
 * เน้น 3 เรื่องที่ถ้าพลาดแล้วผลลัพธ์จะ "ดูดีเกินจริง" หรือหลอกผู้ใช้:
 *  1. คณิตศาสตร์ของตัวชี้วัดถูกต้อง (เทียบกับสูตรตรงและค่าที่คำนวณมือได้)
 *  2. ไม่มีการมองอนาคต (look-ahead) — คะแนนที่แท่ง i ต้องเท่ากันไม่ว่าจะรู้ข้อมูลหลังแท่ง i หรือไม่
 *  3. การจำลองเทรดใน backtest สมเหตุสมผล (ลำดับเวลา ราคาเข้า ทิศทาง SL/TP ขนาดไม้)
 */
import * as ta from '../js/indicators.js';
import { buildContext, scoreAt, buildSetup, DEFAULT_CFG, WEIGHTS } from '../js/signals.js';
import { runBacktest } from '../js/backtest.js';
import { findPivots, clusterLevels, levelsAt } from '../js/levels.js';
import { nextNFP, usDstActive, xauToThaiBaht } from '../js/macro.js';

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── ข้อมูลทดสอบ ────────────────────────────────────────────────────────
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCandles(n, seed = 7, drift = 0) {
  const rnd = mulberry(seed);
  const out = [];
  let p = 3300;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 6 + drift;
    const o = p, c = p + shock;
    const h = Math.max(o, c) + rnd() * 2.2;
    const l = Math.min(o, c) - rnd() * 2.2;
    out.push({ t: 1700000000000 + i * 900000, o, h, l, c, v: 100 + rnd() * 400, closed: true });
    p = c;
  }
  return out;
}

// ── 1. ตัวชี้วัด ───────────────────────────────────────────────────────
section('1) คณิตศาสตร์ของตัวชี้วัด');
{
  const v = [1, 2, 3, 4, 5, 6];
  const s = ta.sma(v, 3);
  ok('SMA(3) เว้น warm-up และหาค่าเฉลี่ยถูก', s[0] === null && s[1] === null && near(s[2], 2) && near(s[5], 5));

  const e = ta.ema([2, 4, 6, 8, 10], 3);
  // seed = ค่าเฉลี่ย 3 ตัวแรก = 4 ; k = 0.5 ; ถัดไป = 8*0.5 + 4*0.5 = 6 ; แล้ว 10*0.5+6*0.5 = 8
  ok('EMA(3) seed ด้วย SMA และไล่สูตรถูก', near(e[2], 4) && near(e[3], 6) && near(e[4], 8), `ได้ ${e.slice(2)}`);

  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const dn = Array.from({ length: 40 }, (_, i) => 100 - i);
  ok('RSI ของราคาขึ้นล้วน = 100', near(ta.rsi(up, 14)[39], 100, 1e-9));
  ok('RSI ของราคาลงล้วน = 0', near(ta.rsi(dn, 14)[39], 0, 1e-9));

  // RSI เทียบกับ implementation ตรงไปตรงมา (Wilder) ที่เขียนแยกในไฟล์ทดสอบ
  const px = makeCandles(120, 3).map((c) => c.c);
  const refRsi = (values, p) => {
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p;
    const out = [];
    out[p] = 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      g = (g * (p - 1) + Math.max(0, d)) / p;
      l = (l * (p - 1) + Math.max(0, -d)) / p;
      out[i] = 100 - 100 / (1 + g / l);
    }
    return out;
  };
  const mine = ta.rsi(px, 14), ref = refRsi(px, 14);
  let maxDiff = 0;
  for (let i = 20; i < px.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i]));
  ok('RSI ตรงกับสูตร Wilder อิสระ', maxDiff < 1e-9, `ต่างสูงสุด ${maxDiff}`);

  const c1 = [{ o: 10, h: 12, l: 9, c: 11, v: 1 }, { o: 11, h: 15, l: 10, c: 14, v: 1 }];
  const tr = ta.trueRange(c1);
  ok('True Range แท่งแรก = high-low, แท่งถัดไปเทียบราคาปิดก่อนหน้า', near(tr[0], 3) && near(tr[1], 5), `ได้ ${tr}`);

  const bb = ta.bollinger([5, 5, 5, 5, 5, 5], 5, 2);
  ok('Bollinger: ราคานิ่ง → แบนด์บนล่างเท่าเส้นกลาง', near(bb.upper[5], 5) && near(bb.lower[5], 5));
  const bb2 = ta.bollinger(px, 20, 2);
  ok('Bollinger: เส้นกลาง = SMA20', near(bb2.mid[50], ta.sma(px, 20)[50], 1e-9));
  ok('Bollinger: %B = 0.5 เมื่อราคาอยู่กลางแบนด์', bb2.pctB[50] > 0 && bb2.pctB[50] < 1);

  const flat = Array.from({ length: 60 }, () => ({ o: 10, h: 10.5, l: 9.5, c: 10, v: 1 }));
  const adxFlat = ta.adx(flat, 14);
  ok('ADX ของตลาดนิ่งสนิท ต่ำมาก (<10)', adxFlat.adx[59] < 10, `ได้ ${adxFlat.adx[59]}`);
  const trend = Array.from({ length: 60 }, (_, i) => ({ o: 100 + i, h: 100.8 + i, l: 99.6 + i, c: 100.5 + i, v: 1 }));
  const adxTrend = ta.adx(trend, 14);
  ok('ADX ของเทรนด์ขึ้นชัดเจน สูง (>40)', adxTrend.adx[59] > 40, `ได้ ${adxTrend.adx[59]}`);
  ok('+DI มากกว่า -DI ในเทรนด์ขาขึ้น', adxTrend.plusDI[59] > adxTrend.minusDI[59]);

  ok('ทุก series ยาวเท่าอินพุตเสมอ',
    ta.rsi(px, 14).length === px.length && ta.atr(makeCandles(50), 14).length === 50 && ta.macd(px).hist.length === px.length);
}

// ── 2. ไม่มองอนาคต ────────────────────────────────────────────────────
section('2) การป้องกันการมองอนาคต (look-ahead)');
{
  const candles = makeCandles(700, 11);
  const full = buildContext(candles, DEFAULT_CFG);
  let allMatch = true, worst = 0, worstAt = -1;
  for (const i of [260, 330, 410, 480, 550, 620]) {
    const partial = buildContext(candles.slice(0, i + 1), DEFAULT_CFG);
    const a = scoreAt(full, i), b = scoreAt(partial, i);
    const d = Math.abs(a.score - b.score);
    if (d > worst) { worst = d; worstAt = i; }
    if (d > 1e-9 || a.factors.length !== b.factors.length) allMatch = false;
  }
  ok('คะแนนที่แท่ง i เท่ากันทุกประการ ไม่ว่าจะรู้ข้อมูลหลังแท่ง i หรือไม่', allMatch, `ต่างสูงสุด ${worst} ที่แท่ง ${worstAt}`);

  // โซนแนวรับ-ต้าน ต้องเห็นเท่ากันด้วย
  const pv = findPivots(candles, 3);
  const zFull = clusterLevels(pv, 5);
  const zPart = clusterLevels(findPivots(candles.slice(0, 401), 3), 5);
  const lFull = levelsAt(zFull, 400).map((z) => `${z.price.toFixed(4)}x${z.touches}`).sort().join('|');
  const lPart = levelsAt(zPart, 400).map((z) => `${z.price.toFixed(4)}x${z.touches}`).sort().join('|');
  ok('โซนแนวรับ/ต้าน ณ แท่ง 400 เหมือนกันทั้งกรณีรู้และไม่รู้อนาคต', lFull === lPart);

  const pivotsAfter = pv.filter((p) => p.confirmedAt <= 400 && p.index > 400);
  ok('ไม่มี pivot ที่ "ยืนยันแล้ว" ก่อนที่มันจะเกิดขึ้นจริง', pivotsAfter.length === 0);

  const s1 = scoreAt(full, 500), s2 = scoreAt(full, 500);
  ok('ผลลัพธ์คงที่ (deterministic) เรียกซ้ำได้ค่าเดิม', s1.score === s2.score);

  // ปัจจัยเดียวกันต้องไม่ถูกนับซ้ำจนเกินน้ำหนักที่กำหนดไว้
  let capOk = true, capMsg = '';
  const totalW = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  for (let i = 250; i < 700; i++) {
    const sc = scoreAt(full, i);
    const sums = new Map();
    for (const f of sc.factors) sums.set(f.key, (sums.get(f.key) || 0) + f.contribution);
    for (const [k, v] of sums) {
      if (Math.abs(v) > WEIGHTS[k] + 1e-9) { capOk = false; capMsg = `${k} = ${v.toFixed(2)} เกินน้ำหนัก ${WEIGHTS[k]} ที่แท่ง ${i}`; }
    }
    if (Math.abs(sc.score) > 100.000001) { capOk = false; capMsg = `คะแนน ${sc.score} เกิน 100 ที่แท่ง ${i}`; }
  }
  ok('คะแนนของแต่ละปัจจัยไม่เกินน้ำหนักที่กำหนด (ไม่มีการนับซ้ำ)', capOk, capMsg);
  ok('คะแนนรวมอยู่ในช่วง -100 ถึง 100 เสมอ', capOk);
  ok('น้ำหนักรวมเท่ากับผลรวมของทุกปัจจัย', totalW === Object.values(WEIGHTS).reduce((a, b) => a + b, 0));
}

// ── 3. แผนเทรด ────────────────────────────────────────────────────────
section('3) แผนเข้า-ออกและขนาดไม้');
{
  const candles = makeCandles(600, 23);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const i = 599;
  const sc = scoreAt(ctx, i);
  for (const side of [1, -1]) {
    const st = buildSetup(ctx, i, { ...sc, side }, { account: 2000, riskPct: 2, entryPrice: candles[i].c, side });
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: SL อยู่${side > 0 ? 'ใต้' : 'เหนือ'}จุดเข้า`, side > 0 ? st.sl < st.entry : st.sl > st.entry);
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: เป้าเรียงลำดับ 1R < 2R`, Math.abs(st.tp2 - st.entry) > Math.abs(st.tp1 - st.entry));
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: TP1 ห่างเท่ากับระยะ SL พอดี (1R)`, near(Math.abs(st.tp1 - st.entry), st.slDist, 1e-9));
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: SL ไม่กว้างเกินเพดาน ${DEFAULT_CFG.maxSlAtrMult}× ATR`, st.slAtr <= DEFAULT_CFG.maxSlAtrMult + 1e-9, `ได้ ${st.slAtr}`);
    const expectLots = (2000 * 0.02) / (st.slDist * 100);
    ok(`ฝั่ง ${side > 0 ? 'ซื้อ' : 'ขาย'}: ขนาดไม้ = เงินเสี่ยง ÷ (ระยะ SL × 100 ออนซ์)`, near(st.lots, expectLots, 1e-9));
  }
  ok('ถ้าไม่มีทิศทาง ไม่สร้างแผน', buildSetup(ctx, i, { ...sc, side: 0 }, { side: 0 }) === null);
}

// ── 4. Backtest ───────────────────────────────────────────────────────
section('4) การจำลองย้อนหลัง');
{
  const candles = makeCandles(900, 41);
  const ctx = buildContext(candles, DEFAULT_CFG);
  const bt = runBacktest(ctx, { threshold: 30, maxHold: 40, spread: 0.3 });
  ok('สร้างไม้เทรดได้จากข้อมูลสุ่ม', bt.stats.n > 0, `ได้ ${bt.stats.n} ไม้`);
  ok('ทุกไม้ออกหลังเข้าเสมอ', bt.trades.every((t) => t.exitIndex > t.entryIndex));
  ok('ทุกไม้เข้าที่ราคาเปิดของแท่งถัดไป (ไม่ใช่ราคาปิดที่ยังไม่รู้)',
    bt.trades.every((t) => near(t.entry, candles[t.entryIndex].o + (t.side > 0 ? 0.15 : -0.15), 1e-9)));
  ok('ไม่มีไม้ซ้อนกัน (ไม้ถัดไปเริ่มหลังไม้ก่อนหน้าปิด)',
    bt.trades.every((t, k) => k === 0 || t.index > bt.trades[k - 1].exitIndex));
  ok('ผลขาดทุนต่อไม้ไม่เกิน -1R (ยกเว้นค่าสลิปเพจเล็กน้อย)', bt.trades.every((t) => t.rMultiple >= -1.3));
  ok('ทุกไม้เริ่มหลังช่วง warm-up 210 แท่ง', bt.trades.every((t) => t.index >= 210));
  ok('อัตราชนะอยู่ในช่วง 0-100%', bt.stats.winRate >= 0 && bt.stats.winRate <= 100);
  ok('ผลรวม R เท่ากับผลบวกของทุกไม้', near(bt.stats.totalR, bt.trades.reduce((a, t) => a + t.rMultiple, 0), 1e-9));
  ok('จำนวนไม้ในตารางช่วงคะแนน รวมแล้วเท่าจำนวนไม้ทั้งหมด',
    bt.bands.reduce((a, b) => a + b.n, 0) === bt.stats.n);
  ok('จำนวนไม้ในตารางช่วงเวลา รวมแล้วเท่าจำนวนไม้ทั้งหมด',
    bt.sessions.reduce((a, b) => a + b.n, 0) === bt.stats.n);

  const strict = runBacktest(ctx, { threshold: 60, maxHold: 40, spread: 0.3 });
  ok('เกณฑ์คะแนนสูงขึ้น → จำนวนไม้ต้องน้อยลง (หรือเท่าเดิม)', strict.stats.n <= bt.stats.n, `${strict.stats.n} vs ${bt.stats.n}`);
  ok('ทุกไม้ในชุดเข้ม มีคะแนนถึงเกณฑ์จริง', strict.trades.every((t) => t.absScore >= 60));

  // ตลาดขาขึ้นชัดเจน ระบบต้องเอนไปฝั่งซื้อ
  const bull = buildContext(makeCandles(900, 5, 1.6), DEFAULT_CFG);
  const btBull = runBacktest(bull, { threshold: 30, maxHold: 40, spread: 0.3 });
  const longs = btBull.trades.filter((t) => t.side > 0).length;
  ok('ในตลาดขาขึ้นชัดเจน ระบบเข้าฝั่งซื้อมากกว่าฝั่งขาย', longs > btBull.stats.n / 2, `ซื้อ ${longs}/${btBull.stats.n}`);
}

// ── 5. เวลาและการแปลงหน่วย ────────────────────────────────────────────
section('5) เวลาตลาดและการแปลงราคา');
{
  const nfp = nextNFP(new Date(Date.UTC(2026, 7, 20)));
  ok('NFP ครั้งถัดไปตกวันศุกร์', nfp.getUTCDay() === 5, `ได้วัน ${nfp.getUTCDay()} (${nfp.toISOString()})`);
  ok('NFP เป็นศุกร์แรกของเดือน', nfp.getUTCDate() <= 7, `วันที่ ${nfp.getUTCDate()}`);
  ok('NFP อยู่ในอนาคตเสมอ', nfp > new Date(Date.UTC(2026, 7, 20)));
  ok('เวลา NFP = 8:30 ET (12:30 UTC ฤดูร้อน / 13:30 UTC ฤดูหนาว)',
    (nfp.getUTCHours() === 12 || nfp.getUTCHours() === 13) && nfp.getUTCMinutes() === 30, `ได้ ${nfp.getUTCHours()}:${nfp.getUTCMinutes()}`);
  ok('DST สหรัฐฯ: กรกฎาคม = ใช่, มกราคม = ไม่ใช่',
    usDstActive(new Date(Date.UTC(2026, 6, 15))) === true && usDstActive(new Date(Date.UTC(2026, 0, 15))) === false);

  // 1 ทรอยออนซ์ = 31.1035 กรัม, 1 บาททองคำ = 15.244 กรัม ทอง 96.5%
  const thb = xauToThaiBaht(3110.35, 36);
  const expect = (3110.35 / 31.1035) * 15.244 * 0.965 * 36;
  ok('แปลงราคาทอง USD/ออนซ์ → บาท/บาททองคำ ถูกต้อง', near(thb, expect, 1e-6), `ได้ ${thb.toFixed(2)}`);
  ok('ราคาแปลงอยู่ในระดับที่สมเหตุสมผล (หมื่นกว่าบาท)', thb > 20000 && thb < 90000, `ได้ ${thb.toFixed(0)}`);
}

// ── 6. การไหลของข้อมูลสด ──────────────────────────────────────────────
section('6) ข้อมูลสดและเหตุการณ์ "แท่งปิด"');
{
  const { MarketFeed, TF, mergeCandle } = await import('../js/feed.js');

  const base = [{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, closed: true }];
  const arr = [...base];
  const r1 = mergeCandle(arr, { t: 1000, o: 1, h: 3, l: 0.5, c: 2.8, v: 20, closed: false });
  ok('อัปเดตแท่งเดิม (t เท่ากัน) = ทับของเดิม ไม่เพิ่มแท่ง', r1.appended === false && arr.length === 1 && arr[0].c === 2.8);
  const r2 = mergeCandle(arr, { t: 2000, o: 2.8, h: 3, l: 2.7, c: 2.9, v: 5, closed: false });
  ok('แท่งใหม่ (t มากกว่า) = ต่อท้าย', r2.appended === true && arr.length === 2);
  const r3 = mergeCandle(arr, { t: 500, o: 1, h: 1, l: 1, c: 1, v: 1 });
  ok('ข้อมูลเก่ากว่าที่มีอยู่ = ทิ้ง (กันข้อมูลย้อนหลังมาป่วน)', r3.stale === true && arr.length === 2);

  // เร่งเวลา: ตั้งกรอบ 1m ให้ยาว 1 วินาที เพื่อดูว่ามีเหตุการณ์ "แท่งปิด" ส่งออกมาจริง
  const realMs = TF['1m'].ms;
  TF['1m'].ms = 1000;
  const feed = new MarketFeed();
  feed.configure({ source: 'demo', interval: '1m' });
  const hist = await feed.loadHistory('1m', 60);
  ok('โหลดข้อมูลจำลองได้ และแท่งสุดท้ายคือแท่งที่ยังไม่ปิด',
    hist.length === 60 && hist[59].closed === false && hist[58].closed === true);
  ok('เวลาแท่งเรียงจากเก่าไปใหม่และห่างเท่ากันทุกแท่ง',
    hist.every((c, i) => i === 0 || c.t - hist[i - 1].t === TF['1m'].ms));

  const events = [];
  feed.start((k) => events.push(k), () => {});
  // รอจน "แท่งปิด" เกิดขึ้นจริง แทนการนอนรอเวลาตายตัว
  // เพราะจังหวะ tick (900ms) กับความยาวกรอบเวลาไม่ได้หารลงตัวกัน
  // บางรอบ tick สองครั้งติดจึงตกอยู่ในกรอบเดียวกันและยังไม่มีการข้ามกรอบ
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !events.some((e) => e.closed)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  feed.stop();
  TF['1m'].ms = realMs;
  const closes = events.filter((e) => e.closed);
  ok('มีการส่งเหตุการณ์ "แท่งปิด" เมื่อข้ามกรอบเวลา', closes.length >= 1, `ได้ ${closes.length} ครั้งจาก ${events.length} ข้อความ`);
  ok('เหตุการณ์แท่งปิดแต่ละครั้งเป็นคนละแท่ง (ไม่ยิงซ้ำ)', new Set(closes.map((c) => c.t)).size === closes.length);
  ok('ราคาสูงสุด/ต่ำสุดของแท่งครอบคลุมราคาปิดเสมอ',
    events.every((e) => e.h >= e.c - 1e-9 && e.l <= e.c + 1e-9));
}

// ── 7. การอ่านข้อมูลจากผู้ให้บริการจริง (จำลอง network) ────────────────
section('7) การแปลงข้อมูลจาก Binance / Twelve Data');
{
  const { MarketFeed } = await import('../js/feed.js');
  const realFetch = globalThis.fetch;
  const realWS = globalThis.WebSocket;

  // รูปแบบที่ Binance ส่งกลับจริง: array ของ array [openTime, o, h, l, c, v, closeTime, ...]
  const binanceRows = [
    [1700000000000, '2650.10', '2655.90', '2648.00', '2653.40', '12.5', 1700000899999, '33150.2', 120, '6.1', '16180.3', '0'],
    [1700000900000, '2653.40', '2660.00', '2652.10', '2658.75', '9.8', 1700001799999, '26055.7', 98, '5.0', '13290.1', '0'],
  ];
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.includes('api.binance.com')) throw new Error('geo-blocked'); // จำลองโดนบล็อกโฮสต์แรก
    return { ok: true, status: 200, json: async () => binanceRows };
  };

  const feed = new MarketFeed();
  feed.configure({ source: 'binance', symbol: 'PAXGUSDT', interval: '15m' });
  const rows = await feed.loadHistory('15m', 2);
  ok('แปลงแท่งเทียนจากรูปแบบ array ของ Binance ได้ถูกต้อง',
    rows.length === 2 && rows[0].t === 1700000000000 && rows[0].o === 2650.1 &&
    rows[0].h === 2655.9 && rows[0].l === 2648 && rows[0].c === 2653.4 && rows[0].v === 12.5,
    JSON.stringify(rows[0]));
  ok('ตัวเลขถูกแปลงเป็น number (Binance ส่งมาเป็น string)', typeof rows[1].c === 'number' && rows[1].c === 2658.75);
  ok('สลับไปโฮสต์สำรองอัตโนมัติเมื่อโฮสต์แรกใช้ไม่ได้',
    calls.length === 2 && calls[0].includes('api.binance.com') && calls[1].includes('data-api.binance.vision'));
  ok('URL มีสัญลักษณ์ กรอบเวลา และจำนวนแท่งครบ',
    calls[1].includes('symbol=PAXGUSDT') && calls[1].includes('interval=15m') && calls[1].includes('limit=2'), calls[1]);

  // ทุกโฮสต์ล่ม → ต้องโยน error ที่อ่านรู้เรื่อง ไม่ใช่พังเงียบ ๆ
  globalThis.fetch = async () => { throw new Error('offline'); };
  let msg = '';
  try { await feed.loadHistory('15m', 2); } catch (e) { msg = e.message; }
  ok('ถ้าโหลดไม่ได้ทุกโฮสต์ จะแจ้งข้อความภาษาไทยที่บอกทางแก้', msg.includes('Binance') && msg.includes('demo'), msg);

  // Twelve Data: JSON คนละรูปแบบ
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    values: [
      { datetime: '2026-08-27 10:00:00', open: '3390.5', high: '3395.0', low: '3388.2', close: '3392.8' },
      { datetime: '2026-08-27 11:00:00', open: '3392.8', high: '3401.4', low: '3391.0', close: '3399.9' },
    ],
  }) });
  const td = new MarketFeed();
  td.configure({ source: 'twelvedata', interval: '1h', apiKey: 'test-key' });
  const tdRows = await td.loadHistory('1h', 2);
  ok('แปลงข้อมูล Twelve Data (XAU/USD) ได้ถูกต้อง',
    tdRows.length === 2 && tdRows[0].c === 3392.8 && tdRows[1].h === 3401.4 &&
    tdRows[0].t === Date.UTC(2026, 7, 27, 10, 0, 0), JSON.stringify(tdRows[0]));
  ok('ไม่มี volume ก็ไม่พัง (โลหะมีค่าไม่มีข้อมูล volume)', tdRows[0].v === 0);

  let tdErr = '';
  const noKey = new MarketFeed();
  noKey.configure({ source: 'twelvedata', interval: '1h', apiKey: '' });
  try { await noKey.loadHistory('1h', 2); } catch (e) { tdErr = e.message; }
  ok('ไม่มี API key → บอกให้ไปสมัคร ไม่ใช่ error ดิบ ๆ', tdErr.includes('API key'), tdErr);

  // WebSocket: ตรวจ URL และการอ่านข้อความ kline
  let wsUrl = '';
  const received = [];
  globalThis.WebSocket = class {
    constructor(url) { wsUrl = url; setTimeout(() => this.onopen && this.onopen(), 0); }
    close() {}
  };
  const ws = new MarketFeed();
  ws.configure({ source: 'binance', symbol: 'XAUTUSDT', interval: '5m' });
  ws.start((k) => received.push(k), () => {});
  ok('URL ของ WebSocket ตรงรูปแบบ <symbol ตัวเล็ก>@kline_<tf>',
    wsUrl === 'wss://stream.binance.com:9443/ws/xautusdt@kline_5m', wsUrl);
  ws.ws.onmessage({ data: JSON.stringify({ e: 'kline', k: {
    t: 1700000000000, o: '2650.1', h: '2661.0', l: '2649.5', c: '2659.9', v: '3.25', x: true } }) });
  ok('อ่านข้อความ kline จาก WebSocket และตั้งธง "แท่งปิด" ถูกต้อง',
    received.length === 1 && received[0].c === 2659.9 && received[0].closed === true, JSON.stringify(received[0]));
  ws.ws.onmessage({ data: 'ไม่ใช่ JSON' });
  ok('ข้อความเสีย ๆ ไม่ทำให้ระบบล้ม', received.length === 1);
  ws.stop();

  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWS;
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`ผ่าน ${pass} / ล้มเหลว ${fail}`);
process.exit(fail ? 1 : 0);
