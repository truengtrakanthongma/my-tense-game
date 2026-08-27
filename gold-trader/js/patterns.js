/**
 * patterns.js — รูปแบบแท่งเทียน (Price Action)
 * ทุกฟังก์ชันดูข้อมูลถึง index i เท่านั้น
 */

const body = (c) => Math.abs(c.c - c.o);
const upperWick = (c) => c.h - Math.max(c.c, c.o);
const lowerWick = (c) => Math.min(c.c, c.o) - c.l;
const range = (c) => Math.max(c.h - c.l, 1e-9);
const isBull = (c) => c.c >= c.o;

/**
 * ตรวจรูปแบบแท่งเทียนที่แท่ง i
 * @returns {{name:string, side:1|-1|0, strength:number, reason:string}[]}
 */
export function detectPatterns(candles, i, atrVal) {
  const out = [];
  if (i < 3) return out;
  const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2];
  const a = atrVal && atrVal > 0 ? atrVal : range(c);
  const b = body(c);

  // Engulfing — แท่งปัจจุบันกลืนกินตัวแท่งก่อนหน้าทั้งตัว
  if (isBull(c) && !isBull(p1) && c.c > p1.o && c.o <= p1.c && b > body(p1)) {
    out.push({
      name: 'Bullish Engulfing',
      side: 1,
      strength: Math.min(1, b / (body(p1) + 1e-9) / 2),
      reason: 'แท่งเขียวกลืนแท่งแดงก่อนหน้าทั้งตัว = แรงซื้อเข้ามาชนะแรงขายอย่างชัดเจน',
    });
  }
  if (!isBull(c) && isBull(p1) && c.c < p1.o && c.o >= p1.c && b > body(p1)) {
    out.push({
      name: 'Bearish Engulfing',
      side: -1,
      strength: Math.min(1, b / (body(p1) + 1e-9) / 2),
      reason: 'แท่งแดงกลืนแท่งเขียวก่อนหน้าทั้งตัว = แรงขายกลับเข้าควบคุมตลาด',
    });
  }

  // Pin bar / Hammer / Shooting star — ไส้เทียนยาวกว่าตัวเทียน 2 เท่า
  if (lowerWick(c) > b * 2 && lowerWick(c) / range(c) > 0.55 && upperWick(c) < b) {
    out.push({
      name: 'Hammer / Pin Bar',
      side: 1,
      strength: Math.min(1, lowerWick(c) / a),
      reason: 'ไส้เทียนล่างยาว = ราคาถูกทุบลงแล้วมีแรงซื้อดันกลับขึ้นมาปิดสูง (ปฏิเสธราคาต่ำ)',
    });
  }
  if (upperWick(c) > b * 2 && upperWick(c) / range(c) > 0.55 && lowerWick(c) < b) {
    out.push({
      name: 'Shooting Star',
      side: -1,
      strength: Math.min(1, upperWick(c) / a),
      reason: 'ไส้เทียนบนยาว = ราคาถูกดันขึ้นแล้วโดนขายกลับลงมา (ปฏิเสธราคาสูง)',
    });
  }

  // Momentum candle — แท่งใหญ่ผิดปกติเทียบ ATR
  if (b > a * 1.3) {
    out.push({
      name: isBull(c) ? 'Strong Bull Candle' : 'Strong Bear Candle',
      side: isBull(c) ? 1 : -1,
      strength: Math.min(1, b / (a * 2)),
      reason: `แท่งเทียนตัวใหญ่กว่า ATR ${(b / a).toFixed(1)} เท่า = มีโมเมนตัมและ volume จริงหนุนอยู่`,
    });
  }

  // Morning / Evening star (3 แท่ง)
  if (!isBull(p2) && body(p1) < body(p2) * 0.5 && isBull(c) && c.c > (p2.o + p2.c) / 2) {
    out.push({
      name: 'Morning Star',
      side: 1,
      strength: 0.8,
      reason: 'รูปแบบ 3 แท่งกลับตัวขาขึ้น: แดงใหญ่ → แท่งลังเล → เขียวใหญ่ปิดเหนือกลางแท่งแรก',
    });
  }
  if (isBull(p2) && body(p1) < body(p2) * 0.5 && !isBull(c) && c.c < (p2.o + p2.c) / 2) {
    out.push({
      name: 'Evening Star',
      side: -1,
      strength: 0.8,
      reason: 'รูปแบบ 3 แท่งกลับตัวขาลง: เขียวใหญ่ → แท่งลังเล → แดงใหญ่ปิดใต้กลางแท่งแรก',
    });
  }

  // Doji — ตลาดลังเล ไม่ให้ทิศทาง แต่เป็นสัญญาณ "ระวังพักตัว"
  if (b < range(c) * 0.1) {
    out.push({
      name: 'Doji',
      side: 0,
      strength: 0.4,
      reason: 'ราคาเปิด-ปิดเกือบเท่ากัน = ตลาดลังเล ยังไม่มีฝ่ายชนะ ควรรอแท่งยืนยัน',
    });
  }

  // Inside bar breakout — บีบตัวแล้วทะลุ
  if (p1.h < p2.h && p1.l > p2.l) {
    if (c.c > p2.h) out.push({ name: 'Inside Bar Breakout', side: 1, strength: 0.6, reason: 'ราคาบีบตัว (inside bar) แล้วทะลุกรอบบน = เริ่มรอบวิ่งใหม่ฝั่งขึ้น' });
    else if (c.c < p2.l) out.push({ name: 'Inside Bar Breakdown', side: -1, strength: 0.6, reason: 'ราคาบีบตัว (inside bar) แล้วหลุดกรอบล่าง = เริ่มรอบวิ่งใหม่ฝั่งลง' });
  }

  return out;
}
