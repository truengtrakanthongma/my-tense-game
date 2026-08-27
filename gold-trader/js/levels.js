/**
 * levels.js — โครงสร้างราคา: swing pivot, แนวรับ-แนวต้าน, Fibonacci, เลขกลม
 *
 * pivot ที่แท่ง j จะ "ยืนยัน" ได้ก็ต่อเมื่อผ่านไปอีก k แท่ง (confirmedAt = j + k)
 * backtest จึงใช้เฉพาะ pivot ที่ confirmedAt <= i เพื่อไม่ให้เกิด look-ahead bias
 */

/** หา swing high/low แบบ fractal ซ้าย k แท่ง ขวา k แท่ง */
export function findPivots(candles, k = 3) {
  const pivots = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ index: i, confirmedAt: i + k, price: candles[i].h, type: 'high', t: candles[i].t });
    if (isLow) pivots.push({ index: i, confirmedAt: i + k, price: candles[i].l, type: 'low', t: candles[i].t });
  }
  return pivots;
}

/**
 * รวม pivot ที่ราคาใกล้กันเป็น "โซน" แนวรับ/แนวต้าน — โดนแตะยิ่งเยอะยิ่งสำคัญ
 *
 * จับกลุ่ม "ตามลำดับเวลาที่ยืนยัน" ไม่ใช่ตามราคา เพราะถ้าจัดกลุ่มด้วยราคาทั้งชุด
 * pivot ในอนาคตจะไปเปลี่ยนการแบ่งกลุ่มของอดีตได้ = ข้อมูลอนาคตรั่วเข้า backtest
 * วิธีนี้ให้ผลเหมือนการคำนวณสด ๆ ทีละแท่งเป๊ะ ๆ
 */
export function clusterLevels(pivots, tolerance) {
  const zones = [];
  for (const p of [...pivots].sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index)) {
    let best = null, bestDist = Infinity;
    for (const z of zones) {
      const d = Math.abs(p.price - z.price);
      if (d <= tolerance && d < bestDist) { best = z; bestDist = d; }
    }
    if (best) {
      best.members.push(p);
      best.touches = best.members.length;
      best.price = best.members.reduce((a, m) => a + m.price, 0) / best.members.length;
      best.confirmedAt = Math.min(best.confirmedAt, p.confirmedAt);
    } else {
      zones.push({ price: p.price, touches: 1, confirmedAt: p.confirmedAt, members: [p] });
    }
  }
  return zones;
}

/** ภาพของโซนแนวรับ/ต้าน "เท่าที่รู้ได้" ณ แท่ง i (นับเฉพาะ pivot ที่ยืนยันแล้ว) */
export function levelsAt(zones, i) {
  const out = [];
  for (const z of zones) {
    const seen = z.members.filter((m) => m.confirmedAt <= i);
    if (!seen.length) continue;
    out.push({
      price: seen.reduce((a, m) => a + m.price, 0) / seen.length,
      touches: seen.length,
      lastIndex: Math.max(...seen.map((m) => m.index)),
    });
  }
  return out;
}

/** แนวรับ/แนวต้านที่ใกล้ราคาปัจจุบันที่สุด (ใช้เฉพาะข้อมูลที่ยืนยันแล้ว ณ แท่ง i) */
export function nearestLevels(zones, price, i) {
  let support = null, resistance = null;
  for (const z of levelsAt(zones, i)) {
    if (z.price <= price && (!support || z.price > support.price)) support = z;
    if (z.price > price && (!resistance || z.price < resistance.price)) resistance = z;
  }
  return { support, resistance };
}

/** เลขกลมที่ทองมักมีแรงซื้อ/ขายรออยู่ เช่น 2400 / 2450 / 2500 */
export function nearestRound(price, step = 50) {
  const below = Math.floor(price / step) * step;
  return { below, above: below + step, distBelow: price - below, distAbove: below + step - price };
}

/** Fibonacci retracement ของ leg ล่าสุดที่ยืนยันแล้ว */
export function fibLevels(pivots, i) {
  const usable = pivots.filter((p) => p.confirmedAt <= i);
  if (usable.length < 2) return null;
  const last = usable[usable.length - 1];
  let prev = null;
  for (let j = usable.length - 2; j >= 0; j--) {
    if (usable[j].type !== last.type) { prev = usable[j]; break; }
  }
  if (!prev) return null;
  const from = prev.price, to = last.price;
  const diff = to - from;
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  return {
    direction: diff > 0 ? 'up' : 'down',
    from, to,
    levels: ratios.map((r) => ({ ratio: r, price: to - diff * r })),
    ext: [1.272, 1.618].map((r) => ({ ratio: r, price: from + diff * r })),
  };
}

/** โครงสร้างตลาด: HH/HL = ขาขึ้น, LH/LL = ขาลง */
export function marketStructure(pivots, i) {
  const highs = pivots.filter((p) => p.type === 'high' && p.confirmedAt <= i).slice(-3);
  const lows = pivots.filter((p) => p.type === 'low' && p.confirmedAt <= i).slice(-3);
  if (highs.length < 2 || lows.length < 2) return { label: 'ไม่ชัดเจน', side: 0, detail: 'ข้อมูล swing ยังไม่พอสรุปโครงสร้าง' };
  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
  if (hh && hl) return { label: 'ขาขึ้น (HH/HL)', side: 1, detail: 'ยอดสูงใหม่สูงกว่ายอดเดิม และฐานใหม่สูงกว่าฐานเดิม = โครงสร้างขาขึ้นสมบูรณ์' };
  if (lh && ll) return { label: 'ขาลง (LH/LL)', side: -1, detail: 'ยอดใหม่ต่ำกว่ายอดเดิม และฐานใหม่ต่ำกว่าฐานเดิม = โครงสร้างขาลงสมบูรณ์' };
  if (hh && ll) return { label: 'ผันผวนกว้าง', side: 0, detail: 'ทั้งยอดและฐานขยายออก = ตลาดผันผวน ควรลดขนาดไม้' };
  return { label: 'ออกข้าง (Sideway)', side: 0, detail: 'ยอดและฐานยังไม่ทำจุดใหม่ชัดเจน = ตลาดสะสมกำลัง' };
}

/** RSI divergence: ราคาทำจุดใหม่ แต่ RSI ไม่ทำตาม = สัญญาณอ่อนแรง */
export function rsiDivergence(candles, rsiSeries, pivots, i, maxLookback = 60) {
  const usable = pivots.filter((p) => p.confirmedAt <= i && i - p.index <= maxLookback);
  const highs = usable.filter((p) => p.type === 'high').slice(-2);
  const lows = usable.filter((p) => p.type === 'low').slice(-2);
  if (lows.length === 2) {
    const [a, b] = lows;
    if (b.price < a.price && rsiSeries[b.index] !== null && rsiSeries[a.index] !== null && rsiSeries[b.index] > rsiSeries[a.index] + 2) {
      return { side: 1, type: 'Bullish Divergence', detail: `ราคาทำจุดต่ำใหม่ (${a.price.toFixed(2)} → ${b.price.toFixed(2)}) แต่ RSI กลับยกสูงขึ้น (${rsiSeries[a.index].toFixed(0)} → ${rsiSeries[b.index].toFixed(0)}) = แรงขายเริ่มหมด` };
    }
  }
  if (highs.length === 2) {
    const [a, b] = highs;
    if (b.price > a.price && rsiSeries[b.index] !== null && rsiSeries[a.index] !== null && rsiSeries[b.index] < rsiSeries[a.index] - 2) {
      return { side: -1, type: 'Bearish Divergence', detail: `ราคาทำจุดสูงใหม่ (${a.price.toFixed(2)} → ${b.price.toFixed(2)}) แต่ RSI กลับต่ำลง (${rsiSeries[a.index].toFixed(0)} → ${rsiSeries[b.index].toFixed(0)}) = แรงซื้อเริ่มหมด` };
    }
  }
  return null;
}
