/**
 * app.js — ตัวเชื่อมทุกส่วนเข้าด้วยกัน: ข้อมูลสด → วิเคราะห์ → กราฟ/เหตุผล → แจ้งเตือน
 */

import { MarketFeed, TF, mergeCandle } from './feed.js';
import { buildContext, scoreAt, buildSetup, combineTimeframes, explain, scoreLabel, DEFAULT_CFG, WEIGHTS } from './signals.js';
import { runBacktest, probabilityFor, wilsonInterval } from './backtest.js';
import { Chart } from './chart.js';
import { AlertCenter } from './alerts.js';
import { sessionInfo, riskWindow, nextNFP, thTime, xauToThaiBaht } from './macro.js';
import { levelsAt, fibLevels } from './levels.js';

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = 'goldtrader.settings.v1';

const state = {
  tf: '15m',
  candles: [],
  ctx: null,
  scored: null,
  combined: null,
  setup: null,
  action: 'wait',
  htf: {},          // { '1h': {candles, ctx, scored} }
  bt: null,
  lastAnalyze: 0,
  lastClosedT: null,
  analyzeTimer: null,
  events: [],
  prevClose: null,
  reasonTab: 'pro',
};

const settings = {
  source: 'binance', symbol: 'PAXGUSDT', tf: '15m', htf1: '1h', htf2: '4h',
  threshold: 35, slAtr: 1.5, adxMin: 22,
  account: 1000, riskPct: 1,
  newsFilter: true, volFilter: true, sessionFilter: false,
  usdThb: 36.5, apiKey: '',
  closedOnly: true, maxHold: 60, spread: 0.30,
};

const feed = new MarketFeed();
const alerts = new AlertCenter();
let chart, equityCtx;

// ── ตั้งค่า ──────────────────────────────────────────────────────────────
function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) { /* ค่าเริ่มต้น */ }
  try { state.events = JSON.parse(localStorage.getItem('goldtrader.events') || '[]'); } catch (e) { state.events = []; }
}
function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function saveEvents() {
  try { localStorage.setItem('goldtrader.events', JSON.stringify(state.events)); } catch (e) { /* ignore */ }
}
function cfg() {
  return { ...DEFAULT_CFG, slAtrMult: settings.slAtr, threshold: settings.threshold, adxTrendMin: settings.adxMin };
}

// ── เริ่มระบบ ────────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  state.tf = settings.tf;
  chart = new Chart($('chart'));
  equityCtx = $('equityCanvas').getContext('2d');
  buildStaticUI();
  bindEvents();
  window.addEventListener('resize', () => { chart.resize(); drawEquity(); });
  chart.resize();
  alerts.onUpdate = (entry) => { renderLog(); toast(entry); };
  renderAlertUI();
  renderWeights();
  renderContextTab();
  setInterval(renderContextTab, 30000);
  await reload();
}

function buildStaticUI() {
  const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  $('tfGroup').innerHTML = tfs.map((t) => `<button class="tf-btn${t === state.tf ? ' active' : ''}" data-tf="${t}">${t}</button>`).join('');
  const opts = tfs.map((t) => `<option value="${t}">${t} — ${TF[t].label}</option>`).join('');
  $('setHtf1').innerHTML = opts; $('setHtf2').innerHTML = opts;
  $('setHtf1').value = settings.htf1; $('setHtf2').value = settings.htf2;
  $('sourceSel').value = settings.source;
  $('symbolSel').value = settings.symbol;
  $('accountInput').value = settings.account;
  $('riskInput').value = settings.riskPct;
  $('thresholdInput').value = settings.threshold;
  $('setThreshold').value = settings.threshold;
  $('setSlAtr').value = settings.slAtr;
  $('setAdx').value = settings.adxMin;
  $('setUsdThb').value = settings.usdThb;
  $('setApiKey').value = settings.apiKey;
  $('maxHoldInput').value = settings.maxHold;
  $('spreadInput').value = settings.spread;
  $('setNewsFilter').checked = settings.newsFilter;
  $('setVolFilter').checked = settings.volFilter;
  $('setSessionFilter').checked = settings.sessionFilter;
  $('togClosedOnly').checked = settings.closedOnly;
}

function bindEvents() {
  $('tfGroup').addEventListener('click', (e) => {
    const b = e.target.closest('.tf-btn');
    if (!b) return;
    state.tf = settings.tf = b.dataset.tf;
    saveSettings();
    document.querySelectorAll('.tf-btn').forEach((x) => x.classList.toggle('active', x === b));
    reload();
  });
  $('sourceSel').addEventListener('change', (e) => {
    settings.source = e.target.value; saveSettings();
    $('symbolSel').disabled = settings.source !== 'binance';
    reload();
  });
  $('symbolSel').addEventListener('change', (e) => { settings.symbol = e.target.value; saveSettings(); reload(); });
  $('reloadBtn').addEventListener('click', () => reload());
  $('resetZoom').addEventListener('click', () => chart.scrollToEnd());

  $('togBB').addEventListener('change', (e) => { chart.showBB = e.target.checked; chart.render(); });
  $('togLevels').addEventListener('change', (e) => { chart.showLevels = e.target.checked; chart.render(); });
  $('togRSI').addEventListener('change', (e) => { chart.panels.rsi = e.target.checked; chart.render(); });
  $('togMACD').addEventListener('change', (e) => { chart.panels.macd = e.target.checked; chart.render(); });
  $('togMarkers').addEventListener('change', (e) => {
    chart.setData({ markers: e.target.checked && state.bt ? state.bt.trades.map((t) => ({ index: t.index, side: t.side })) : [] });
    chart.render();
  });

  ['accountInput', 'riskInput'].forEach((id) => $(id).addEventListener('input', () => {
    settings.account = +$('accountInput').value || 1000;
    settings.riskPct = +$('riskInput').value || 1;
    saveSettings();
    if (state.scored) { renderPlan(); }
  }));

  $('runBt').addEventListener('click', () => doBacktest());
  ['thresholdInput', 'maxHoldInput', 'spreadInput'].forEach((id) => $(id).addEventListener('change', () => {
    settings.threshold = +$('thresholdInput').value || 35;
    settings.maxHold = +$('maxHoldInput').value || 60;
    settings.spread = +$('spreadInput').value || 0;
    $('setThreshold').value = settings.threshold;
    saveSettings();
  }));
  ['setThreshold', 'setSlAtr', 'setAdx'].forEach((id) => $(id).addEventListener('change', () => {
    settings.threshold = +$('setThreshold').value || 35;
    settings.slAtr = +$('setSlAtr').value || 1.5;
    settings.adxMin = +$('setAdx').value || 22;
    $('thresholdInput').value = settings.threshold;
    saveSettings(); analyze(true, false);
  }));
  $('setHtf1').addEventListener('change', (e) => { settings.htf1 = e.target.value; saveSettings(); reload(); });
  $('setHtf2').addEventListener('change', (e) => { settings.htf2 = e.target.value; saveSettings(); reload(); });
  ['setNewsFilter', 'setVolFilter', 'setSessionFilter'].forEach((id) => $(id).addEventListener('change', () => {
    settings.newsFilter = $('setNewsFilter').checked;
    settings.volFilter = $('setVolFilter').checked;
    settings.sessionFilter = $('setSessionFilter').checked;
    saveSettings(); analyze(true, false);
  }));
  $('setUsdThb').addEventListener('change', (e) => { settings.usdThb = +e.target.value || 36.5; saveSettings(); updatePriceHeader(); });
  $('setApiKey').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'backtest') drawEquity();
  }));
  document.querySelectorAll('.rtab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.reasonTab = t.dataset.r;
    renderReasons();
  }));

  // แจ้งเตือน
  $('enableNotif').addEventListener('click', async () => {
    const res = await alerts.requestDesktopPermission();
    toast({ kind: 'info', title: res === 'granted' ? 'เปิดแจ้งเตือนแล้ว' : 'ไม่ได้รับอนุญาต', body: res === 'granted' ? 'จะเด้งแจ้งเตือนแม้สลับแท็บอยู่' : 'อนุญาตได้ที่ไอคอนกุญแจข้าง URL' });
    alerts.playSound('info');
  });
  $('togSound').addEventListener('change', (e) => { alerts.sound = e.target.checked; alerts.save(); if (e.target.checked) alerts.playSound('info'); });
  $('togSpeak').addEventListener('change', (e) => { alerts.speak = e.target.checked; alerts.save(); });
  $('togClosedOnly').addEventListener('change', (e) => { settings.closedOnly = e.target.checked; saveSettings(); });
  $('cooldownInput').addEventListener('change', (e) => { alerts.cooldownMs = (+e.target.value || 0) * 60000; alerts.save(); });
  $('webhookInput').addEventListener('change', (e) => { alerts.webhookUrl = e.target.value.trim(); alerts.save(); });
  $('addRule').addEventListener('click', () => {
    const value = +$('ruleValue').value;
    if (!value) return;
    alerts.addRule({ type: $('ruleType').value, value, once: $('ruleOnce').checked });
    $('ruleValue').value = '';
    renderRules();
  });
  $('clearLog').addEventListener('click', () => { alerts.clearLog(); renderLog(); });
  $('addEvent').addEventListener('click', () => {
    const title = $('evTitle').value.trim();
    const time = $('evTime').value;
    if (!title || !time) return;
    state.events.push({ title, time: new Date(time).toISOString(), impact: 'high' });
    saveEvents(); $('evTitle').value = ''; $('evTime').value = '';
    renderContextTab();
  });
}

// ── โหลดข้อมูล ───────────────────────────────────────────────────────────
async function reload() {
  feed.stop();
  feed.configure({ source: settings.source, symbol: settings.symbol, interval: state.tf, apiKey: settings.apiKey });
  setStatus('loading', `กำลังโหลด ${settings.symbol} ${state.tf}…`);
  try {
    state.candles = await feed.loadHistory(state.tf, 1000);
    if (!state.candles.length) throw new Error('ไม่มีข้อมูลย้อนหลัง');
    state.htf = {};
    for (const tf of [settings.htf1, settings.htf2]) {
      if (tf === state.tf) continue;
      try {
        const c = await feed.loadHistory(tf, 400);
        state.htf[tf] = { candles: c };
      } catch (e) { /* กรอบใหญ่โหลดไม่ได้ก็ยังวิเคราะห์กรอบหลักได้ */ }
    }
    state.prevClose = state.candles.length > 1 ? state.candles[state.candles.length - 2].c : null;
    const lastClosed = [...state.candles].reverse().find((c) => c.closed !== false);
    state.lastClosedT = lastClosed ? lastClosed.t : null;
    // วิเคราะห์ครั้งแรกแบบไม่แจ้งเตือน — สัญญาณที่ค้างอยู่ตั้งแต่ก่อนเปิดหน้าไม่ใช่ "สัญญาณใหม่"
    analyze(true, false);
    doBacktest();
    renderContextTab();
    feed.start(onLiveCandle, (s) => setStatus(s.state, s.message));
    setInterval(refreshHtf, 60000);
  } catch (e) {
    setStatus('error', e.message);
    toast({ kind: 'info', title: 'โหลดข้อมูลไม่สำเร็จ', body: e.message });
  }
}

async function refreshHtf() {
  for (const tf of Object.keys(state.htf)) {
    try { state.htf[tf].candles = await feed.loadHistory(tf, 400); } catch (e) { /* ครั้งหน้าค่อยลองใหม่ */ }
  }
}

function onLiveCandle(k) {
  const res = mergeCandle(state.candles, k);
  if (res.stale) return;
  if (res.appended && state.candles.length > 1) state.prevClose = state.candles[state.candles.length - 2].c;
  updatePriceHeader();
  alerts.checkRules({ price: k.c, rsi: state.ctx && state.scored ? state.scored.rsi : null, score: state.combined ? state.combined.score : 0 });

  // "แท่งปิด" คือเหตุการณ์ที่ข้อมูลของแท่งนั้นสมบูรณ์แล้ว — ต้องให้คะแนนตอนนี้
  // ไม่ใช่ตอนแท่งใหม่เพิ่งเปิด (แท่งที่เพิ่งเปิดมีแค่ราคาเดียว รูปแบบแท่งเทียนยังอ่านไม่ได้)
  if (k.closed && k.t !== state.lastClosedT) {
    state.lastClosedT = k.t;
    analyze(true);
    return;
  }
  scheduleAnalyze(false);
}

function scheduleAnalyze() {
  const now = Date.now();
  if (now - state.lastAnalyze > 2000) { analyze(false); return; }
  clearTimeout(state.analyzeTimer);
  state.analyzeTimer = setTimeout(() => analyze(false), 2000);
}

// ── วิเคราะห์ ────────────────────────────────────────────────────────────
function analyze(candleClosed, allowAlert = true) {
  if (!state.candles.length) return;
  state.lastAnalyze = Date.now();
  const conf = cfg();
  state.ctx = buildContext(state.candles, conf);
  const last = state.candles.length - 1;
  state.scored = scoreAt(state.ctx, last);

  for (const tf of Object.keys(state.htf)) {
    const h = state.htf[tf];
    if (!h.candles || h.candles.length < 60) continue;
    h.ctx = buildContext(h.candles, conf);
    h.scored = scoreAt(h.ctx, h.candles.length - 1);
  }
  const h1 = state.htf[settings.htf1] ? state.htf[settings.htf1].scored : null;
  const h2 = state.htf[settings.htf2] ? state.htf[settings.htf2].scored : null;
  state.combined = combineTimeframes(state.scored, h1, h2);

  // ตัวกรองความปลอดภัย
  const blocks = [];
  const sess = sessionInfo(new Date());
  const risk = riskWindow(new Date(), state.events, 30);
  if (settings.newsFilter && risk.blocked) {
    blocks.push(`อยู่ในช่วง ±30 นาทีรอบข่าว: ${risk.active.map((e) => e.title).join(', ')} — สเปรดถ่างและราคาสวิงสองทาง สถิติของสัญญาณเทคนิคใช้ไม่ได้ในช่วงนี้`);
  }
  if (settings.volFilter && state.scored.ready) {
    if (state.scored.atrPct < conf.minAtrPct) blocks.push(`ความผันผวนต่ำผิดปกติ (ATR ${state.scored.atrPct.toFixed(3)}% ของราคา) — ระยะทางกำไรอาจไม่คุ้มสเปรด`);
    if (state.scored.atrPct > conf.maxAtrPct) blocks.push(`ความผันผวนสูงผิดปกติ (ATR ${state.scored.atrPct.toFixed(2)}% ของราคา) — มักเกิดตอนข่าวแรง ความเสี่ยงต่อไม้สูงกว่าที่คำนวณ`);
  }
  if (settings.sessionFilter && sess.quality < 0.6) {
    blocks.push(`อยู่นอกช่วงตลาดหลัก (${sess.label}) — สภาพคล่องบาง สัญญาณเบรกหลอกบ่อย`);
  }
  state.blocks = blocks;

  const score = state.combined.score;
  const passes = Math.abs(score) >= settings.threshold && blocks.length === 0 && state.scored.ready;
  state.action = passes ? (score > 0 ? 'buy' : 'sell') : 'wait';

  const livePrice = state.candles[last].c;
  state.setup = state.scored.ready && Math.abs(score) >= settings.threshold
    ? buildSetup(state.ctx, last, { ...state.scored, side: Math.sign(score) }, {
        account: settings.account, riskPct: settings.riskPct, entryPrice: livePrice, side: Math.sign(score),
      })
    : null;

  renderAll();
  if (candleClosed) renderContextTab();
  chart.setData({
    candles: state.candles, ind: state.ctx, setup: state.setup,
    levels: buildLevelList(),
  });
  chart.render();

  if (state.action !== 'wait' && allowAlert) {
    const readyToFire = settings.closedOnly ? candleClosed : true;
    if (readyToFire && alerts.shouldFireSignal(state.action === 'buy' ? 1 : -1)) fireSignalAlert();
  }
}

function buildLevelList() {
  if (!state.ctx) return [];
  const i = state.candles.length - 1;
  const price = state.candles[i].c;
  const span = state.scored && state.scored.atr ? state.scored.atr * 12 : price * 0.05;
  return levelsAt(state.ctx.zones, i)
    .filter((z) => z.touches >= 2 && Math.abs(z.price - price) < span)
    .map((z) => ({ price: z.price, touches: z.touches, type: z.price <= price ? 'support' : 'resistance' }))
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8);
}

function fireSignalAlert() {
  const s = state.setup;
  const prob = probabilityFor(state.combined.score, state.bt);
  const ex = explain({ ...state.scored, side: Math.sign(state.combined.score) });
  const top = ex.pro.slice(0, 3).map((f) => `• ${f.name}`).join('\n');
  const body = [
    `${state.action === 'buy' ? '🟢 สัญญาณซื้อ' : '🔴 สัญญาณขาย'} ${settings.symbol} ${state.tf}`,
    `คะแนน ${state.combined.score.toFixed(1)} · โอกาสถึง 1R ${prob.p !== null ? prob.p.toFixed(0) + '%' : 'ยังไม่มีสถิติ'}`,
    s ? s.plan : '',
    top,
  ].filter(Boolean).join('\n');
  alerts.fire({
    kind: state.action,
    title: `${state.action === 'buy' ? '🟢 เข้าซื้อ' : '🔴 เข้าขาย'} ${settings.symbol} @ ${state.candles[state.candles.length - 1].c.toFixed(2)}`,
    body,
    price: state.candles[state.candles.length - 1].c,
    score: state.combined.score,
  });
}

// ── แสดงผล ──────────────────────────────────────────────────────────────
function renderAll() {
  updatePriceHeader();
  renderSignal();
  renderPlan();
  renderReasons();
  renderMTF();
}

function updatePriceHeader() {
  const last = state.candles[state.candles.length - 1];
  if (!last) return;
  $('livePrice').textContent = last.c.toFixed(2);
  const base = state.prevClose || last.o;
  const chg = last.c - base;
  const pct = (chg / base) * 100;
  const el = $('priceChange');
  el.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)} (${pct.toFixed(2)}%)`;
  el.className = 'chg ' + (chg >= 0 ? 'up' : 'down');
  $('thbPrice').textContent = `≈ ${Math.round(xauToThaiBaht(last.c, settings.usdThb)).toLocaleString('th-TH')} บาท/บาททองคำ (96.5%)`;
}

function renderSignal() {
  const score = state.combined ? state.combined.score : 0;
  const lbl = scoreLabel(score, settings.threshold);
  const card = $('signalCard');
  card.className = 'card signal-card ' + (state.action === 'wait' ? '' : state.action);
  const act = $('actionText');
  act.className = 'action ' + state.action;
  act.textContent = state.action === 'buy' ? '🟢 เข้าซื้อ (BUY)' : state.action === 'sell' ? '🔴 เข้าขาย (SELL)' : '⏸ รอจังหวะ';
  $('gradeText').className = 'grade ' + lbl.cls;
  $('gradeText').textContent = lbl.text;
  $('scoreText').textContent = score.toFixed(1);
  const fill = $('gaugeFill');
  const pct = Math.min(50, Math.abs(score) / 2);
  fill.className = 'gauge-fill ' + (score > 0 ? 'buy' : score < 0 ? 'sell' : '');
  fill.style.left = score >= 0 ? '50%' : `${50 - pct}%`;
  fill.style.width = `${pct}%`;

  const hasSignal = Math.abs(score) >= settings.threshold;
  const prob = probabilityFor(score, state.bt);
  if (!hasSignal) {
    $('probValue').textContent = '—';
    $('probValue').style.color = 'var(--muted)';
    $('probNote').textContent = `คะแนนยังไม่ถึงเกณฑ์ ${settings.threshold} จึงยังไม่มีสถิติของ "ไม้นี้" ให้อ้างอิง`;
  } else {
    $('probValue').textContent = prob.p !== null ? `${prob.p.toFixed(0)}%` : '—';
    $('probValue').style.color = prob.p === null ? 'var(--muted)' : prob.p >= 55 ? 'var(--up)' : prob.p >= 45 ? 'var(--gold)' : 'var(--down)';
    $('probNote').textContent = prob.note + (prob.avgR != null ? ` · ค่าคาดหวังต่อไม้ ${prob.avgR.toFixed(2)}R` : '');
  }

  const last = state.candles[state.candles.length - 1];
  const closedInfo = last && last.closed === false ? 'แท่งปัจจุบันยังไม่ปิด — คะแนนอาจเปลี่ยนได้จนกว่าแท่งจะปิด' : 'คำนวณจากแท่งที่ปิดแล้ว';
  const parts = [];
  parts.push(`⏱ ${closedInfo}`);
  if (state.scored && state.scored.ready) {
    parts.push(`สภาพตลาด: <b>${state.scored.regime === 'trend' ? 'มีเทรนด์ (ใช้กลยุทธ์ตามแนวโน้ม)' : 'ออกข้าง (ใช้กลยุทธ์เด้งกลับค่าเฉลี่ย)'}</b> · ADX ${state.scored.adx ? state.scored.adx.toFixed(1) : '-'} · ATR ${state.scored.atr.toFixed(2)} (${state.scored.atrPct.toFixed(2)}%)`);
  }
  if (state.blocks && state.blocks.length) {
    parts.push(`<span style="color:var(--gold)">⛔ ระงับสัญญาณ: ${state.blocks.join(' · ')}</span>`);
  }
  $('candleState').innerHTML = parts.join('<br>');
}

function renderPlan() {
  const box = $('planBox');
  const sizeBox = $('sizeBox');
  if (!state.setup) {
    box.className = 'plan-empty';
    box.textContent = state.scored && state.scored.ready
      ? `คะแนนปัจจุบัน ${state.combined.score.toFixed(1)} ยังไม่ถึงเกณฑ์ ${settings.threshold} — การไม่เข้าเทรดคือการตัดสินใจอย่างหนึ่ง`
      : 'ข้อมูลยังไม่พอสำหรับคำนวณ (ต้องการอย่างน้อย ~200 แท่ง)';
    sizeBox.innerHTML = '';
    sizeBox.style.display = 'none';
    return;
  }
  const s = state.setup;
  // คำนวณใหม่ตามทุน/ความเสี่ยงล่าสุด
  const riskMoney = settings.account * (settings.riskPct / 100);
  const lots = s.slDist > 0 ? riskMoney / (s.slDist * 100) : 0;
  box.className = 'plan-rows';
  const gate = state.action === 'wait'
    ? `<div class="plan-row" style="border-left:3px solid var(--gold)"><span style="color:var(--gold)">⚠ แผนอ้างอิงเท่านั้น — ยังไม่ใช่ไฟเขียวให้เข้า</span><span></span></div>`
    : '';
  box.innerHTML = gate + `
    <div class="plan-row tp"><span>เป้าที่ 3 (${(Math.abs(s.tp3 - s.entry) / s.slDist).toFixed(1)}R)</span><span>${s.tp3.toFixed(2)}</span></div>
    <div class="plan-row tp"><span>เป้าที่ 2 (2R)</span><span>${s.tp2.toFixed(2)}</span></div>
    <div class="plan-row tp"><span>เป้าที่ 1 (1R) — ปิดครึ่ง</span><span>${s.tp1.toFixed(2)}</span></div>
    <div class="plan-row entry"><span>${s.side > 0 ? 'จุดเข้าซื้อ' : 'จุดเข้าขาย'}</span><span>${s.entry.toFixed(2)}</span></div>
    <div class="plan-row sl"><span>ตัดขาดทุน (${s.slAtr.toFixed(1)}× ATR)</span><span>${s.sl.toFixed(2)}</span></div>
    ${s.notes.length ? `<ul class="plan-notes">${s.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}`;
  sizeBox.style.display = '';
  sizeBox.innerHTML = `
    เสี่ยงไม้นี้ <b>$${riskMoney.toFixed(2)}</b> (${settings.riskPct}% ของ $${settings.account})<br>
    ระยะ SL <b>${s.slDist.toFixed(2)} USD</b> → ขนาดไม้ <b>${lots.toFixed(3)} lot</b> (≈ ${(lots * 100).toFixed(1)} ออนซ์)<br>
    ถึงเป้า 2R = กำไร <b>$${(riskMoney * 2).toFixed(2)}</b> · แผนบริหาร: ปิดครึ่งที่ 1R แล้วเลื่อน SL มาที่ทุน`;
}

function renderReasons() {
  const list = $('reasonList');
  if (!state.scored || !state.scored.ready) { list.innerHTML = ''; return; }
  const side = Math.sign(state.combined.score) || 1;
  const ex = explain({ ...state.scored, side });
  $('reasonCount').textContent = `(${ex.pro.length} สนับสนุน / ${ex.con.length} ค้าน)`;

  let items = [];
  if (state.reasonTab === 'pro') items = ex.pro.map((f) => ({ ...f, cls: 'pos' }));
  else if (state.reasonTab === 'con') items = ex.con.map((f) => ({ ...f, cls: 'neg' }));
  else {
    const sess = sessionInfo(new Date());
    const risk = riskWindow(new Date(), state.events, 30);
    items = [
      { name: `ช่วงตลาด: ${sess.label}`, reason: sess.detail, weight: null, cls: '' },
      { name: `โครงสร้างราคา: ${state.scored.structure.label}`, reason: state.scored.structure.detail, weight: null, cls: '' },
      ...state.combined.notes.map((n) => ({ name: 'หลายกรอบเวลา', reason: n, weight: null, cls: '' })),
      ...ex.neutral.map((f) => ({ name: f.name, reason: f.reason, weight: null, cls: '' })),
      ...(risk.upcoming.length ? [{ name: 'ข่าวที่กำลังจะมา', reason: risk.upcoming.map((e) => `${e.title} — ${thTime(e.time)}`).join(' · '), weight: null, cls: '' }] : []),
      ...(state.blocks || []).map((b) => ({ name: '⛔ เหตุผลที่ยังไม่ควรเข้า', reason: b, weight: null, cls: 'neg' })),
    ];
  }
  list.innerHTML = items.map((f) => `
    <div class="reason ${f.cls}">
      <div class="reason-head"><span>${f.name}</span>${f.weight ? `<span class="w">${f.contribution > 0 ? '+' : ''}${f.contribution.toFixed(1)} / ${f.weight}</span>` : ''}</div>
      <p>${f.reason}</p>
    </div>`).join('');
}

function renderMTF() {
  const rows = [{ tf: state.tf, s: state.scored, main: true }];
  for (const tf of [settings.htf1, settings.htf2]) {
    if (tf === state.tf) continue;
    rows.push({ tf, s: state.htf[tf] ? state.htf[tf].scored : null });
  }
  $('mtfBox').innerHTML = rows.map((r) => {
    const sc = r.s && r.s.ready ? r.s.score : 0;
    const w = Math.min(50, Math.abs(sc) / 2);
    const color = sc > 0 ? 'var(--up)' : sc < 0 ? 'var(--down)' : 'var(--muted)';
    return `<div class="mtf-row">
      <span>${r.tf}${r.main ? ' ★' : ''}</span>
      <div class="mtf-bar"><i style="background:${color}; ${sc >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`}"></i></div>
      <span class="mtf-val" style="color:${color}">${r.s && r.s.ready ? sc.toFixed(0) : '—'}</span>
    </div>`;
  }).join('') + `<div class="tiny">คะแนนรวมถ่วงน้ำหนัก 55% / 30% / 15% = <b style="color:${state.combined && state.combined.score > 0 ? 'var(--up)' : 'var(--down)'}">${state.combined ? state.combined.score.toFixed(1) : '—'}</b></div>`;
}

// ── Backtest ────────────────────────────────────────────────────────────
function doBacktest() {
  if (!state.ctx || state.candles.length < 260) {
    $('btStatus').textContent = 'ข้อมูลน้อยเกินไปสำหรับทดสอบย้อนหลัง (ต้องการ ~260 แท่งขึ้นไป)';
    return;
  }
  $('btStatus').textContent = 'กำลังคำนวณ…';
  setTimeout(() => {
    const t0 = performance.now();
    state.bt = runBacktest(state.ctx, {
      threshold: settings.threshold, maxHold: settings.maxHold,
      spread: settings.spread, useFilters: settings.volFilter,
    });
    $('btStatus').textContent = `เสร็จใน ${(performance.now() - t0).toFixed(0)} มิลลิวินาที · ข้อมูล ${state.candles.length} แท่ง (${TF[state.tf].label})`;
    renderBacktest();
    renderSignal();
    if ($('togMarkers').checked) {
      chart.setData({ markers: state.bt.trades.map((t) => ({ index: t.index, side: t.side })) });
      chart.render();
    }
  }, 20);
}

function renderBacktest() {
  const bt = state.bt;
  if (!bt) return;
  const s = bt.stats;
  if (!s.n) {
    $('btSummary').innerHTML = '<div class="stat"><b>0</b><span>ไม่พบสัญญาณที่ผ่านเกณฑ์ในข้อมูลชุดนี้ — ลองลดคะแนนขั้นต่ำ</span></div>';
    $('btBands').innerHTML = ''; $('btSessions').innerHTML = ''; $('btTrades').innerHTML = '';
    drawEquity();
    return;
  }
  const ci = wilsonInterval(bt.trades.filter((t) => t.hit1R).length, s.n);
  const stat = (label, value, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('btSummary').innerHTML = [
    stat('จำนวนไม้ที่ระบบเข้า', s.n),
    stat('อัตราถึงเป้า 1R', `${s.winRate.toFixed(1)}%`, s.winRate >= 50 ? 'good' : 'bad'),
    stat('ช่วงเชื่อมั่น 95%', ci ? `${ci.low.toFixed(0)}–${ci.high.toFixed(0)}%` : '—'),
    stat('ค่าคาดหวังต่อไม้', `${s.expectancy.toFixed(3)}R`, s.expectancy > 0 ? 'good' : 'bad'),
    stat('กำไรรวม', `${s.totalR.toFixed(1)}R`, s.totalR > 0 ? 'good' : 'bad'),
    stat('Profit Factor', s.profitFactor ? s.profitFactor.toFixed(2) : '∞', s.profitFactor >= 1.3 ? 'good' : 'bad'),
    stat('ขาดทุนสูงสุดสะสม', `-${s.maxDD.toFixed(1)}R`, s.maxDD > 8 ? 'bad' : ''),
    stat('แพ้ติดกันสูงสุด', `${s.maxLossStreak} ไม้`),
    stat('เฉลี่ยถือกี่แท่ง', s.avgBars.toFixed(0)),
    stat('ไม้ที่ชนะวิ่งไปเฉลี่ย', s.avgMaxFavWinners ? `${s.avgMaxFavWinners.toFixed(2)}R` : '—'),
  ].join('');

  const expl = s.expectancy > 0.05
    ? `<p class="tiny" style="color:var(--up)">ค่าคาดหวัง +${s.expectancy.toFixed(3)}R ต่อไม้ หมายความว่าถ้าเสี่ยง $${(settings.account * settings.riskPct / 100).toFixed(0)} ต่อไม้ ระบบนี้ให้ผลเฉลี่ย ~$${(settings.account * settings.riskPct / 100 * s.expectancy).toFixed(2)} ต่อไม้ในข้อมูลชุดนี้ — และเคยขาดทุนติดกันสูงสุด ${s.maxLossStreak} ไม้ ต้องมีทุนและใจพอทนช่วงนั้น</p>`
    : `<p class="tiny" style="color:var(--down)">ค่าคาดหวังติดลบในข้อมูลชุดนี้ — ยังไม่ควรเทรดตามเกณฑ์ปัจจุบัน ลองเพิ่มคะแนนขั้นต่ำ เปลี่ยนกรอบเวลา หรือดูตารางช่วงเวลาว่าควรเลี่ยงชั่วโมงไหน</p>`;
  $('btSummary').innerHTML += `<div style="grid-column:1/-1">${expl}</div>`;

  const maxN = Math.max(...bt.bands.map((b) => b.n), 1);
  $('btBands').innerHTML = `<table><thead><tr><th>ช่วงคะแนน</th><th>จำนวนไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.bands.map((b) => `<tr class="${b.winRate !== null && b.winRate === Math.max(...bt.bands.filter((x) => x.n >= 10).map((x) => x.winRate || 0)) && b.n >= 10 ? 'best' : ''}">
      <td>${b.label}</td>
      <td class="num bar-cell"><i style="width:${(b.n / maxN) * 100}%"></i>${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td>
    </tr>`).join('')}</tbody></table>
    <p class="tiny">ยิ่งคะแนนสูง อัตราชนะควรยิ่งสูงตาม — ถ้าไม่เป็นเช่นนั้นแปลว่าน้ำหนักปัจจัยยังไม่เหมาะกับตลาดช่วงนี้ (ตัวอย่างต่ำกว่า 20 ไม้ ยังสรุปไม่ได้)</p>`;

  const bestSess = bt.sessions.filter((x) => x.n >= 8).sort((a, b) => (b.winRate || 0) - (a.winRate || 0))[0];
  $('btSessions').innerHTML = `<table><thead><tr><th>ช่วงเวลา</th><th>ไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.sessions.map((b) => `<tr class="${bestSess && b.key === bestSess.key ? 'best' : ''}">
      <td>${b.label}</td><td class="num">${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td>
    </tr>`).join('')}</tbody></table>
    ${bestSess ? `<p class="tiny">ช่วงที่ระบบทำผลงานดีที่สุดในข้อมูลชุดนี้คือ <b>${bestSess.label}</b> (${bestSess.winRate.toFixed(0)}% จาก ${bestSess.n} ไม้) — ใช้เป็นแนวทางเลือก "จังหวะเวลา" เข้าเทรด</p>` : ''}
    <table style="margin-top:10px"><thead><tr><th>ทิศทาง</th><th>ไม้</th><th>อัตราชนะ</th><th>ค่าคาดหวัง</th></tr></thead><tbody>
    ${bt.bySide.map((b) => `<tr><td>${b.side > 0 ? 'ฝั่งซื้อ (Long)' : 'ฝั่งขาย (Short)'}</td><td class="num">${b.n}</td>
      <td class="num">${b.winRate !== null ? b.winRate.toFixed(1) + '%' : '—'}</td>
      <td class="num">${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td></tr>`).join('')}</tbody></table>`;

  const recent = bt.trades.slice(-12).reverse();
  $('btTrades').innerHTML = `<h3 style="margin-top:16px">12 ไม้ล่าสุดที่ระบบเข้า</h3>
    <table><thead><tr><th>เวลา (ไทย)</th><th>ทิศทาง</th><th>คะแนน</th><th>เข้า</th><th>SL</th><th>ผล</th><th>R</th></tr></thead><tbody>
    ${recent.map((t) => `<tr>
      <td>${thTime(t.t)}</td>
      <td style="color:${t.side > 0 ? 'var(--up)' : 'var(--down)'}">${t.side > 0 ? 'ซื้อ' : 'ขาย'}</td>
      <td class="num">${t.score.toFixed(0)}</td>
      <td class="num">${t.entry.toFixed(2)}</td>
      <td class="num">${t.sl.toFixed(2)}</td>
      <td>${t.result === 'loss' ? 'โดน SL' : t.result === 'timeout' ? 'หมดเวลาถือ' : t.result === 'win2R' ? 'ถึง 2R' : 'ถึง 1R แล้วกลับมาทุน'}</td>
      <td class="num" style="color:${t.rMultiple > 0 ? 'var(--up)' : 'var(--down)'}">${t.rMultiple.toFixed(2)}</td>
    </tr>`).join('')}</tbody></table>`;
  drawEquity();
}

function drawEquity() {
  const cv = $('equityCanvas');
  const g = equityCtx;
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = 150;
  cv.width = w * dpr; cv.height = h * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const eq = state.bt ? state.bt.equity : [];
  if (!eq.length) {
    g.fillStyle = '#94a3b8'; g.font = '12px system-ui'; g.textAlign = 'center';
    g.fillText('ยังไม่มีผลทดสอบ', w / 2, h / 2); g.textAlign = 'left';
    return;
  }
  const vals = eq.map((e) => e.eq);
  const min = Math.min(0, ...vals), max = Math.max(0.5, ...vals);
  const x = (i) => 8 + (i / Math.max(1, eq.length - 1)) * (w - 16);
  const y = (v) => 12 + ((max - v) / (max - min)) * (h - 28);
  g.strokeStyle = 'rgba(148,163,184,0.25)';
  g.beginPath(); g.moveTo(8, y(0)); g.lineTo(w - 8, y(0)); g.stroke();
  g.beginPath();
  g.moveTo(x(0), y(vals[0]));
  vals.forEach((v, i) => g.lineTo(x(i), y(v)));
  g.strokeStyle = vals[vals.length - 1] >= 0 ? '#22c55e' : '#ef4444';
  g.lineWidth = 1.8; g.stroke();
  g.lineTo(x(vals.length - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
  g.fillStyle = vals[vals.length - 1] >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  g.fill();
  g.fillStyle = '#94a3b8'; g.font = '10px ui-monospace, monospace';
  g.fillText(`${max.toFixed(1)}R`, 10, 12);
  g.fillText(`${min.toFixed(1)}R`, 10, h - 6);
}

// ── บริบทตลาด ───────────────────────────────────────────────────────────
function renderContextTab() {
  const now = new Date();
  const sess = sessionInfo(now);
  const risk = riskWindow(now, state.events, 30);
  $('sessionBox').innerHTML = `
    <div class="kv"><span>ช่วงตลาด</span><span>${sess.label}</span></div>
    <div class="kv"><span>คุณภาพสภาพคล่อง</span><span>${(sess.quality * 100).toFixed(0)}%</span></div>
    <div class="kv"><span>เวลาไทยตอนนี้</span><span>${now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}</span></div>
    <p class="tiny">${sess.detail}</p>`;

  const nfp = nextNFP(now);
  $('newsBox').innerHTML = [
    risk.blocked ? `<div class="news-item"><span class="badge hot">กำลังอยู่ในช่วงข่าว</span><span>${risk.active.map((e) => e.title).join(', ')}</span></div>` : '',
    `<div class="news-item"><span>US Non-Farm Payrolls (คำนวณอัตโนมัติ)</span><span>${nfp ? thTime(nfp) : '—'}</span></div>`,
    ...state.events.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map((e, i) => `
      <div class="news-item"><span>${e.title}</span><span>${thTime(e.time)} <button class="btn tiny-btn" data-ev="${i}">ลบ</button></span></div>`),
  ].join('');
  $('newsBox').querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
    const idx = +b.dataset.ev;
    const sorted = state.events.slice().sort((a, b2) => new Date(a.time) - new Date(b2.time));
    state.events = state.events.filter((e) => e !== sorted[idx]);
    saveEvents(); renderContextTab();
  }));

  if (state.scored && state.scored.ready) {
    const sc = state.scored;
    $('regimeBox').innerHTML = `
      <div class="kv"><span>โหมดตลาด</span><span>${sc.regime === 'trend' ? 'มีเทรนด์' : 'ออกข้าง'}</span></div>
      <div class="kv"><span>ADX(14)</span><span>${sc.adx ? sc.adx.toFixed(1) : '—'}</span></div>
      <div class="kv"><span>RSI(14)</span><span>${sc.rsi ? sc.rsi.toFixed(1) : '—'}</span></div>
      <div class="kv"><span>ATR(14)</span><span>${sc.atr.toFixed(2)} (${sc.atrPct.toFixed(2)}%)</span></div>
      <div class="kv"><span>โครงสร้าง</span><span>${sc.structure.label}</span></div>
      <div class="kv"><span>แนวรับใกล้สุด</span><span>${sc.support ? sc.support.toFixed(2) : '—'}</span></div>
      <div class="kv"><span>แนวต้านใกล้สุด</span><span>${sc.resistance ? sc.resistance.toFixed(2) : '—'}</span></div>
      ${fibHtml()}
      <p class="tiny">ATR คือระยะแกว่งเฉลี่ยต่อแท่ง ใช้ตั้ง SL ให้กว้างพอไม่โดน noise เขี่ยออก และใช้ประเมินว่าเป้าหมายที่ตั้งไว้ "ไปถึงได้จริงไหมในเวลาที่ถือ"</p>`;
  }

  if (state.candles.length) {
    const c = state.candles;
    const first = c[0], last = c[c.length - 1];
    const highs = c.map((x) => x.h), lows = c.map((x) => x.l);
    const hi = Math.max(...highs), lo = Math.min(...lows);
    const rets = c.slice(1).map((x, i) => Math.log(x.c / c[i].c));
    const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) * 100;
    $('statsBox').innerHTML = `
      <div class="kv"><span>ช่วงข้อมูล</span><span>${thTime(first.t)} → ${thTime(last.t)}</span></div>
      <div class="kv"><span>จำนวนแท่ง</span><span>${c.length} (${TF[state.tf].label})</span></div>
      <div class="kv"><span>สูงสุด / ต่ำสุด</span><span>${hi.toFixed(2)} / ${lo.toFixed(2)}</span></div>
      <div class="kv"><span>ผลตอบแทนรวม</span><span style="color:${last.c >= first.c ? 'var(--up)' : 'var(--down)'}">${(((last.c - first.c) / first.c) * 100).toFixed(2)}%</span></div>
      <div class="kv"><span>ผันผวนต่อแท่ง (SD)</span><span>${sd.toFixed(3)}%</span></div>
      <div class="kv"><span>ราคาทองไทยโดยประมาณ</span><span>${Math.round(xauToThaiBaht(last.c, settings.usdThb)).toLocaleString('th-TH')} บาท</span></div>
      <p class="tiny">ราคาทองไทยคำนวณจาก XAU/USD × ความบริสุทธิ์ 96.5% × น้ำหนัก 15.244 กรัม/บาท × อัตรา USD/THB ที่ตั้งไว้ — เป็นค่าอ้างอิงเชิงคำนวณ ไม่รวมค่ากันเหนียว/ส่วนต่างผู้ค้า จึงต่างจากราคาประกาศของสมาคมค้าทองคำได้</p>`;
  }
}

/** ระดับ Fibonacci ของขาล่าสุด — โซนที่ราคามักย่อมาแล้วไปต่อ (จังหวะเข้าไม้ที่ความเสี่ยงต่ำกว่าไล่ราคา) */
function fibHtml() {
  if (!state.ctx) return '';
  const i = state.candles.length - 1;
  const fib = fibLevels(state.ctx.pivots, i);
  if (!fib) return '';
  const price = state.candles[i].c;
  const rows = fib.levels.map((l) => {
    const hit = Math.abs(l.price - price) < (state.scored && state.scored.atr ? state.scored.atr * 0.4 : 0);
    return `<div class="kv"><span>${hit ? '➤ ' : ''}Fib ${(l.ratio * 100).toFixed(1)}%</span><span${hit ? ' style="color:var(--gold)"' : ''}>${l.price.toFixed(2)}</span></div>`;
  }).join('');
  return `<div style="margin-top:8px"><b style="font-size:11.5px;color:var(--muted)">แนวย่อ Fibonacci ของขา${fib.direction === 'up' ? 'ขึ้น' : 'ลง'}ล่าสุด (${fib.from.toFixed(2)} → ${fib.to.toFixed(2)})</b>${rows}</div>`;
}

function renderWeights() {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const names = {
    emaTrend: 'การเรียงตัวเส้นค่าเฉลี่ย', adxTrend: 'ความแรงเทรนด์ (ADX/DI)', macdMom: 'โมเมนตัม MACD',
    rsiMom: 'RSI ตามสภาพตลาด', structure: 'โครงสร้าง Swing (HH/HL)', patterns: 'รูปแบบแท่งเทียน',
    volume: 'ปริมาณซื้อขายยืนยัน', bands: 'Bollinger (บีบตัว/ขอบแบนด์)', levels: 'แนวรับ-แนวต้าน',
    divergence: 'RSI Divergence', vwap: 'ตำแหน่งเทียบ VWAP', stoch: 'Stochastic ตัดกัน',
  };
  $('weightBox').innerHTML = Object.entries(WEIGHTS).map(([k, w]) => `
    <div class="mtf-row"><span style="font-size:11px">${w}</span>
      <div class="mtf-bar"><i style="background:var(--accent);left:0;width:${(w / 20) * 100}%"></i></div>
      <span style="font-size:11px;text-align:left;white-space:nowrap">${names[k]}</span>
    </div>`).join('') + `<p class="tiny">น้ำหนักรวม ${total} — คะแนน 100 คือทุกปัจจัยเห็นตรงกันเต็มที่ (แทบไม่เกิดขึ้นจริง คะแนน 45+ ถือว่าแข็งแรงมากแล้ว)</p>`;
}

// ── แจ้งเตือน UI ────────────────────────────────────────────────────────
function renderAlertUI() {
  $('togSound').checked = alerts.sound;
  $('togSpeak').checked = alerts.speak;
  $('webhookInput').value = alerts.webhookUrl;
  $('cooldownInput').value = alerts.cooldownMs / 60000;
  renderRules();
  renderLog();
}

function renderRules() {
  const labels = { price_above: 'ราคา ≥', price_below: 'ราคา ≤', rsi_above: 'RSI ≥', rsi_below: 'RSI ≤' };
  $('ruleList').innerHTML = alerts.rules.length
    ? alerts.rules.map((r) => `<div class="rule-item">
        <span>${labels[r.type]} <b>${r.value}</b> ${r.once ? '(ครั้งเดียว)' : '(ทุกครั้ง)'} ${r.active ? '' : '<span class="badge">ทำงานแล้ว</span>'}</span>
        <button class="btn tiny-btn" data-rid="${r.id}">ลบ</button></div>`).join('')
    : '<p class="tiny">ยังไม่มีกฎ — เช่น ตั้งเตือนเมื่อราคาทะลุแนวต้านสำคัญ เพื่อไม่ต้องเฝ้าจอ</p>';
  $('ruleList').querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', () => {
    alerts.removeRule(+b.dataset.rid); renderRules();
  }));
}

function renderLog() {
  $('logList').innerHTML = alerts.log.length
    ? alerts.log.map((l) => `<div class="log-item ${l.kind}">
        <div class="lh"><span>${l.title}</span><span class="lt">${new Date(l.ts).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}</span></div>
        <div class="lb">${(l.body || '').replace(/\n/g, '<br>')}</div></div>`).join('')
    : '<p class="tiny">ยังไม่มีการแจ้งเตือน</p>';
}

function toast(entry) {
  const el = document.createElement('div');
  el.className = 'toast ' + (entry.kind || 'info');
  el.innerHTML = `<b>${entry.title}</b><p>${(entry.body || '').replace(/\n/g, '<br>')}</p>`;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 9000);
}

function setStatus(stateName, msg) {
  const dot = $('statusDot');
  dot.className = 'dot ' + (stateName === 'live' ? 'live' : stateName === 'error' ? 'error' : stateName === 'demo' ? 'demo' : '');
  $('statusText').textContent = msg;
}

init();
