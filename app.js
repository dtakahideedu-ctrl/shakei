/* 射形分析帳 — 画面と共有 */
(() => {
'use strict';
const K = Kyu;
const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = K.clamp;
const PH = K.PHASES;
const GROUPS = [
  ['dozukuri', '足踏み・胴造り', '体の土台'],
  ['uchiokoshi', '打起し', '頂点での形'],
  ['kai', '会', '引き収めた形'],
  ['hanare', '離れ・残心', '離れた後の形'],
  ['top', '頭上から', '2方向の動画を合成']
];
const VIEWNAME = { front: '正面', side: '馬手側', both: '2方向' };
const store = {
  get(k) { try { return localStorage.getItem('shakei.' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('shakei.' + k, v); } catch (e) { /* 保存できなくても動く */ } }
};

// ---------- 状態 ----------
const S = {
  sample: true, layout: '3d', t: 0, playing: false, rate: 0.5,
  layers: { skel: true, arrow: true, cross: true, trail: false },
  master: 'front', offset: 0, offsetAuto: 0, syncMethod: '', ph: null, metrics: [],
  heightCm: Number(store.get('height')) || 165,
  model: store.get('model') || 'thunder', fps: Number(store.get('fps')) || 10,
  busy: false,
  target: { src: null, w: 0, h: 0, calib: null, step: 0, marks: [], rightIsMae: true, shot: 0, tmp: {} }
};
const V = {};
for (const key of ['front', 'side']) {
  const pane = $('#pane-' + key);
  V[key] = {
    key, label: key === 'front' ? '正面' : '馬手側', pane, frame: $('.frame', pane), video: $('video', pane), canvas: $('canvas.ov', pane),
    hudPhase: $('.hud-phase', pane), hudVal: $('.hud-val', pane), msg: $('.pane-msg', pane), prog: $('.pane-prog', pane), cap: $('[data-cap]', pane),
    slot: $('#slot-' + key), file: null, url: null, track: null, status: 'empty', progress: 0, w: 0, h: 0, duration: 0, pick: null, liveK: null, sampleBg: false
  };
}

// ---------- 色 ----------
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const n of ['ink', 'muted', 'line', 'main', 'sub', 'yunde-ln', 'mete-ln', 'ya', 'guide', 'surface', 'sunk', 'bg', 'info-bg', 'ov-yunde', 'ov-mete', 'ov-ya', 'ov-guide', 'ov-trunk']) C[n] = cs.getPropertyValue('--' + n).trim();
}
readColors();
const redrawTheme = () => { readColors(); drawAll(); drawTimeline(); drawChart(); renderTarget(); };
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawTheme); } catch (e) { /* 古いブラウザ */ }
new MutationObserver(redrawTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
// 配色: 鉄紺メイン（既定）と臙脂メイン。この端末に覚えておく
function setPalette(p) {
  const enji = p === 'enji';
  if (enji) document.documentElement.setAttribute('data-palette', 'enji'); else document.documentElement.removeAttribute('data-palette');
  $$('#palette button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.palette === (enji ? 'enji' : 'tekkon'))));
  store.set('palette', enji ? 'enji' : 'tekkon');
}
$$('#palette button').forEach(b => b.addEventListener('click', () => setPalette(b.dataset.palette)));
setPalette(document.documentElement.getAttribute('data-palette') === 'enji' ? 'enji' : 'tekkon');

// ---------- 時刻 ----------
const masterTrack = () => V[S.master] && V[S.master].track;
function masterDuration() {
  const v = V[S.master];
  if (!v) return 0;
  return v.duration || (v.track ? v.track.duration : 0);
}
function viewTime(key, t) {
  if (key === S.master) return t;
  return S.master === 'front' ? t - S.offset : t + S.offset;
}
const fmtT = (t) => (Number.isFinite(t) ? t.toFixed(1) : '—');

// ---------- サンプル ----------
function loadSample() {
  const smp = K.makeSample();
  S.sample = true; $('#sampleBanner').hidden = false;
  for (const key of ['front', 'side']) {
    const v = V[key];
    const tr = K.prepareTrack(smp[key]);
    tr.phasesAuto = K.detectPhases(tr);
    Object.assign(v, { track: tr, status: 'done', w: tr.w, h: tr.h, duration: tr.duration, sampleBg: true, flip: null, by: null, partAt: null, partShot: null });
  }
  const tg = S.target;
  tg.src = makeSampleTargetImage(smp.target);
  tg.w = smp.target.w; tg.h = smp.target.h;
  tg.calib = { ...smp.target.calib }; tg.marks = smp.target.marks.map(m => ({ ...m })); tg.step = 3; tg.shot = 2;
  recompute(true);
  setTime(S.ph ? (S.ph.bounds[5] + S.ph.tHanare) / 2 : 0);
}
function makeSampleTargetImage(t) {
  const c = document.createElement('canvas'); c.width = t.w; c.height = t.h;
  const g = c.getContext('2d');
  // 安土の砂
  g.fillStyle = '#8c7a5c'; g.fillRect(0, 0, t.w, t.h);
  const rnd = (() => { let s = 3; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  for (let i = 0; i < 9000; i++) { g.fillStyle = rnd() > 0.5 ? 'rgba(255,240,210,.10)' : 'rgba(40,30,20,.12)'; g.fillRect(rnd() * t.w, rnd() * t.h, 2, 2); }
  const { cx, cy, rx, ry } = t.calib;
  g.save(); g.translate(cx, cy); g.scale(rx / 18, ry / 18);
  g.beginPath(); g.arc(0, 0, 18.9, 0, Math.PI * 2); g.fillStyle = '#c9b48a'; g.fill(); // 的枠
  const rings = [[18, '#16161a'], [14.7, '#f4f2ec'], [11.7, '#16161a'], [10.2, '#f4f2ec'], [7.2, '#16161a'], [3.6, '#f4f2ec']];
  for (const [r, col] of rings) { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = col; g.fill(); }
  g.restore();
  for (const m of t.marks) {
    g.save(); g.translate(m.x, m.y);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(4, 5, 11, 9, 0, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < 3; k++) { g.rotate(Math.PI * 2 / 3); g.fillStyle = k === 0 ? '#e9e2d0' : '#5a4632'; g.beginPath(); g.moveTo(0, 0); g.lineTo(-3, -16); g.lineTo(3, -16); g.closePath(); g.fill(); }
    g.beginPath(); g.arc(0, 0, 4, 0, Math.PI * 2); g.fillStyle = '#c99a3a'; g.fill(); g.strokeStyle = '#3b2a12'; g.lineWidth = 1.5; g.stroke();
    g.restore();
  }
  return c;
}
function exitSample() {
  if (!S.sample) return;
  S.sample = false;
  for (const v of Object.values(V)) { v.track = null; v.status = 'empty'; v.w = v.h = v.duration = 0; v.sampleBg = false; }
  const tg = S.target; tg.src = null; tg.calib = null; tg.marks = []; tg.step = 0; tg.shot = 0;
  $('#sampleBanner').hidden = true;
  S.ph = null; S.metrics = []; S.t = 0;
}

// ---------- 解析結果のまとめ ----------
function recompute(resetPhases) {
  const F = V.front.track, D = V.side.track;
  S.master = F ? 'front' : (D ? 'side' : (V.front.status !== 'empty' ? 'front' : (V.side.status !== 'empty' ? 'side' : 'front')));
  if (F && D) {
    const sy = K.syncOffset(F, D);
    S.offsetAuto = sy.offset; S.syncMethod = sy.method;
    if (resetPhases) S.offset = sy.offset;
  } else if (resetPhases) { S.offset = 0; S.offsetAuto = 0; S.syncMethod = ''; }
  const M = masterTrack();
  if (!M) { S.ph = null; S.metrics = []; S.fz = null; renderAll(); return; }
  if (resetPhases || !S.ph) {
    if (M.phasesAuto) S.ph = clonePh(M.phasesAuto);
    else if (F && D && D.phasesAuto) { const p = clonePh(D.phasesAuto); const o = S.offset; p.bounds = p.bounds.map(b => b + o); p.tTop += o; p.tHanare += o; p.tKai += o; S.ph = p; }
    else { S.ph = K.evenPhases(M.grid.gt[0], M.grid.gt[M.grid.G - 1]); S.ph.fallback = true; }
  }
  if (SH.shot && SH.shotId) {
    const sb = SH.shot.bounds;
    if (Array.isArray(sb) && sb.length === 9 && SH.shot.boundsMaster === S.master) { S.ph.bounds = sb.slice(); S.ph.tHanare = sb[6]; S.ph.tKai = sb[5]; S.ph.tTop = clamp(S.ph.tTop, sb[3], sb[5]); S.ph.fallback = false; S.ph.auto = false; }
    if (F && D && Number.isFinite(SH.shot.offset)) S.offset = SH.shot.offset;
  }
  S.fz = F && D && S.ph ? K.fuseSetup(F, D, S.ph, S.offset, S.heightCm) : null;
  try {
    S.metrics = K.computeMetrics({ front: F, side: D, ph: S.ph, offset: S.offset, heightCm: S.heightCm, master: S.master });
  } catch (e) { console.error(e); S.metrics = []; }
  renderAll();
}
const clonePh = (p) => ({ ...p, bounds: p.bounds.slice() });

// ---------- 描画: 動画の上 ----------
let dpr = Math.min(2, window.devicePixelRatio || 1);
function isWide3d() { return S.layout === '3d' && ($('#stage').clientWidth || 0) >= 860; }
function visibleKeys() {
  if (S.layout === 'both') return ['front', 'side'];
  if (S.layout === '3d') return isWide3d() ? ['top'].concat(['front', 'side'].filter(k => V[k].track || V[k].url)) : ['top'];
  return [S.layout];
}
function setLayout(l) {
  S.layout = l;
  $$('.viewbar .seg button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.layout === l)));
  layoutFrames(); drawAll();
}
function layoutFrames() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const keys = visibleKeys();
  const st = $('#stage');
  const W = st.clientWidth || 320;
  const wide = isWide3d();
  st.classList.toggle('wide3d', wide);
  if (wide) {
    const gap = 8, colS = Math.floor((W - gap) * 0.36), colM = W - gap - colS;
    const side = Math.floor(Math.min(colM, Math.max(360, window.innerHeight * 0.78), 780));
    TOP.pane.hidden = false;
    TOP.frame.style.width = side + 'px'; TOP.frame.style.height = side + 'px';
    TOP.canvas.width = Math.round(side * dpr); TOP.canvas.height = Math.round(side * dpr);
    const vids = keys.filter(k => k !== 'top');
    const each = vids.length ? (side + 40 - (vids.length - 1) * gap) / vids.length - 30 : 0;
    for (const key of ['front', 'side']) {
      const v = V[key]; v.pane.hidden = !vids.includes(key);
      if (v.pane.hidden) continue;
      const ar = v.w && v.h ? v.w / v.h : 9 / 16;
      let w = colS, h = w / ar; if (h > each) { h = each; w = h * ar; }
      v.frame.style.width = Math.floor(w) + 'px'; v.frame.style.height = Math.floor(h) + 'px';
      v.canvas.width = Math.round(Math.floor(w) * dpr); v.canvas.height = Math.round(Math.floor(h) * dpr);
    }
    return;
  }
  const ars = keys.map(k => (k === 'top' ? 1 : V[k].w && V[k].h ? V[k].w / V[k].h : 9 / 16));
  const stack = keys.length === 2 && Math.min(...ars) > 1 && W < 760;
  const n = stack ? 1 : keys.length;
  st.style.setProperty('--n', n);
  const gap = 8;
  const colW = (W - gap * (n - 1)) / n;
  const maxH = Math.max(200, Math.min(window.innerHeight * (stack ? 0.42 : n === 2 ? 0.62 : 0.72), 760));
  for (const key of ['front', 'side']) {
    const v = V[key];
    v.pane.hidden = !keys.includes(key);
    if (v.pane.hidden) continue;
    const ar = v.w && v.h ? v.w / v.h : (9 / 16);
    let w = colW, h = w / ar;
    if (h > maxH) { h = maxH; w = h * ar; }
    v.frame.style.width = Math.floor(w) + 'px'; v.frame.style.height = Math.floor(h) + 'px';
    v.canvas.width = Math.round(Math.floor(w) * dpr); v.canvas.height = Math.round(Math.floor(h) * dpr);
  }
  TOP.pane.hidden = !keys.includes('top');
  if (!TOP.pane.hidden) {
    const side = Math.floor(Math.min(colW, Math.max(280, Math.min(window.innerHeight * 0.66, 720))));
    TOP.frame.style.width = side + 'px'; TOP.frame.style.height = side + 'px';
    TOP.canvas.width = Math.round(side * dpr); TOP.canvas.height = Math.round(side * dpr);
  }
}

function drawStageBg(ctx, W, H, sc) {
  const floorY = 1112 * sc;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c2026'); g.addColorStop(floorY / H, '#14171b'); g.addColorStop(Math.min(1, floorY / H + 0.001), '#4a3d2c'); g.addColorStop(1, '#2d251b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,230,190,.08)'; ctx.lineWidth = 1;
  for (let y = floorY + 14 * sc; y < H; y += 26 * sc) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.38)'; ctx.font = `${Math.round(11 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textAlign = 'right'; ctx.fillText('合成サンプル', W - 8 * dpr, H - 8 * dpr); ctx.textAlign = 'left';
}

function drawView(v) {
  const c = v.canvas; const ctx = c.getContext('2d'); const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!v.w || v.pane.hidden) { v.hudPhase.textContent = ''; v.hudVal.textContent = ''; return; }
  const sc = W / v.w;
  if (v.sampleBg) drawStageBg(ctx, W, H, sc);
  else if (v.flip && !v.url) drawFlip(ctx, v, viewTime(v.key, S.t), W, H);
  else if (!v.url && v.track) { ctx.fillStyle = '#0e1013'; ctx.fillRect(0, 0, W, H); }
  const lw = Math.max(2, W / 170);
  const P = (p) => [p.x * sc, p.y * sc];
  if (v.status === 'analyzing') {
    if (v.liveK) drawSkeleton(ctx, v.liveK, P, lw, null);
    v.hudPhase.textContent = '解析中'; v.hudVal.textContent = '';
    return;
  }
  if (v.status === 'ready') {
    if (v.pick) {
      const [x, y] = [v.pick.x * sc, v.pick.y * sc];
      ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(x, y, 18 * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 26 * dpr, y); ctx.lineTo(x + 26 * dpr, y); ctx.moveTo(x, y - 26 * dpr); ctx.lineTo(x, y + 26 * dpr); ctx.stroke();
    }
    v.hudPhase.textContent = ''; v.hudVal.textContent = '';
    return;
  }
  if (!v.track) { v.hudPhase.textContent = ''; v.hudVal.textContent = ''; return; }
  const tv = viewTime(v.key, S.t);
  const k = K.kpAt(v.track, tv);
  const pi = S.ph ? K.phaseAt(S.ph.bounds, S.t) : -1;
  v.hudPhase.textContent = pi >= 0 ? PH[pi].name : '';
  if (!k) { v.hudVal.textContent = '範囲外'; return; }
  const T = v.track.T * sc;
  if (S.layers.trail && S.ph) drawTrail(ctx, v, P, lw);
  if (S.layers.cross) drawCross(ctx, v, k, P, lw, T);
  if (S.layers.skel) drawSkeleton(ctx, k, P, lw, T);
  let hud = '';
  if (S.layers.arrow && S.ph && pi >= 2 && S.t < S.ph.tHanare) hud = drawArrow(ctx, v, k, P, lw, pi);
  if (!hud && v.key === 'side' && pi === 3) hud = drawUchiAngle(ctx, v, k, P, lw);
  if (!hud && (pi === 1 || pi === 7)) hud = leanText(v, k);
  v.hudVal.textContent = hud;
}

function drawSkeleton(ctx, k, P, lw, T) {
  const col = { y: C['ov-yunde'], m: C['ov-mete'], c: C['ov-trunk'] };
  ctx.lineCap = 'round';
  for (const [a, b, s] of K.EDGES) {
    if (a <= 4 && b <= 4) continue;
    const pa = k[a], pb = k[b];
    const low = Math.min(pa.s, pb.s) < 0.3;
    ctx.globalAlpha = low ? 0.35 : 0.95;
    ctx.setLineDash(low ? [lw * 1.5, lw * 1.5] : []);
    ctx.strokeStyle = col[s]; ctx.lineWidth = lw * (s === 'c' ? 0.8 : 1);
    ctx.beginPath(); ctx.moveTo(...P(pa)); ctx.lineTo(...P(pb)); ctx.stroke();
  }
  ctx.setLineDash([]);
  // 頭
  const hs = [0, 1, 2, 3, 4].map(j => k[j]).filter(p => p.s > 0.25);
  if (hs.length) {
    const hx = hs.reduce((a, p) => a + p.x, 0) / hs.length, hy = hs.reduce((a, p) => a + p.y, 0) / hs.length;
    const sh = { x: (k[5].x + k[6].x) / 2, y: (k[5].y + k[6].y) / 2 };
    const [cx, cy] = P({ x: hx, y: hy });
    const r = T ? T * 0.2 : Math.hypot(...P({ x: hx - sh.x, y: hy - sh.y })) * 0.5;
    ctx.globalAlpha = 0.9; ctx.strokeStyle = C['ov-trunk']; ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(r, lw * 3), 0, Math.PI * 2); ctx.stroke();
    // 首
    ctx.beginPath(); ctx.moveTo(...P(sh)); ctx.lineTo(cx + (P(sh)[0] - cx) * 0.0, cy + Math.max(r, lw * 3)); ctx.stroke();
    // 鼻（顔の向き）
    if (k[0].s > 0.3) { ctx.fillStyle = C['ov-trunk']; ctx.beginPath(); ctx.arc(...P(k[0]), lw * 0.9, 0, Math.PI * 2); ctx.fill(); }
  }
  for (let j = 5; j < 17; j++) {
    const p = k[j]; ctx.globalAlpha = p.s < 0.3 ? 0.35 : 1;
    ctx.fillStyle = j % 2 ? C['ov-yunde'] : C['ov-mete'];
    ctx.beginPath(); ctx.arc(...P(p), lw * 1.15, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCross(ctx, v, k, P, lw, T) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  ctx.strokeStyle = C['ov-guide']; ctx.lineWidth = Math.max(1, lw * 0.55); ctx.globalAlpha = 0.85;
  const ext = (a, b, f) => { const dx = b.x - a.x, dy = b.y - a.y; return [{ x: a.x - dx * f, y: a.y - dy * f }, { x: b.x + dx * f, y: b.y + dy * f }]; };
  if (v.key === 'front') {
    ctx.setLineDash([lw * 2.2, lw * 1.6]);
    for (const [a, b] of [[6, 5], [12, 11], [16, 15]]) {
      if (Math.min(k[a].s, k[b].s) < 0.2) continue;
      const [p, q] = ext(k[a], k[b], 0.45);
      ctx.beginPath(); ctx.moveTo(...P(p)); ctx.lineTo(...P(q)); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  // 縦線: 足首の中点からの鉛直と、腰→肩の線
  const an = mid(k[15], k[16]), hp = mid(k[11], k[12]), sh = mid(k[5], k[6]);
  const [ax, ay] = P(an); const [, sy] = P(sh);
  ctx.globalAlpha = 0.5; ctx.setLineDash([lw, lw * 1.4]);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, sy - (T || 0) * 0.6); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 0.95;
  const dx = sh.x - hp.x, dy = sh.y - hp.y;
  ctx.beginPath(); ctx.moveTo(...P(hp)); ctx.lineTo(...P({ x: sh.x + dx * 0.55, y: sh.y + dy * 0.55 })); ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawTrail(ctx, v, P, lw) {
  const t0 = S.ph.bounds[3], t1 = Math.min(S.t, S.ph.bounds[8]);
  if (t1 <= t0) return;
  for (const [j, col] of [[9, C['ov-yunde']], [10, C['ov-mete']]]) {
    ctx.strokeStyle = col; ctx.lineWidth = lw * 0.7; ctx.globalAlpha = 0.7; ctx.beginPath();
    let first = true;
    for (let t = t0; t <= t1; t += 1 / 20) {
      const k = K.kpAt(v.track, viewTime(v.key, t)); if (!k) continue;
      const [x, y] = P(k[j]);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function cmPerPx(track) { return track && track.noseAnkle > 10 ? S.heightCm * 0.88 / track.noseAnkle : NaN; }

function drawArrow(ctx, v, k, P, lw, pi) {
  const r = k[10], l = k[9];
  if (Math.min(r.s, l.s) < 0.2) return '';
  const dx = l.x - r.x, dy = l.y - r.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  ctx.lineCap = 'round';
  if (v.key === 'front') {
    const cpp = cmPerPx(v.track);
    const L = Number.isFinite(cpp) ? (S.heightCm / 2 + 12) / cpp : d * 1.12;
    const nock = { x: r.x - ux * L * 0.03, y: r.y - uy * L * 0.03 };
    const tip = { x: r.x + ux * L, y: r.y + uy * L };
    const [nx, ny] = P(nock), [tx, ty] = P(tip);
    const Lp = Math.hypot(tx - nx, ty - ny);
    const px = -uy, py = ux;
    // 羽
    ctx.fillStyle = 'rgba(245,240,226,.85)';
    for (const sgn of [1, -1]) {
      const a0 = 0.04 * Lp, a1 = 0.2 * Lp, w = Math.max(3, Lp * 0.022) * sgn;
      ctx.beginPath(); ctx.moveTo(nx + ux * a0, ny + uy * a0); ctx.lineTo(nx + ux * a1, ny + uy * a1);
      ctx.lineTo(nx + ux * (a1 - 0.03 * Lp) + px * w, ny + uy * (a1 - 0.03 * Lp) + py * w); ctx.lineTo(nx + ux * (a0 + 0.02 * Lp) + px * w, ny + uy * (a0 + 0.02 * Lp) + py * w); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = Math.max(2, lw * 0.75);
    ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(tx, ty); ctx.stroke();
    const hl = Math.max(6, lw * 3);
    ctx.fillStyle = '#d9dde3';
    ctx.beginPath(); ctx.moveTo(tx + ux * hl, ty + uy * hl); ctx.lineTo(tx - px * hl * 0.45, ty - py * hl * 0.45); ctx.lineTo(tx + px * hl * 0.45, ty + py * hl * 0.45); ctx.closePath(); ctx.fill();
    if (pi === 5) {
      const ang = Math.atan2(-(dy), Math.abs(dx)) * 180 / Math.PI;
      return `矢先 ${ang >= 0 ? '上' : '下'} ${Math.abs(ang).toFixed(1)}°`;
    }
    return '';
  }
  // 馬手側: 矢は奥へ向かうので、両拳を結ぶ線を矢筋として描く
  const [rx, ry] = P(r), [lx, ly] = P(l);
  ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = Math.max(2, lw * 0.75); ctx.setLineDash([lw * 1.6, lw * 1.2]);
  ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(lx, ly); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C['ov-ya']; ctx.beginPath(); ctx.arc(lx, ly, lw * 1.6, 0, Math.PI * 2); ctx.fill();
  if (pi === 5) {
    const cpp = cmPerPx(v.track);
    const sF = S.sideFacing || 1;
    const off = (l.x - r.x) * sF * cpp;
    if (Number.isFinite(off)) return `矢筋 弓手が${off >= 0 ? '前' : '後ろ'} ${Math.abs(off).toFixed(0)}cm`;
  }
  return '';
}

function drawUchiAngle(ctx, v, k, P, lw) {
  const sh = { x: (k[5].x + k[6].x) / 2, y: (k[5].y + k[6].y) / 2 }, w = { x: (k[9].x + k[10].x) / 2, y: (k[9].y + k[10].y) / 2 };
  const sF = S.sideFacing || 1;
  const ang = Math.atan2(-(w.y - sh.y), (w.x - sh.x) * sF) * 180 / Math.PI;
  if (!Number.isFinite(ang) || ang < 5) return '';
  const [sx, sy] = P(sh), [wx, wy] = P(w);
  const R = Math.hypot(wx - sx, wy - sy) * 0.42;
  ctx.strokeStyle = C['ov-guide']; ctx.lineWidth = Math.max(1, lw * 0.6);
  ctx.setLineDash([lw * 1.4, lw]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + sF * R * 1.6, sy); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(wx, wy); ctx.stroke();
  const ar = ang * Math.PI / 180;
  ctx.beginPath();
  if (sF > 0) ctx.arc(sx, sy, R, -ar, 0, false); else ctx.arc(sx, sy, R, Math.PI, Math.PI + ar, false);
  ctx.stroke();
  return `打起し ${Math.round(ang)}°`;
}

function leanText(v, k) {
  const sh = { x: (k[5].x + k[6].x) / 2, y: (k[5].y + k[6].y) / 2 }, hp = { x: (k[11].x + k[12].x) / 2, y: (k[11].y + k[12].y) / 2 };
  const sgn = v.key === 'front' ? ((k[9].x - k[10].x) >= 0 ? 1 : -1) : (S.sideFacing || 1);
  const a = Math.atan2((sh.x - hp.x) * sgn, -(sh.y - hp.y)) * 180 / Math.PI;
  if (!Number.isFinite(a)) return '';
  if (v.key === 'front') return `胴 ${a >= 0 ? '的側' : '反対側'}へ ${Math.abs(a).toFixed(1)}°`;
  return `胴 ${a >= 0 ? '前' : '後ろ'}へ ${Math.abs(a).toFixed(1)}°`;
}
function label(ctx, s, x, y, col) {
  ctx.font = `700 ${Math.round(12.5 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
  const w = ctx.measureText(s).width + 10 * dpr, h = 20 * dpr;
  const W = ctx.canvas.width;
  x = clamp(x - w / 2, 4 * dpr, W - w - 4 * dpr);
  y = Math.max(4 * dpr, y - h / 2);
  ctx.fillStyle = 'rgba(10,12,15,.78)';
  roundRect(ctx, x, y, w, h, 5 * dpr); ctx.fill();
  ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.fillText(s, x + 5 * dpr, y + h / 2 + 0.5); ctx.textBaseline = 'alphabetic';
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }


// ---------- 立体表示（正面と馬手側の合成） ----------
const TOP = { pane: $('#pane-top'), frame: $('#pane-top .frame'), canvas: $('#topCanvas'), hudPhase: $('#pane-top .hud-phase'), hudVal: $('#pane-top .hud-val'), msg: $('#pane-top .pane-msg') };
const CAM = { yaw: 0, pitch: 90, zoom: 1 };
const CAM_PRESETS = { top: [0, 90], oblique: [-35, 28], front: [0, 0], side: [-90, 0], target: [90, 0] };
const CENTER = { x: 12, y: 85, z: 0 };
// 視点: yaw は鉛直軸まわり、pitch は 90 で真上、0 で水平、負で下から。ゆるい遠近をつける
function makeCam(W, H) {
  const yw = CAM.yaw * Math.PI / 180, pt = CAM.pitch * Math.PI / 180;
  const cy = Math.cos(yw), sy = Math.sin(yw), cp = Math.cos(pt), sp = Math.sin(pt);
  const base = Math.min(W, H) / (205 + 30 * Math.abs(cp)) * CAM.zoom;
  const F = 520;
  const pr = (q) => {
    const X = q.x - CENTER.x, Y = q.y - CENTER.y, Z = q.z - CENTER.z;
    const x1 = X * cy - Z * sy, z1 = X * sy + Z * cy;
    const sx = x1, syU = Y * cp - z1 * sp, d = Y * sp + z1 * cp;
    const k = F / Math.max(120, F - d);
    return { x: W / 2 + sx * base * k, y: H / 2 - syU * base * k, d, k };
  };
  // 回転だけの向き（目印用）
  const dir = (v) => { const x1 = v.x * cy - v.z * sy, z1 = v.x * sy + v.z * cy; return { x: x1, y: v.y * cp - z1 * sp, d: v.y * sp + z1 * cp }; };
  return { pr, dir, base };
}
function setCamPressed(key) { $$('#pane-top .cam button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.cam === key))); }

function drawTop() {
  if (TOP.pane.hidden) return;
  const c = TOP.canvas, ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, W * 0.08, W / 2, H / 2, W * 0.78);
  bg.addColorStop(0, '#1e232a'); bg.addColorStop(1, '#0c0e11');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const { pr, dir, base } = makeCam(W, H);
  const lw = Math.max(2, W / 170);
  const font = getComputedStyle(document.body).fontFamily;
  const below = CAM.pitch < 0;
  // 床（射場の板）と 20cm の目盛り
  const fq = [[-110, -90], [130, -90], [130, 90], [-110, 90]].map(([x, z]) => pr({ x, y: 0, z }));
  ctx.fillStyle = below ? 'rgba(255,255,255,.02)' : 'rgba(255,236,205,.045)';
  ctx.beginPath(); fq.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  const gl = (a, b) => { const A = pr(a), B = pr(b); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); };
  for (let x = -110; x <= 130; x += 20) gl({ x, y: 0, z: -90 }, { x, y: 0, z: 90 });
  for (let z = -90; z <= 90; z += 20) gl({ x: -110, y: 0, z }, { x: 130, y: 0, z });
  drawGizmo(ctx, dir, W, H, font);
  if (!S.fz) {
    TOP.msg.hidden = false;
    TOP.msg.textContent = V.front.track && V.side.track ? '2本の動画を立体に組み立てられませんでした。「区切りと時刻合わせを直す」で時刻のずれを合わせてください。' : (V.front.track || V.side.track ? '立体の図は、正面と馬手側の両方を解析すると表示されます。' : '正面と馬手側の動画を解析すると、2方向を合成して立体で見られます。');
    TOP.hudPhase.textContent = ''; TOP.hudVal.textContent = '';
    return;
  }
  TOP.msg.hidden = true;
  const p3 = K.pose3dAt(S.fz, S.t);
  const pi = S.ph ? K.phaseAt(S.ph.bounds, S.t) : -1;
  TOP.hudPhase.textContent = pi >= 0 ? PH[pi].name : '';
  // 床の上の方角
  ctx.font = `700 ${Math.round(12 * dpr)}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255,255,255,.55)';
  if (Math.abs(CAM.pitch) > 6) { const a = pr({ x: 124, y: 0, z: 0 }), b = pr({ x: 0, y: 0, z: 80 }); ctx.fillText('的 ▶', a.x, a.y); ctx.fillText('前', b.x, b.y); }
  if (!p3) { TOP.hudVal.textContent = '範囲外'; return; }
  const add3 = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  const ext = (a, b, f) => [add3(a, b, -f), add3(a, b, 1 + f)];
  const floorLine = (a, b, col, w, alpha, dash) => {
    const A = pr(a), B = pr(b);
    ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  };
  const la = p3[15], ra = p3[16];
  // 足踏みの線（的への線）
  { const [a, b] = ext({ ...ra, y: 0 }, { ...la, y: 0 }, 0.9); floorLine(a, b, C['ov-guide'], Math.max(1, lw * 0.6), 0.75, [lw * 2, lw * 1.4]); }
  // 床に落ちる影
  if (!below) {
    ctx.lineCap = 'round';
    for (const [a, b] of K.EDGES) { if (a <= 4 && b <= 4) continue; floorLine({ ...p3[a], y: 0 }, { ...p3[b], y: 0 }, '#000', lw * 1.6, 0.32); }
  }
  // 軌跡
  if (S.layers.trail && S.ph) {
    for (const [j, col] of [[9, C['ov-yunde']], [10, C['ov-mete']]]) {
      ctx.strokeStyle = col; ctx.lineWidth = lw * 0.7; ctx.globalAlpha = 0.7; ctx.beginPath(); let first = true;
      for (let t = S.ph.bounds[3]; t <= Math.min(S.t, S.ph.bounds[8]); t += 1 / 20) {
        const q = K.pose3dAt(S.fz, t); if (!q) continue;
        const P = pr(q[j]); if (first) { ctx.moveTo(P.x, P.y); first = false; } else ctx.lineTo(P.x, P.y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // ここから奥から手前の順に描く
  const prims = [];
  const seg = (a, b, col, w, alpha = 1, dash) => {
    const A = pr(a), B = pr(b);
    prims.push({ d: (A.d + B.d) / 2, f() { ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = w * (A.k + B.k) / 2; ctx.setLineDash(dash || []); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); } });
  };
  const col = { y: C['ov-yunde'], m: C['ov-mete'], c: C['ov-trunk'] };
  for (const [a, b, s] of K.EDGES) {
    if (a <= 4 && b <= 4) continue;
    const low = Math.min(p3[a].s, p3[b].s) < 0.3;
    seg(p3[a], p3[b], col[s], lw * (s === 'c' ? 0.8 : 1.05), low ? 0.4 : 0.95, low ? [lw * 1.5, lw * 1.5] : null);
  }
  // 体幹の面（ねじれが見やすいように薄く塗る）
  {
    const qs = [p3[5], p3[6], p3[12], p3[11]].map(pr);
    prims.push({ d: qs.reduce((a, q) => a + q.d, 0) / 4 - 0.5, f() { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(233,237,242,.11)'; ctx.beginPath(); qs.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.fill(); } });
  }
  for (let j = 5; j < 17; j++) {
    const P = pr(p3[j]), alpha = p3[j].s < 0.3 ? 0.4 : 1, fill = j % 2 ? C['ov-yunde'] : C['ov-mete'];
    prims.push({ d: P.d + 0.1, f() { ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(P.x, P.y, lw * 1.2 * P.k, 0, Math.PI * 2); ctx.fill(); } });
  }
  if (S.layers.cross) {
    for (const [a, b] of [[12, 11], [6, 5]]) { const [p, q] = ext(p3[a], p3[b], 0.6); seg(p, q, C['ov-guide'], Math.max(1, lw * 0.55), 0.85, [lw * 2.2, lw * 1.6]); }
  }
  // 頭（球）と顔の向き
  const mid3 = (a, b) => add3(a, b, 0.5);
  const ears = [p3[3], p3[4]].filter(q => q.s > 0.2);
  const hc = ears.length === 2 ? mid3(ears[0], ears[1]) : mid3(p3[1], p3[2]);
  seg(mid3(p3[5], p3[6]), hc, C['ov-trunk'], lw * 0.8, 0.9);
  {
    const Hc = pr(hc), r = 10 * base * Hc.k;
    prims.push({ d: Hc.d, f() { ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.fillStyle = 'rgba(14,16,19,.88)'; ctx.strokeStyle = C['ov-trunk']; ctx.lineWidth = lw * 0.8; ctx.beginPath(); ctx.arc(Hc.x, Hc.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); } });
    if (p3[0].s > 0.2) {
      const d = { x: p3[0].x - hc.x, z: p3[0].z - hc.z }, n = Math.hypot(d.x, d.z) || 1;
      seg(hc, { x: hc.x + d.x / n * 17, y: hc.y, z: hc.z + d.z / n * 17 }, C['ov-trunk'], lw * 0.9, 0.95);
      const N = pr({ x: hc.x + d.x / n * 17, y: hc.y, z: hc.z + d.z / n * 17 });
      prims[prims.length - 1].d = Math.max(prims[prims.length - 1].d, Hc.d + 0.2, N.d);
    }
  }
  // 矢
  let hud = '';
  if (S.layers.arrow && S.ph && pi >= 2 && S.t < S.ph.tHanare) {
    const rw = p3[10], lwr = p3[9];
    const d = { x: lwr.x - rw.x, y: lwr.y - rw.y, z: lwr.z - rw.z }, n = Math.hypot(d.x, d.y, d.z) || 1;
    const u = { x: d.x / n, y: d.y / n, z: d.z / n }, L = S.heightCm / 2 + 12;
    const nock = { x: rw.x - u.x * 3, y: rw.y - u.y * 3, z: rw.z - u.z * 3 }, tip = { x: rw.x + u.x * L, y: rw.y + u.y * L, z: rw.z + u.z * L };
    const A = pr(nock), B = pr(tip), Bb = pr({ x: tip.x - u.x * 6, y: tip.y - u.y * 6, z: tip.z - u.z * 6 });
    prims.push({ d: (A.d + B.d) / 2 + 0.3, f() {
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = Math.max(2, lw * 0.85) * (A.k + B.k) / 2;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      const vx = B.x - Bb.x, vy = B.y - Bb.y, vn = Math.hypot(vx, vy) || 1, hl = Math.max(6, lw * 3);
      ctx.fillStyle = '#d9dde3'; ctx.beginPath();
      ctx.moveTo(B.x + vx / vn * hl, B.y + vy / vn * hl); ctx.lineTo(B.x - vy / vn * hl * 0.45, B.y + vx / vn * hl * 0.45); ctx.lineTo(B.x + vy / vn * hl * 0.45, B.y - vx / vn * hl * 0.45); ctx.closePath(); ctx.fill();
    } });
    if (pi === 5) {
      const ref = Math.atan2(la.z - ra.z, la.x - ra.x), a = (Math.atan2(d.z, d.x) - ref) * 180 / Math.PI;
      hud = `矢先 ${a >= 0 ? '前' : '後ろ'}へ ${Math.abs(a).toFixed(1)}°`;
    }
  }
  ctx.lineCap = 'round';
  prims.sort((a, b) => a.d - b.d).forEach(p => p.f());
  ctx.globalAlpha = 1; ctx.setLineDash([]);
  if (!hud && pi >= 1) {
    const ref = Math.atan2(la.z - ra.z, la.x - ra.x), a = (Math.atan2(p3[5].z - p3[6].z, p3[5].x - p3[6].x) - ref) * 180 / Math.PI;
    if (Number.isFinite(a)) hud = `肩 ${a >= 0 ? '弓手側' : '馬手側'}が前へ ${Math.abs(a).toFixed(1)}°`;
  }
  TOP.hudVal.textContent = hud;
}
// 左下の向きの目印（的・上・前）
function drawGizmo(ctx, dir, W, H, font) {
  const o = { x: 34 * dpr, y: H - 34 * dpr }, L = 20 * dpr;
  const axes = [[{ x: 1, y: 0, z: 0 }, '的', C['ov-ya']], [{ x: 0, y: 1, z: 0 }, '上', C['ov-trunk']], [{ x: 0, y: 0, z: 1 }, '前', C['ov-guide']]]
    .map(([v, n, c]) => ({ v: dir(v), n, c })).sort((a, b) => a.v.d - b.v.d);
  ctx.font = `700 ${Math.round(10.5 * dpr)}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineCap = 'round';
  for (const a of axes) {
    const ex = o.x + a.v.x * L, ey = o.y - a.v.y * L;
    ctx.globalAlpha = a.v.d < -0.2 ? 0.45 : 1; ctx.strokeStyle = a.c; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = a.c; ctx.fillText(a.n, o.x + a.v.x * (L + 9 * dpr), o.y - a.v.y * (L + 9 * dpr));
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
$$('#pane-top .cam button').forEach(b => b.addEventListener('click', () => {
  [CAM.yaw, CAM.pitch] = CAM_PRESETS[b.dataset.cam]; CAM.zoom = 1;
  setCamPressed(b.dataset.cam); drawTop();
}));
$$('#pane-top .zoom button').forEach(b => b.addEventListener('click', () => {
  CAM.zoom = clamp(CAM.zoom * Number(b.dataset.zoom), 0.6, 3.5); drawTop();
}));
{
  // 1本指（マウス）で回転、2本指で拡大縮小、ダブルタップで頭上に戻す
  const ptrs = new Map(); let pinch = null, lastTap = 0;
  const cv = TOP.canvas;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  cv.addEventListener('pointerdown', (e) => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); cv.setPointerCapture(e.pointerId);
    if (ptrs.size === 2) pinch = { d: dist(), zoom: CAM.zoom };
    if (ptrs.size === 1) {
      const now = performance.now();
      if (now - lastTap < 300) { [CAM.yaw, CAM.pitch] = CAM_PRESETS.top; CAM.zoom = 1; setCamPressed('top'); drawTop(); }
      lastTap = now;
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId); if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1) {
      CAM.yaw = ((CAM.yaw - (cur.x - prev.x) * 0.5 + 540) % 360) - 180;
      CAM.pitch = clamp(CAM.pitch + (cur.y - prev.y) * 0.5, -90, 90);
    } else if (ptrs.size === 2 && pinch) {
      CAM.zoom = clamp(pinch.zoom * dist() / pinch.d, 0.6, 3.5);
    }
    setCamPressed(''); drawTop();
  });
  const end = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // トラックパッドのピンチだけ拾い、普通のスクロールは邪魔しない
    e.preventDefault(); CAM.zoom = clamp(CAM.zoom * Math.exp(-e.deltaY * 0.01), 0.6, 3.5); drawTop();
  }, { passive: false });
}
function drawAll() { for (const v of Object.values(V)) drawView(v); drawTop(); updateTransport(); }

// ---------- 枠ごとの案内 ----------
function renderPaneMsgs() {
  for (const v of Object.values(V)) {
    const m = v.msg;
    v.prog.hidden = v.status !== 'analyzing';
    if (v.status === 'empty' && !v.track) {
      m.hidden = false; m.className = 'pane-msg center';
      m.innerHTML = `<span>${v.label}の動画はまだありません</span><label class="btn small file-btn">動画を選ぶ<input type="file" accept="video/*" aria-label="${v.label}の動画を選ぶ"></label>`;
      $('input', m).addEventListener('change', (e) => onVideoFile(v.key, e.target.files[0]));
    } else if (v.status === 'loading') {
      m.hidden = false; m.className = 'pane-msg center'; m.textContent = '読み込み中…';
    } else if (v.status === 'ready') {
      m.hidden = false; m.className = 'pane-msg';
      const both = ['front', 'side'].filter(k => V[k].status === 'ready').length === 2;
      m.innerHTML = `<span>射手が複数写っている時は、解析の前に射手をタップしてください。${v.pick ? '（指定済み）' : ''}</span><button type="button" class="btn small">${both ? '2本とも解析する' : '解析する'}</button>`;
      $('button', m).addEventListener('click', () => startAnalysis(both ? ['front', 'side'] : [v.key]));
    } else if (v.status === 'error') {
      m.hidden = false; m.className = 'pane-msg center';
      m.innerHTML = `<span>${v.error || '解析できませんでした'}</span><label class="btn small file-btn">別の動画を選ぶ<input type="file" accept="video/*"></label>`;
      $('input', m).addEventListener('change', (e) => onVideoFile(v.key, e.target.files[0]));
    } else {
      m.hidden = true;
    }
    v.cap.textContent = v.status === 'done' && v.key === 'side' && V.front.track && v.track ? `時刻のずれ ${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)} 秒` : '';
  }
}
function renderSlots() {
  const set = (slot, st, cls, file) => { const c = $('[data-st]', slot); c.textContent = st; c.className = 'chip ' + (cls || ''); if (file != null) $('[data-file]', slot).textContent = file; };
  for (const v of Object.values(V)) {
    const name = v.file ? v.file.name : null;
    if (S.sample) set(v.slot, 'サンプル', 'info', null);
    else if (v.status === 'empty') set(v.slot, '未選択', '', v.key === 'front' ? '射手の体の正面から' : '射手の右側から');
    else if (v.status === 'loading') set(v.slot, '読み込み中', 'busy', name);
    else if (v.status === 'ready') set(v.slot, '解析待ち', 'warn', name);
    else if (v.status === 'analyzing') set(v.slot, `解析中 ${Math.round(v.progress * 100)}%`, 'busy', name);
    else if (v.status === 'done') set(v.slot, '解析済み', 'ok', v.partShot && v.partShot === SH.shotId ? whoText(v.by) : name);
    else if (v.status === 'error') set(v.slot, 'エラー', 'warn', name);
  }
  const ps = $('#slot-photo');
  if (S.sample) set(ps, 'サンプル', 'info', null);
  else if (!S.target.src && !S.target.partAt) set(ps, '未選択', '', '射手側から的を撮影');
  else set(ps, S.target.marks.length ? `${S.target.marks.length} 本` : '印付け待ち', S.target.marks.length ? 'ok' : 'warn', S.target.partAt && SH.shotId ? whoText(S.target.by) : (S.target.name || ''));
  if (SH.shotId) refreshNames();
}

// ---------- 再生 ----------
let rafId = 0, lastNow = 0;
function videoActive(v) { return !S.sample && v.url && (v.status === 'done' || v.status === 'ready'); }
function setTime(t, fromScrub) {
  const dur = masterDuration();
  S.t = clamp(t, 0, dur || 0);
  for (const v of Object.values(V)) {
    if (!videoActive(v)) continue;
    const vt = viewTime(v.key, S.t);
    if (vt >= 0 && vt <= v.duration) { try { v.video.currentTime = vt; } catch (e) { /* 読み込み中 */ } }
  }
  drawAll(); drawTimeline(); drawChart(); updatePhaseRow();
  void fromScrub;
}
function play() {
  if (!masterDuration()) return;
  if (S.t >= masterDuration() - 0.05) setTime(0);
  S.playing = true;
  for (const v of Object.values(V)) {
    if (!videoActive(v)) continue;
    v.video.playbackRate = S.rate;
    const vt = viewTime(v.key, S.t);
    if (vt >= 0 && vt < v.duration) { v.video.currentTime = vt; v.video.play().catch(() => {}); }
  }
  lastNow = performance.now();
  cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tick);
  updateTransport();
}
function pause() {
  S.playing = false;
  for (const v of Object.values(V)) if (videoActive(v)) v.video.pause();
  cancelAnimationFrame(rafId);
  updateTransport();
}
function tick(now) {
  if (!S.playing) return;
  const dur = masterDuration();
  const mv = V[S.master];
  if (videoActive(mv) && !mv.video.paused) S.t = mv.video.currentTime;
  else S.t += (now - lastNow) / 1000 * S.rate;
  lastNow = now;
  for (const v of Object.values(V)) {
    if (v === mv || !videoActive(v)) continue;
    const vt = viewTime(v.key, S.t);
    if (vt < 0 || vt > v.duration) { if (!v.video.paused) v.video.pause(); continue; }
    if (v.video.paused) { v.video.currentTime = vt; v.video.playbackRate = S.rate; v.video.play().catch(() => {}); }
    else if (Math.abs(v.video.currentTime - vt) > 0.12) v.video.currentTime = vt;
  }
  if (S.t >= dur) { S.t = dur; pause(); }
  drawAll(); drawTimeline(); drawChart(); updatePhaseRow();
  if (S.playing) rafId = requestAnimationFrame(tick);
}
function updateTransport() {
  $('#time').textContent = `${fmtT(S.t)} / ${fmtT(masterDuration())} 秒`;
  $('#playIcon').innerHTML = S.playing ? '<path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z"/>' : '<path d="M6 4v12l10-6z"/>';
  $('#play').setAttribute('aria-label', S.playing ? '一時停止' : '再生');
}
$('#play').addEventListener('click', () => (S.playing ? pause() : play()));
$('#stepBack').addEventListener('click', () => { pause(); setTime(S.t - 1 / 30); });
$('#stepFwd').addEventListener('click', () => { pause(); setTime(S.t + 1 / 30); });
$('#prevPhase').addEventListener('click', () => {
  if (!S.ph) return; pause();
  const b = S.ph.bounds; let i = K.phaseAt(b, S.t);
  if (S.t - b[Math.max(0, i)] < 0.3) i--;
  setTime(b[clamp(i, 0, 7)] + 0.01);
});
$('#nextPhase').addEventListener('click', () => {
  if (!S.ph) return; pause();
  const b = S.ph.bounds; const i = K.phaseAt(b, S.t);
  setTime(b[clamp(i + 1, 0, 8)] + (i + 1 >= 8 ? -0.01 : 0.01));
});
$$('.rate button').forEach(b => b.addEventListener('click', () => {
  S.rate = Number(b.dataset.rate);
  $$('.rate button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  for (const v of Object.values(V)) if (videoActive(v)) v.video.playbackRate = S.rate;
}));
$$('.viewbar .seg button').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));
$$('.tog').forEach(b => {
  b.setAttribute('aria-pressed', String(!!S.layers[b.dataset.layer]));
  b.addEventListener('click', () => { const k = b.dataset.layer; S.layers[k] = !S.layers[k]; b.setAttribute('aria-pressed', String(S.layers[k])); drawAll(); });
});
for (const v of Object.values(V)) {
  v.video.addEventListener('seeked', () => { if (!S.busy) drawView(v); });
  v.canvas.addEventListener('click', (e) => {
    if (v.status !== 'ready') return;
    const r = v.canvas.getBoundingClientRect();
    v.pick = { x: (e.clientX - r.left) / r.width * v.w, y: (e.clientY - r.top) / r.height * v.h };
    drawView(v); renderPaneMsgs();
  });
  $('.cancel', v.pane).addEventListener('click', () => { cancelFlag = true; });
}

// ---------- タイムライン ----------
const tl = $('#timeline');
function sizeCanvas(c, h) {
  const w = c.clientWidth || 300;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  return [c.width, c.height];
}
function drawTimeline() {
  const [W, H] = sizeCanvas(tl, 58);
  const ctx = tl.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const dur = masterDuration();
  ctx.fillStyle = C.sunk; roundRect(ctx, 0, 0, W, H, 8 * dpr); ctx.fill();
  if (!dur) return;
  const X = (t) => clamp(t / dur, 0, 1) * W;
  const bandY = 8 * dpr, bandH = H - 16 * dpr;
  if (S.ph) {
    const b = S.ph.bounds, cur = K.phaseAt(b, S.t);
    ctx.font = `800 ${Math.round(12.5 * dpr)}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) {
      const x0 = X(b[i]), x1 = X(b[i + 1]);
      if (x1 - x0 < 0.5) continue;
      ctx.fillStyle = i === cur ? C.main : (i % 2 ? C.surface : C.bg);
      ctx.fillRect(x0, bandY, x1 - x0, bandH);
      ctx.fillStyle = C.line; ctx.fillRect(x0, bandY, Math.max(1, dpr), bandH);
      const name = (x1 - x0) > 34 * dpr ? PH[i].name : ((x1 - x0) > 16 * dpr ? PH[i].short.slice(0, 1) : '');
      if (name) { ctx.fillStyle = i === cur ? C.surface : C.ink; ctx.fillText(name, (x0 + x1) / 2, bandY + bandH / 2 + 1); }
    }
    // 離れの印
    const xh = X(S.ph.tHanare);
    ctx.fillStyle = C.ya; ctx.beginPath(); ctx.moveTo(xh - 5 * dpr, 0); ctx.lineTo(xh + 5 * dpr, 0); ctx.lineTo(xh, 7 * dpr); ctx.closePath(); ctx.fill();
  }
  const xp = X(S.t);
  ctx.fillStyle = C.sub; ctx.fillRect(xp - dpr, 0, 2 * dpr, H);
  ctx.beginPath(); ctx.arc(xp, H - 4 * dpr, 4 * dpr, 0, Math.PI * 2); ctx.fill();
}
function scrubFrom(e, el) {
  const r = el.getBoundingClientRect();
  setTime(clamp((e.clientX - r.left) / r.width, 0, 1) * masterDuration(), true);
}
tl.addEventListener('pointerdown', (e) => { pause(); tl.setPointerCapture(e.pointerId); scrubFrom(e, tl); });
tl.addEventListener('pointermove', (e) => { if (tl.hasPointerCapture(e.pointerId)) scrubFrom(e, tl); });

function renderPhaseRow() {
  const row = $('#phaseRow');
  row.innerHTML = '';
  PH.forEach((p, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ph';
    const d = S.ph ? S.ph.bounds[i + 1] - S.ph.bounds[i] : NaN;
    b.innerHTML = `<b>${p.name}</b><span>${Number.isFinite(d) ? d.toFixed(1) + '秒' : '—'}</span>`;
    b.addEventListener('click', () => { if (!S.ph) return; pause(); setTime(S.ph.bounds[i] + 0.01); });
    row.appendChild(b);
  });
  updatePhaseRow();
}
function updatePhaseRow() {
  const cur = S.ph ? K.phaseAt(S.ph.bounds, S.t) : -1;
  $$('#phaseRow .ph').forEach((b, i) => b.setAttribute('aria-current', String(i === cur)));
}

// ---------- 区切りの調整 ----------
function renderAdjust() {
  const L = $('#adjList'); L.innerHTML = '';
  if (!S.ph) { L.innerHTML = '<p class="adj-note">解析が終わると調整できます。</p>'; return; }
  const names = PH.map(p => p.name + 'の始まり').slice(1).concat(['残心の終わり']);
  if (!S.ph.auto) {
    const r0 = document.createElement('div'); r0.className = 'adj-row';
    r0.innerHTML = '<span class="lbl">手で直した区切りがあります</span><span></span><span></span><span></span><button type="button">自動に戻す</button>';
    $('button', r0).addEventListener('click', () => { shareShot({ bounds: null }); if (SH.shot) SH.shot = { ...SH.shot, bounds: null }; recompute(true); setTime(S.t); });
    L.appendChild(r0);
  }
  names.forEach((nm, idx) => {
    const i = idx + 1;
    const row = document.createElement('div'); row.className = 'adj-row';
    row.innerHTML = `<span class="lbl">${nm}</span><span class="tv">${S.ph.bounds[i].toFixed(2)}秒</span><button type="button" data-d="-0.1" aria-label="${nm}を0.1秒前へ">−0.1</button><button type="button" data-d="0.1" aria-label="${nm}を0.1秒後へ">＋0.1</button><button type="button" data-here>ここ</button>`;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const nv = btn.hasAttribute('data-here') ? S.t : S.ph.bounds[i] + Number(btn.dataset.d);
      setBound(i, nv);
    });
    L.appendChild(row);
  });
  if (V.front.track && V.side.track) {
    const row = document.createElement('div'); row.className = 'adj-row';
    row.innerHTML = `<span class="lbl">馬手側の時刻のずれ <small style="color:var(--muted)">（自動: ${S.syncMethod}）</small></span><span class="tv">${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)}秒</span><button type="button" data-o="-0.033">−1コマ</button><button type="button" data-o="0.033">＋1コマ</button><button type="button" data-auto>自動</button>`;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const auto = btn.hasAttribute('data-auto');
      S.offset = auto ? S.offsetAuto : S.offset + Number(btn.dataset.o);
      shareShot({ offset: auto ? null : S.offset });
      if (SH.shot) SH.shot = { ...SH.shot, offset: auto ? null : S.offset };
      recompute(false); setTime(S.t);
    });
    L.appendChild(row);
  }
}
function setBound(i, nv) {
  const b = S.ph.bounds;
  b[i] = clamp(nv, b[i - 1], i < 8 ? b[i + 1] : masterDuration());
  if (i === 6) S.ph.tHanare = b[6];
  if (i === 5) S.ph.tKai = b[5];
  S.ph.tTop = clamp(S.ph.tTop, b[3], b[5]);
  S.ph.auto = false; S.ph.fallback = false;
  shareShot({ bounds: b.slice(), boundsMaster: S.master });
  if (SH.shot) { SH.shot = { ...SH.shot, bounds: b.slice(), boundsMaster: S.master }; }
  recompute(false);
  drawTimeline();
}

// ---------- 計測の表示 ----------
function renderMetrics() {
  const A = $('#metricsArea');
  if (!S.metrics.length) {
    A.innerHTML = `<p class="empty-note">${anyBusy() ? '解析が終わると、ここに八節ごとの計測が並びます。' : '動画を選んで解析すると、ここに八節ごとの計測が並びます。'}</p>`;
    return;
  }
  const kai = S.metrics.find(m => m.key === 'kaiLen');
  const warns = S.metrics.filter(m => m.status === 'warn');
  let html = S.ph && S.ph.fallback ? `<p class="empty-note" style="margin:0 0 12px">八節を自動で区切れなかったので、仮に等分しています。「区切りと時刻合わせを直す」で区切りを合わせると、計測も正しくなります。</p>` : '';
  html += `<div class="overview"><div class="ov-kai"><small>会の長さ</small><strong class="num">${kai && Number.isFinite(kai.value) ? kai.value.toFixed(1) : '—'}<em>秒</em></strong></div><div class="ov-list"><span class="lead">${warns.length ? `見直したい点 ${warns.length} 項目` : '目安から外れた項目はありません'}</span>`;
  const dup = (lab) => S.metrics.filter(x => x.label === lab).length > 1;
  const gname = (g) => (GROUPS.find(x => x[0] === g) || [, ''])[1];
  for (const m of warns) html += `<button type="button" class="chip warn" data-key="${m.key}">${esc(m.label)}${dup(m.label) ? `（${esc(gname(m.group))}）` : ''}：${esc(m.verdict)}</button>`;
  html += `</div></div><div class="groups">`;
  for (const [g, name, sub] of GROUPS) {
    const rows = S.metrics.filter(m => m.group === g && m.key !== 'kaiLen');
    if (!rows.length) continue;
    html += `<div class="group"><h3>${name}<span>${sub}</span></h3>`;
    for (const m of rows) {
      html += `<button type="button" class="mrow" data-key="${m.key}"><span class="m-l">${esc(m.label)}<span class="vtag">${VIEWNAME[m.view]}</span></span>` +
        `${m.verdict ? `<span class="chip ${m.status}">${esc(m.verdict)}</span>` : ''}<span class="m-v">${esc(m.display)}</span>` +
        `${m.note ? `<span class="m-n">${esc(m.note)}</span>` : ''}</button>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  A.innerHTML = html;
  $$('[data-key]', A).forEach(b => b.addEventListener('click', () => {
    const m = S.metrics.find(x => x.key === b.dataset.key);
    if (!m || !Number.isFinite(m.t)) return;
    pause();
    const want = m.view === 'both' ? '3d' : (S.layout === '3d' && !isWide3d() ? 'both' : S.layout);
    if (want !== S.layout) setLayout(want);
    setTime(m.t);
    $('#viewer').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const anyBusy = () => Object.values(V).some(v => v.status === 'analyzing' || v.status === 'ready' || v.status === 'loading');

// ---------- 推移グラフ ----------
const chart = $('#chart');
function chartTrack() { return V.front.track ? V.front : (V.side.track ? V.side : null); }
function drawChart() {
  const [W, H] = sizeCanvas(chart, 300);
  const ctx = chart.getContext('2d'); ctx.clearRect(0, 0, W, H);
  const v = chartTrack(); const dur = masterDuration();
  $('#chartSub').textContent = v ? `${v.label}の動画から（肩の高さを 0 とした cm）` : '解析した動画から';
  ctx.font = `${Math.round(11 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
  if (!v || !dur) { ctx.fillStyle = C.muted; ctx.fillText('解析すると表示します', 12 * dpr, 24 * dpr); return; }
  const tr = v.track, cpp = cmPerPx(tr);
  const padL = 40 * dpr, padR = 10 * dpr, top0 = 4 * dpr, top1 = 24 * dpr, h1 = H * 0.48, gapY = 30 * dpr, top2 = top1 + h1 + gapY, h2 = H - top2 - 22 * dpr;
  const X = (t) => padL + clamp(t / dur, 0, 1) * (W - padL - padR);
  // 八節の帯
  if (S.ph) {
    const b = S.ph.bounds;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? C.bg : C.surface;
      ctx.fillRect(X(b[i]), top0, X(b[i + 1]) - X(b[i]), top2 + h2 - top0);
    }
    ctx.fillStyle = C.muted; ctx.textAlign = 'center';
    for (let i = 0; i < 8; i++) { const w = X(b[i + 1]) - X(b[i]); if (w > 26 * dpr) ctx.fillText(PH[i].name, (X(b[i]) + X(b[i + 1])) / 2, top0 + 13 * dpr); }
  }
  const G = tr.grid, step = Math.max(1, Math.floor(G.G / 600));
  const series1 = [], series2 = [];
  const sep = [];
  for (let g = 0; g < G.G; g += step) {
    const t = viewToMaster(v.key, G.gt[g]);
    const shy = (G.Y[5][g] + G.Y[6][g]) / 2;
    series1.push([t, (shy - G.Y[9][g]) * cpp]); series2.push([t, (shy - G.Y[10][g]) * cpp]);
    sep.push([t, Math.hypot(G.X[9][g] - G.X[10][g], G.Y[9][g] - G.Y[10][g]) * cpp]);
  }
  const range = (arr) => { let a = Infinity, b = -Infinity; for (const [, y] of arr) { if (Number.isFinite(y)) { a = Math.min(a, y); b = Math.max(b, y); } } return [a, b]; };
  let [a1, b1] = range(series1.concat(series2)); const [a2r, b2r] = range(sep);
  if (!Number.isFinite(a1)) return;
  const nice = (lo, hi, n) => { const span = hi - lo || 1; const st = Math.pow(10, Math.floor(Math.log10(span / n))); const m = [1, 2, 5, 10].find(f => span / (st * f) <= n) * st; return [Math.floor(lo / m) * m, Math.ceil(hi / m) * m, m]; };
  const [y1lo, y1hi, y1s] = nice(a1, b1, 4), [y2lo, y2hi, y2s] = nice(Math.max(0, a2r), b2r, 3);
  const Y1 = (y) => top1 + (1 - (y - y1lo) / (y1hi - y1lo)) * h1;
  const Y2 = (y) => top2 + (1 - (y - y2lo) / (y2hi - y2lo)) * h2;
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let y = y1lo; y <= y1hi + 1e-6; y += y1s) { ctx.beginPath(); ctx.moveTo(padL, Y1(y)); ctx.lineTo(W - padR, Y1(y)); ctx.stroke(); ctx.fillText(String(Math.round(y)), padL - 6 * dpr, Y1(y)); }
  for (let y = y2lo; y <= y2hi + 1e-6; y += y2s) { ctx.beginPath(); ctx.moveTo(padL, Y2(y)); ctx.lineTo(W - padR, Y2(y)); ctx.stroke(); ctx.fillText(String(Math.round(y)), padL - 6 * dpr, Y2(y)); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('cm', padL - 6 * dpr, top2 - 4 * dpr);
  ctx.fillText('cm', padL - 6 * dpr, top1 - 6 * dpr);
  ctx.textAlign = 'left';
  // 0 の線（肩の高さ）
  if (y1lo < 0 && y1hi > 0) { ctx.strokeStyle = C.muted; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.beginPath(); ctx.moveTo(padL, Y1(0)); ctx.lineTo(W - padR, Y1(0)); ctx.stroke(); ctx.setLineDash([]); }
  const line = (arr, Y, col) => { ctx.strokeStyle = col; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath(); let f = true; for (const [t, y] of arr) { if (!Number.isFinite(y)) continue; const x = X(t); if (f) { ctx.moveTo(x, Y(y)); f = false; } else ctx.lineTo(x, Y(y)); } ctx.stroke(); };
  line(series1, Y1, C['yunde-ln']); line(series2, Y1, C['mete-ln']); line(sep, Y2, C.ya);
  // 時間の目盛り
  ctx.fillStyle = C.muted; ctx.textAlign = 'center';
  const ts = dur > 40 ? 10 : 5;
  for (let t = 0; t <= dur; t += ts) ctx.fillText(t + '秒', X(t), H - 6 * dpr);
  // 再生位置
  const xp = X(S.t);
  ctx.fillStyle = C.sub; ctx.fillRect(xp - dpr * 0.75, top0, 1.5 * dpr, top2 + h2 - top0);
}
function viewToMaster(key, t) { if (key === S.master) return t; return S.master === 'front' ? t + S.offset : t - S.offset; }
chart.addEventListener('click', (e) => {
  const r = chart.getBoundingClientRect(); const padL = 40, padR = 10;
  const u = (e.clientX - r.left - padL) / (r.width - padL - padR);
  if (u < 0 || u > 1) return;
  pause(); setTime(u * masterDuration());
});

// ---------- 矢所 ----------
const photo = $('#photo');
const STEP_HINT = ['写真の的の中心をタップしてください。', '的の右の縁（外黒の外側）をタップしてください。', '的の上の縁をタップしてください。', '矢の刺さった所をタップすると印が付きます。印はドラッグで動かせます。'];
function renderTarget() {
  const tg = S.target;
  $$('#steps .step').forEach((s, i) => { s.setAttribute('aria-current', String(tg.src && tg.step === i)); s.classList.toggle('done', !!tg.src && tg.step > i); });
  $('#stepHint').textContent = tg.src ? STEP_HINT[tg.step] : '上の「矢所の写真」から写真を選んでください。';
  drawPhoto(); renderSchem();
}
function photoScale() { return photo.width / (S.target.w || 1); }
function drawPhoto() {
  const tg = S.target;
  const w = Math.max(200, (photo.parentElement.clientWidth || 320) - 20);
  if (!tg.src) {
    const H = Math.round(w * 0.6);
    photo.width = Math.round(w * dpr); photo.height = Math.round(H * dpr); photo.style.width = w + 'px'; photo.style.height = H + 'px';
    const ctx = photo.getContext('2d'); ctx.fillStyle = C.sunk; ctx.fillRect(0, 0, photo.width, photo.height);
    ctx.fillStyle = C.muted; ctx.font = `${Math.round(13 * dpr)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center';
    ctx.fillText(tg.photoId ? '写真を読み込んでいます…' : (tg.partAt ? '写真は共有されていません（印だけ共有）' : '矢所の写真はまだありません'), photo.width / 2, photo.height / 2); ctx.textAlign = 'left';
    return;
  }
  const maxH = window.innerHeight * 0.62;
  let cw = w, ch = cw * tg.h / tg.w;
  if (ch > maxH) { ch = maxH; cw = ch * tg.w / tg.h; }
  photo.style.width = Math.round(cw) + 'px'; photo.style.height = Math.round(ch) + 'px';
  photo.width = Math.round(cw * dpr); photo.height = Math.round(ch * dpr);
  const ctx = photo.getContext('2d');
  ctx.drawImage(tg.src, 0, 0, photo.width, photo.height);
  const s = photoScale();
  const c = tg.calib || {}, tmp = tg.tmp;
  const cx = (c.cx ?? tmp.cx), cy = (c.cy ?? tmp.cy);
  const lw = Math.max(1.5, 2 * dpr);
  if (Number.isFinite(cx)) {
    ctx.strokeStyle = C['ov-guide']; ctx.lineWidth = lw;
    const X = cx * s, Y = cy * s;
    ctx.beginPath(); ctx.moveTo(X - 12 * dpr, Y); ctx.lineTo(X + 12 * dpr, Y); ctx.moveTo(X, Y - 12 * dpr); ctx.lineTo(X, Y + 12 * dpr); ctx.stroke();
    const rx = c.rx ?? tmp.rx, ry = c.ry ?? tmp.ry ?? rx;
    if (Number.isFinite(rx)) {
      ctx.globalAlpha = 0.9; ctx.setLineDash([5 * dpr, 4 * dpr]);
      for (const [r] of K.KASUMI) { ctx.beginPath(); ctx.ellipse(X, Y, rx * s * r / 18, ry * s * r / 18, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }
  ctx.font = `700 ${Math.round(12 * dpr)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  tg.marks.forEach((m, i) => {
    const X = m.x * s, Y = m.y * s, r = 11 * dpr;
    const isShot = tg.shot === i + 1;
    ctx.fillStyle = isShot ? C['ov-ya'] : 'rgba(255,255,255,.92)'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.fillText(String(i + 1), X, Y + 0.5);
  });
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
let drag = null;
function photoPt(e) { const r = photo.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * S.target.w, y: (e.clientY - r.top) / r.height * S.target.h }; }
photo.addEventListener('pointerdown', (e) => {
  const tg = S.target; if (!tg.src) return;
  const p = photoPt(e);
  const tol = 20 / (photo.getBoundingClientRect().width / tg.w);
  const hit = tg.step === 3 ? tg.marks.findIndex(m => Math.hypot(m.x - p.x, m.y - p.y) < tol) : -1;
  drag = { i: hit, start: p, moved: false };
  SH.dragging = true;
  photo.setPointerCapture(e.pointerId);
});
photo.addEventListener('pointermove', (e) => {
  if (!drag || drag.i < 0) return;
  const p = photoPt(e);
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 2) drag.moved = true;
  S.target.marks[drag.i] = p; drawPhoto(); renderSchem();
});
photo.addEventListener('pointerup', (e) => {
  const tg = S.target; if (!drag) return;
  const p = photoPt(e); const d = drag; drag = null; SH.dragging = false;
  if (d.i >= 0) { if (!d.moved) { tg.shot = tg.shot === d.i + 1 ? 0 : d.i + 1; } renderTarget(); renderSlots(); shareTarget(); return; }
  if (tg.step === 0) { tg.tmp = { cx: p.x, cy: p.y }; tg.calib = null; tg.step = 1; }
  else if (tg.step === 1) { tg.tmp.rx = Math.abs(p.x - tg.tmp.cx) || 1; tg.step = 2; }
  else if (tg.step === 2) { tg.tmp.ry = Math.abs(p.y - tg.tmp.cy) || tg.tmp.rx; tg.calib = { cx: tg.tmp.cx, cy: tg.tmp.cy, rx: tg.tmp.rx, ry: tg.tmp.ry }; tg.step = 3; }
  else { tg.marks.push(p); }
  renderTarget(); renderSlots();
  if (tg.step === 3) shareTarget();
});
$('#undoMark').addEventListener('click', () => { const tg = S.target; tg.marks.pop(); if (tg.shot > tg.marks.length) tg.shot = 0; renderTarget(); renderSlots(); shareTarget(); });
$('#clearMarks').addEventListener('click', () => { S.target.marks = []; S.target.shot = 0; renderTarget(); renderSlots(); shareTarget(); });
$('#recalib').addEventListener('click', () => { const tg = S.target; if (!tg.src) return; tg.calib = null; tg.tmp = {}; tg.step = 0; renderTarget(); });
$('#rightMae').addEventListener('change', (e) => { S.target.rightIsMae = e.target.checked; renderSchem(); shareTarget(); });

function renderSchem() {
  const tg = S.target, svg = $('#schem');
  let g = '';
  const rings = [[18, 'mato-k'], [14.7, 'mato-w'], [11.7, 'mato-k'], [10.2, 'mato-w'], [7.2, 'mato-k'], [3.6, 'mato-w']];
  g += `<circle r="18.9" style="fill:var(--mato-rim)"/>`;
  for (const [r, c] of rings) g += `<circle r="${r}" style="fill:var(--${c})"/>`;
  const lab = (x, y, a, t) => `<text x="${x}" y="${y}" font-size="1.8" text-anchor="${a}" style="fill:var(--muted)">${t}</text>`;
  g += lab(0, -19.8, 'middle', '上') + lab(0, 21.2, 'middle', '下') + lab(19.8, 0.6, 'start', '前') + lab(-19.8, 0.6, 'end', '後');
  const st = K.targetStats(tg.calib, tg.marks, tg.rightIsMae);
  const ul = $('#hits'), sum = $('#tsum'), sp = $('#shotPick');
  ul.innerHTML = ''; sp.innerHTML = '';
  if (st) {
    g += `<g style="stroke:var(--ov-guide)" stroke-width="0.5" stroke-linecap="round"><line x1="${st.cx - 1}" y1="${-st.cy - 1}" x2="${st.cx + 1}" y2="${-st.cy + 1}"/><line x1="${st.cx - 1}" y1="${-st.cy + 1}" x2="${st.cx + 1}" y2="${-st.cy - 1}"/></g>`;
    for (const p of st.pts) {
      const isShot = tg.shot === p.i;
      g += `<circle cx="${p.xcm.toFixed(2)}" cy="${(-p.ycm).toFixed(2)}" r="1.5" style="fill:${isShot ? 'var(--ov-ya)' : 'var(--ov-mete)'};stroke:var(--mato-k)" stroke-width="0.3"/>`;
      g += `<text x="${p.xcm.toFixed(2)}" y="${(-p.ycm + 0.62).toFixed(2)}" font-size="1.75" font-weight="700" text-anchor="middle" style="fill:var(--mato-k)">${p.i}</text>`;
      const li = document.createElement('li'); if (isShot) li.className = 'shot';
      li.innerHTML = `<span class="n">${p.i}</span><span>${p.hit ? p.zone : '外れ'}・${K.dirWords(p.xcm, p.ycm)}${isShot ? '（この射）' : ''}</span><span class="d">${p.clock}時 ${p.r.toFixed(1)}cm</span>`;
      ul.appendChild(li);
    }
    sum.innerHTML = `<b class="num">${st.hits}</b> / ${st.pts.length} 本 的中。平均の位置は ${K.dirWords(st.cx, st.cy)}（前後 ${st.cx >= 0 ? '前' : '後ろ'} ${Math.abs(st.cx).toFixed(1)} cm・上下 ${st.cy >= 0 ? '上' : '下'} ${Math.abs(st.cy).toFixed(1)} cm）、まとまり ${st.spread.toFixed(1)} cm。`;
    sp.innerHTML = '<span>この動画の矢:</span>';
    st.pts.forEach(p => { const b = document.createElement('button'); b.type = 'button'; b.textContent = p.i; b.setAttribute('aria-pressed', String(tg.shot === p.i)); b.addEventListener('click', () => { tg.shot = tg.shot === p.i ? 0 : p.i; renderTarget(); shareTarget(); }); sp.appendChild(b); });
  } else {
    sum.textContent = tg.src ? (tg.calib ? '矢所をタップすると、ここに位置が出ます。' : '写真で的の中心と縁を合わせてください。') : '写真を選ぶと、霞的の図に矢所を写して位置を測ります。';
  }
  svg.innerHTML = g;
}

async function onPhotoFile(file) {
  if (!file) return;
  if (SH.db && !SH.shotId && !SH.writeBlocked && SH.canWrite !== false) await createShot();
  if (S.sample) { exitSample(); recompute(true); }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const tg = S.target;
    tg.src = img; tg.w = img.naturalWidth; tg.h = img.naturalHeight; tg.name = file.name;
    tg.calib = null; tg.tmp = {}; tg.step = 0; tg.marks = []; tg.shot = 0;
    renderTarget(); renderSlots(); renderAll();
    $('#h-tgt').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (canShare()) sharePhoto(file);
  };
  img.onerror = () => { $('#stepHint').textContent = 'この写真は読み込めませんでした。JPEG か PNG で試してください。'; };
  img.src = url;
}

// ---------- 動画の読み込み ----------
async function onVideoFile(key, file) {
  if (!file || S.busy) return;
  pause();
  if (SH.db && !SH.shotId && !SH.writeBlocked && SH.canWrite !== false) await createShot();
  if (S.sample) exitSample();
  const v = V[key];
  if (v.url) URL.revokeObjectURL(v.url);
  v.file = file; v.url = URL.createObjectURL(file); v.track = null; v.status = 'loading'; v.pick = null; v.liveK = null; v.sampleBg = false;
  renderAll();
  const vid = v.video;
  vid.src = v.url; vid.muted = true; vid.playsInline = true;
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), 20000);
      vid.onloadedmetadata = () => { clearTimeout(to); res(); };
      vid.onerror = () => { clearTimeout(to); rej(new Error('decode')); };
      vid.load();
    });
    // iOS では一度再生しないとコマ送りできないことがある
    try { await vid.play(); vid.pause(); } catch (e) { /* 自動再生不可でも続ける */ }
    v.w = vid.videoWidth; v.h = vid.videoHeight; v.duration = vid.duration;
    if (!v.w || !Number.isFinite(v.duration)) throw new Error('meta');
    await seekTo(vid, Math.min(0.1, v.duration / 2));
    v.status = 'ready';
    S.layout = 'both';
    $$('.viewbar .seg button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.layout === 'both')));
  } catch (e) {
    v.status = 'error'; v.error = 'この動画は読み込めませんでした。MP4（H.264）か MOV で試してください。';
  }
  if (!V.front.track && !V.side.track) S.master = key === 'front' || V.front.status !== 'empty' ? 'front' : 'side';
  renderAll();
}
function seekTo(video, t) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); res(); };
    video.addEventListener('seeked', fin);
    try { video.currentTime = t; } catch (e) { fin(); }
    setTimeout(fin, 2000);
  });
}

// ---------- 姿勢推定 ----------
let tfPromise = null, model = null, modelKind = null, cancelFlag = false;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('script')); document.head.appendChild(s); });
}
async function ensureTf(onStage) {
  if (!tfPromise) {
    onStage('解析の準備をしています（初回のみ）');
    tfPromise = loadScript(TF_URL).then(async () => {
      try { await tf.setBackend('webgl'); } catch (e) { await tf.setBackend('cpu'); }
      await tf.ready();
    });
    tfPromise.catch(() => { tfPromise = null; });
  }
  await tfPromise;
}
// 重みは配信できる形式（Base64 の .txt）に分けて置いてある
async function loadShardModel(jsonName) {
  try { return await tf.loadGraphModel('models/' + jsonName); } catch (e) { throw new Error('model'); }
}
async function ensureModel(kind, onStage) {
  await ensureTf(onStage);
  if (model && modelKind === kind) return model;
  onStage('姿勢推定モデルを読み込んでいます');
  if (model) { model.dispose(); model = null; }
  model = await loadShardModel(`movenet-${kind}.json`);
  modelKind = kind;
  const size = kind === 'thunder' ? 256 : 192;
  const z = tf.zeros([1, size, size, 3], 'int32'); const r = model.execute(z); await r.data(); tf.dispose([z, r]);
  return model;
}
const cropCv = document.createElement('canvas');
async function inferBox(video, vw, vh, box, size) {
  if (cropCv.width !== size) { cropCv.width = size; cropCv.height = size; }
  const c = cropCv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, size, size);
  const sx0 = Math.max(0, box.x), sy0 = Math.max(0, box.y), sx1 = Math.min(vw, box.x + box.s), sy1 = Math.min(vh, box.y + box.s);
  if (sx1 > sx0 && sy1 > sy0) {
    const k = size / box.s;
    c.drawImage(video, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - box.x) * k, (sy0 - box.y) * k, (sx1 - sx0) * k, (sy1 - sy0) * k);
  }
  const input = tf.tidy(() => tf.browser.fromPixels(cropCv).toInt().expandDims(0));
  const out = model.execute(input);
  const d = await out.data();
  tf.dispose([input, out]);
  const k = new Array(51);
  for (let j = 0; j < 17; j++) { k[j * 3] = box.x + d[j * 3 + 1] * box.s; k[j * 3 + 1] = box.y + d[j * 3] * box.s; k[j * 3 + 2] = d[j * 3 + 2]; }
  return k;
}
function fullBox(vw, vh, pick) {
  const s = Math.max(vw, vh);
  if (pick) { const ps = Math.min(s, Math.max(vh * 0.95, vw * 0.4)); return { x: pick.x - ps / 2, y: vh / 2 - ps / 2, s: ps }; }
  return { x: (vw - s) / 2, y: (vh - s) / 2, s };
}
function boxFrom(k, vw, vh, fallback) {
  const xs = [], ys = [];
  for (let j = 0; j < 17; j++) if (k[j * 3 + 2] > 0.25) { xs.push(k[j * 3]); ys.push(k[j * 3 + 1]); }
  if (xs.length < 6) return fallback;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const M = Math.max(vw, vh);
  let s = Math.max(x1 - x0, y1 - y0) * 1.45 + M * 0.03;
  s = clamp(s, M * 0.2, M * 1.05);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 - s * 0.03;
  return { x: cx - s / 2, y: cy - s / 2, s };
}
const meanScore = (k) => { let a = 0; for (let j = 0; j < 17; j++) a += k[j * 3 + 2]; return a / 17; };

async function runPass(v, times, size, initBox, setProg, progBase, progSpan, startK) {
  const vid = v.video, vw = v.w, vh = v.h;
  const out = [];
  let box = startK ? boxFrom(startK, vw, vh, initBox) : initBox;
  let t0 = performance.now();
  for (let i = 0; i < times.length; i++) {
    if (cancelFlag) throw new Error('cancel');
    await seekTo(vid, times[i]);
    let k = await inferBox(vid, vw, vh, box, size);
    if (i === 0 && !startK) { box = boxFrom(k, vw, vh, initBox); k = await inferBox(vid, vw, vh, box, size); }
    if (meanScore(k) < 0.18) { box = initBox; } else box = boxFrom(k, vw, vh, initBox);
    out.push({ t: times[i], k });
    if (v.thumbs) v.thumbs.add(vid);
    v.liveK = toKp(k);
    if (i % 2 === 0) { drawView(v); }
    const el = (performance.now() - t0) / 1000, per = el / (i + 1), rest = per * (times.length - i - 1);
    setProg(progBase + progSpan * (i + 1) / times.length, rest);
  }
  return out;
}
const toKp = (k) => { const o = []; for (let j = 0; j < 17; j++) o.push({ x: k[j * 3], y: k[j * 3 + 1], s: k[j * 3 + 2] }); return o; };

async function startAnalysis(keys) {
  if (S.busy) return;
  pause();
  S.busy = true; cancelFlag = false;
  for (const key of keys) {
    const v = V[key];
    if (v.status !== 'ready') continue;
    v.status = 'analyzing'; v.progress = 0; v.liveK = null;
    renderAll();
    const bar = $('.bar i', v.prog), txt = $('.ptxt', v.prog);
    const stage = (s) => { txt.textContent = s; };
    const setProg = (p, rest) => {
      v.progress = p; bar.style.width = (p * 100).toFixed(1) + '%';
      const r = Number.isFinite(rest) ? (rest > 90 ? `あと約${Math.ceil(rest / 60)}分` : `あと約${Math.max(1, Math.round(rest))}秒`) : '';
      txt.textContent = `${v.label}を解析中 ${Math.round(p * 100)}% ${r}`;
      renderSlots();
    };
    try {
      await ensureModel(S.model, stage);
      const size = modelKind === 'thunder' ? 256 : 192;
      const step = 1 / S.fps, times = [];
      for (let t = Math.min(0.05, v.duration / 4); t < v.duration - 0.02; t += step) times.push(t);
      const initBox = fullBox(v.w, v.h, v.pick);
      v.thumbs = canShare() ? new ThumbSheets(v.w, v.h) : null;
      const f1 = await runPass(v, times, size, initBox, setProg, 0, 0.88, null);
      let all = f1;
      let track = K.prepareTrack({ view: key, w: v.w, h: v.h, duration: v.duration, frames: f1.map(f => ({ t: f.t, k: f.k })) });
      let ph = K.detectPhases(track);
      if (ph) {
        // 離れの前後だけ細かく解析し直す
        const dense = [];
        for (let t = ph.tHanare - 0.6; t <= ph.tHanare + 0.6; t += 1 / 30) if (t > 0 && t < v.duration && !f1.some(f => Math.abs(f.t - t) < 0.012)) dense.push(t);
        const near = f1.reduce((a, f) => Math.abs(f.t - (ph.tHanare - 0.6)) < Math.abs(a.t - (ph.tHanare - 0.6)) ? f : a, f1[0]);
        const f2 = await runPass(v, dense, size, initBox, setProg, 0.88, 0.12, near.k);
        all = f1.concat(f2);
        track = K.prepareTrack({ view: key, w: v.w, h: v.h, duration: v.duration, frames: all.map(f => ({ t: f.t, k: f.k })) });
        ph = K.detectPhases(track);
      }
      track.phasesAuto = ph;
      v.track = track; v.status = 'done'; v.liveK = null;
      if (!ph) v.note = '八節を自動で区切れませんでした';
      if (canShare()) { txt.textContent = `${v.label}の結果を共有しています`; await sharePart(key, v, all, v.thumbs, ph ? ph.tHanare : NaN); }
      v.thumbs = null;
    } catch (e) {
      v.liveK = null;
      if (e && e.message === 'cancel') { v.status = 'ready'; }
      else { console.error(e); v.status = 'error'; v.error = e && (e.message === 'script' || e.message === 'model') ? '解析の部品を読み込めませんでした。通信を確認して、もう一度お試しください。' : '解析中に問題が起きました。もう一度お試しください。'; }
    }
    if (cancelFlag) break;
  }
  S.busy = false; cancelFlag = false;
  recompute(true);
  const M = masterTrack();
  if (S.fz) { CAM.yaw = 0; CAM.pitch = 90; CAM.zoom = 1; setCamPressed('top'); setLayout('3d'); }
  if (M && S.ph) setTime((S.ph.bounds[5] + S.ph.tHanare) / 2); else setTime(0);
}

// ---------- 文章でコピー ----------
function summaryText() {
  const L = ['射形分析帳の結果' + (SH.shotId && SH.shot ? `（${fmtShot(SH.shot)}）` : '')];
  if (S.ph) L.push('射法八節: ' + PH.map((p, i) => `${p.name} ${(S.ph.bounds[i + 1] - S.ph.bounds[i]).toFixed(1)}秒`).join(' / '));
  for (const [g, name] of GROUPS) {
    const rows = S.metrics.filter(m => m.group === g);
    if (!rows.length) continue;
    L.push(`【${name}】`);
    for (const m of rows) L.push(`・${m.label}（${VIEWNAME[m.view]}）: ${m.display}${m.verdict ? ' … ' + m.verdict : ''}`);
  }
  const st = K.targetStats(S.target.calib, S.target.marks, S.target.rightIsMae);
  if (st) {
    L.push('【矢所】');
    L.push(`${st.pts.length}本中${st.hits}本的中。平均 ${K.dirWords(st.cx, st.cy)}（前後 ${st.cx.toFixed(1)}cm・上下 ${st.cy.toFixed(1)}cm）、まとまり ${st.spread.toFixed(1)}cm`);
    for (const p of st.pts) L.push(`・${p.i}${S.target.shot === p.i ? '（この射）' : ''}: ${p.hit ? p.zone : '外れ'} ${p.clock}時 ${p.r.toFixed(1)}cm`);
  }
  if (S.sample) L.push('※合成サンプルの結果です');
  return L.join('\n');
}
function copySummary(msgEl, anchor) {
  const text = summaryText(); const fb = $('#copyFallback');
  const showFb = () => { anchor.after(fb); fb.hidden = false; fb.value = text; fb.focus(); fb.select(); msgEl.textContent = 'コピーできなかったので、下の文章を選択しました。'; };
  try {
    navigator.clipboard.writeText(text).then(() => { msgEl.textContent = 'コピーしました'; fb.hidden = true; }, showFb);
  } catch (e) { showFb(); }
}
$('#copyBtn').addEventListener('click', (e) => copySummary($('#copyMsg'), e.currentTarget.parentElement));

// ---------- 共有（GAS のサーバーに保存し、合言葉を知っている人で見る） ----------
// 射ごとに 1 行（スプレッドシート）。骨格データと画像はドライブ。数秒ごとに変化を確かめる
const API_URL = ((window.SHAKEI_CONFIG || {}).apiUrl || '').trim();
const SH = {
  db: null, api: !!API_URL, role: null, key: '', name: '', uid: '', club: '', ai: false, aiLeft: 0,
  canWrite: null, canEdit: false, writeBlocked: false,
  shots: [], listState: 'off', shotId: null, shot: null, updatedAt: 0, names: {}, newer: null,
  declinedAuto: false, msg: '', confirmDel: false, shotPatch: null, shotTimer: 0, shotChain: Promise.resolve(), targetTimer: 0,
  pending: 0, polling: false, pollT: 0, listT: 0, fails: 0, blobs: {}, coachBusy: false
};
(function initIdentity() {
  SH.key = store.get('key') || '';
  SH.name = store.get('name') || '';
  let dev = store.get('dev');
  if (!dev) { dev = 'd' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('dev', dev); }
  SH.uid = dev;
})();
const pad2 = (n) => String(n).padStart(2, '0');
function b64FromBytes(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function encodeFrames(frames) {
  const n = frames.length, t = new Float32Array(n), k = new Int16Array(n * 51), ti = new Uint16Array(n);
  frames.forEach((f, i) => {
    t[i] = f.t; ti[i] = f.i;
    for (let j = 0; j < 17; j++) {
      k[i * 51 + j * 3] = clamp(Math.round(f.k[j * 3] * 4), -32767, 32767);
      k[i * 51 + j * 3 + 1] = clamp(Math.round(f.k[j * 3 + 1] * 4), -32767, 32767);
      k[i * 51 + j * 3 + 2] = clamp(Math.round(f.k[j * 3 + 2] * 10000), 0, 10000);
    }
  });
  return { n, t: b64FromBytes(new Uint8Array(t.buffer)), k: b64FromBytes(new Uint8Array(k.buffer)), ti: b64FromBytes(new Uint8Array(ti.buffer)) };
}
function decodeFrames(p) {
  const t = new Float32Array(bytesFromB64(p.t).buffer), k = new Int16Array(bytesFromB64(p.k).buffer);
  const ti = p.ti ? new Uint16Array(bytesFromB64(p.ti).buffer) : null;
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const a = new Array(51);
    for (let j = 0; j < 17; j++) { a[j * 3] = k[i * 51 + j * 3] / 4; a[j * 3 + 1] = k[i * 51 + j * 3 + 1] / 4; a[j * 3 + 2] = k[i * 51 + j * 3 + 2] / 10000; }
    out.push({ t: t[i], k: a, i: ti ? ti[i] : i });
  }
  return out;
}
// 解析したコマを 8×8 枚ずつ 1 枚の JPEG に並べる（他の人はこれをコマ送りで見る）
class ThumbSheets {
  constructor(vw, vh) {
    const s = 270 / Math.max(vw, vh);
    this.tw = Math.max(2, Math.round(vw * s)); this.th = Math.max(2, Math.round(vh * s));
    this.cols = 8; this.per = 64;
    this.cv = document.createElement('canvas'); this.cv.width = this.tw * this.cols; this.cv.height = this.th * (this.per / this.cols);
    this.ctx = this.cv.getContext('2d'); this.count = 0; this.inSheet = 0; this.pending = [];
  }
  add(src) {
    if (this.inSheet === this.per) this.flush();
    const i = this.inSheet;
    try { this.ctx.drawImage(src, (i % this.cols) * this.tw, Math.floor(i / this.cols) * this.th, this.tw, this.th); } catch (e) { /* 描けないコマは黒のまま */ }
    this.inSheet++; this.count++;
  }
  flush() {
    if (!this.inSheet) return;
    const c = document.createElement('canvas'); c.width = this.cv.width; c.height = Math.ceil(this.inSheet / this.cols) * this.th;
    c.getContext('2d').drawImage(this.cv, 0, 0);
    this.pending.push(new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.72)));
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.cv.width, this.cv.height); this.inSheet = 0;
  }
  async finish() { this.flush(); return Promise.all(this.pending); }
}

// ---- サーバー呼び出し ----
// text/plain で送ると、ブラウザの事前確認なしで GAS に届く
async function api(action, body = {}, keyOverride) {
  if (!API_URL) throw { code: 'no_server', message: 'サーバーが設定されていません。' };
  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action, key: keyOverride != null ? keyOverride : SH.key, ...body }), redirect: 'follow' });
  } catch (e) { throw { code: 'network', message: 'サーバーにつながりません。通信を確認してください。' }; }
  let out;
  try { out = await res.json(); } catch (e) { throw { code: 'network', message: 'サーバーから正しい返事がありませんでした。' }; }
  if (!out.ok) throw { code: out.error || 'server', message: out.message || 'サーバーで問題が起きました。' };
  return out;
}
async function blobUrl(shotId, fileId) {
  const k = shotId + '/' + fileId;
  if (SH.blobs[k]) return SH.blobs[k];
  SH.blobs[k] = api('getBlob', { id: shotId, fileId }).then(r => URL.createObjectURL(new Blob([bytesFromB64(r.b64)], { type: r.mime || 'image/jpeg' })));
  SH.blobs[k].catch(() => { delete SH.blobs[k]; });
  return SH.blobs[k];
}
function blobToB64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
}

function makeFlip(p, frames, shotId) {
  if (!p.sheets || !p.sheets.length || !p.tile) return null;
  const order = frames.map(f => ({ t: f.t, i: f.i })).sort((a, b) => a.t - b.t);
  const imgs = p.sheets.map(id => {
    const im = new Image();
    im.onload = () => drawAll();
    blobUrl(shotId, id).then(u => { im.src = u; }).catch(() => { /* 画像なしで骨格だけ表示 */ });
    return im;
  });
  return { order, imgs, tile: p.tile };
}
function drawFlip(ctx, v, tv, W, H) {
  ctx.fillStyle = '#0e1013'; ctx.fillRect(0, 0, W, H);
  const f = v.flip; if (!f) return;
  const o = f.order; let lo = 0, hi = o.length - 1;
  if (hi < 0) return;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (o[m].t <= tv) lo = m; else hi = m; }
  const pick = Math.abs(o[hi].t - tv) < Math.abs(o[lo].t - tv) ? o[hi] : o[lo];
  const tl = f.tile, sheet = Math.floor(pick.i / tl.per), idx = pick.i % tl.per;
  const im = f.imgs[sheet];
  if (!im || !im.complete || !im.naturalWidth) return;
  ctx.drawImage(im, (idx % tl.cols) * tl.w, Math.floor(idx / tl.cols) * tl.h, tl.w, tl.h, 0, 0, W, H);
}

// ---- 入る（合言葉と表示名） ----
async function initShared() {
  renderShotBar();
  if (!API_URL || !SH.key) return;
  await login(SH.key, SH.name, true);
}
async function login(key, name, silent) {
  SH.msg = silent ? '' : '確かめています…'; renderShotBar();
  try {
    const r = await api('hello', {}, key);
    SH.key = key; SH.name = name; store.set('key', key); store.set('name', name);
    SH.role = r.role; SH.club = r.club || ''; SH.ai = !!r.ai; SH.aiLeft = r.aiLeft || 0;
    SH.canWrite = r.role === 'edit' || r.role === 'admin'; SH.canEdit = r.role === 'admin'; SH.writeBlocked = false;
    SH.db = true; SH.msg = ''; SH.listState = 'loading';
    renderShotBar(); renderCoach();
    await pollList(true);
    schedulePoll();
  } catch (e) {
    SH.db = null; SH.role = null;
    if (e.code === 'bad_key') { SH.key = ''; store.set('key', ''); }
    SH.msg = e.message || '入れませんでした。';
    if (silent && e.code === 'network') setTimeout(() => { if (!SH.db && SH.key) login(SH.key, SH.name, true); }, 15000);
    renderShotBar();
  }
}
function logout() {
  clearTimeout(SH.pollT); clearTimeout(SH.listT);
  SH.key = ''; store.set('key', ''); SH.db = null; SH.role = null; SH.shots = []; SH.listState = 'off';
  SH.declinedAuto = true; SH.msg = '';
  if (SH.shotId) selectShot(null); else renderShotBar();
  renderCoach();
}
const anyLocalWork = () => Object.values(V).some(v => v.status !== 'empty') || !!S.target.src;

// ---- 数秒ごとの確認 ----
function schedulePoll() {
  clearTimeout(SH.pollT);
  const hidden = document.visibilityState === 'hidden';
  const wait = Math.min(60000, (hidden ? 30000 : 5000) * Math.pow(2, Math.min(SH.fails, 3)));
  SH.pollT = setTimeout(pollTick, wait);
}
let lastList = 0;
async function pollTick() {
  if (!SH.db) return;
  try {
    if (Date.now() - lastList > 20000) await pollList(false);
    if (SH.shotId) await pollShot();
    if (SH.fails) { SH.fails = 0; if (SH.msg.startsWith('サーバー')) SH.msg = ''; renderShotBar(); }
  } catch (e) {
    SH.fails++;
    if (e.code === 'bad_key') { logout(); SH.msg = '合言葉が変わりました。入れ直してください。'; renderShotBar(); return; }
    if (e.code === 'not_found' && SH.shotId) { SH.msg = 'この射の記録は消されました。'; selectShot(null); }
    else if (SH.fails >= 2) { SH.msg = e.message; renderShotBar(); }
  }
  schedulePoll();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && SH.db) { clearTimeout(SH.pollT); pollTick(); } });
async function pollList(first) {
  const prev = new Set(SH.shots.map(s => s.id));
  const r = await api('list');
  lastList = Date.now();
  SH.shots = r.shots || [];
  SH.listState = 'ok';
  const newest = SH.shots[0];
  if (newest && !SH.shotId && !SH.declinedAuto && !S.busy && (S.sample || !anyLocalWork()) && Date.now() - (newest.createdAt || 0) < 12 * 3600e3) { selectShot(newest.id); return; }
  if (newest && SH.shotId && newest.id !== SH.shotId && !first && !prev.has(newest.id) && newest.createdBy !== SH.uid) SH.newer = newest.id;
  renderShotBar();
}
async function pollShot() {
  const id = SH.shotId;
  if (SH.pending || SH.shotPatch || SH.dragging) return; // 自分の書き込みが済むまで待つ
  const r = await api('get', { id, since: SH.updatedAt || 0 });
  if (SH.shotId !== id || r.unchanged) return;
  if (SH.pending || SH.shotPatch) return;
  await applyShot(r.shot);
}

// ---- 射の選択 ----
function resetViews() {
  for (const v of Object.values(V)) {
    if (v.url) URL.revokeObjectURL(v.url);
    v.url = null; v.file = null; v.video.removeAttribute('src'); try { v.video.load(); } catch (e) { /* なし */ }
    Object.assign(v, { track: null, status: 'empty', w: 0, h: 0, duration: 0, sampleBg: false, flip: null, partAt: null, partShot: null, by: null, pick: null, liveK: null, thumbs: null });
  }
  Object.assign(S.target, { src: null, w: 0, h: 0, calib: null, step: 0, marks: [], rightIsMae: true, shot: 0, tmp: {}, photoId: null, partAt: null, by: null, name: '' });
  S.ph = null; S.metrics = []; S.fz = null; S.t = 0; S.offset = 0;
}
function selectShot(id) {
  if (S.busy) return;
  SH.shotId = id; SH.shot = null; SH.updatedAt = 0; SH.newer = null; SH.confirmDel = false;
  pause(); resetViews();
  if (!id) { loadSample(); renderShotBar(); renderCoach(); return; }
  S.sample = false; $('#sampleBanner').hidden = true;
  setLayout(S.layout); renderAll(); renderCoach();
  clearTimeout(SH.pollT);
  pollShot().catch(e => { SH.msg = e.message; renderShotBar(); }).finally(schedulePoll);
}
async function applyShot(shot) {
  SH.shot = shot; SH.updatedAt = shot.updatedAt;
  if (shot.createdBy && shot.createdBy.dev) SH.names[shot.createdBy.dev] = shot.createdBy.name;
  if (Number(shot.heightCm) >= 120 && Number(shot.heightCm) !== S.heightCm) { S.heightCm = Number(shot.heightCm); $('#height').value = S.heightCm; }
  const id = SH.shotId;
  let changed = false;
  for (const key of ['front', 'side']) {
    const p = shot.parts && shot.parts[key], v = V[key];
    if (!p) continue;
    if (p.dev) SH.names[p.dev] = p.by;
    if (v.partAt === p.at && v.partShot === id) { if (v.by !== p.dev) { v.by = p.dev; changed = true; } continue; }
    if (S.busy && v.status === 'analyzing') continue;
    try {
      const r = await api('getPart', { id, kind: key });
      if (SH.shotId !== id) return;
      const frames = decodeFrames(r.frames);
      const tr = K.prepareTrack({ view: key, w: p.w, h: p.h, duration: p.duration, frames: frames.map(f => ({ t: f.t, k: f.k })) });
      tr.phasesAuto = K.detectPhases(tr);
      if (v.url) { URL.revokeObjectURL(v.url); v.url = null; v.file = null; v.video.removeAttribute('src'); }
      Object.assign(v, { track: tr, status: 'done', w: p.w, h: p.h, duration: p.duration, sampleBg: false, partAt: p.at, partShot: id, by: p.dev, flip: makeFlip(p, frames, id), liveK: null });
      changed = true;
    } catch (e) { console.warn(e); SH.msg = e.message; }
  }
  const t = shot.target, tg = S.target;
  if (t && t.at !== tg.partAt && !SH.dragging) {
    if (t.dev) SH.names[t.dev] = t.by;
    if (t.photo !== tg.photoId) {
      tg.photoId = t.photo || null; tg.src = null;
      if (t.photo) blobUrl(id, t.photo).then(u => { const im = new Image(); im.onload = () => { if (tg.photoId === t.photo) { tg.src = im; renderTarget(); } }; im.src = u; }).catch(() => { /* 写真なし */ });
    }
    Object.assign(tg, { w: t.w || tg.w, h: t.h || tg.h, calib: t.calib || null, marks: (t.marks || []).map(m => ({ x: m.x, y: m.y })), rightIsMae: t.rightIsMae !== false, shot: t.shot || 0, tmp: {}, partAt: t.at, by: t.dev });
    tg.step = tg.calib ? 3 : 0;
    $('#rightMae').checked = tg.rightIsMae;
    renderTarget(); renderSlots();
  }
  if (changed) {
    recompute(true);
    if (S.fz && S.layout !== '3d') setLayout('3d');
    if (S.ph && S.t === 0) setTime((S.ph.bounds[5] + S.ph.tHanare) / 2);
  } else if (V.front.track || V.side.track) recompute(false);
  renderShotBar(); renderCoach();
}

// ---- 書き込み ----
function writeError(e) {
  const code = e && e.code;
  if (code === 'forbidden') { SH.writeBlocked = true; SH.msg = e.message || '登録の合言葉が必要です。'; }
  else if (code === 'bad_key') { logout(); SH.msg = '合言葉が変わりました。入れ直してください。'; }
  else SH.msg = (e && e.message) || '共有に失敗しました。通信を確認して、もう一度お試しください。';
  renderShotBar();
}
const canShare = () => !!(SH.db && SH.shotId && !SH.writeBlocked && SH.canWrite);
async function track(p) { SH.pending++; try { return await p; } finally { SH.pending--; } }
async function createShot() {
  if (!SH.db || SH.writeBlocked || !SH.canWrite) return false;
  try {
    const r = await track(api('create', { name: SH.name, dev: SH.uid, heightCm: S.heightCm }));
    SH.shots.unshift({ id: r.shot.id, title: r.shot.title, memo: '', createdAt: r.shot.createdAt, createdBy: SH.uid, parts: [] });
    SH.declinedAuto = false; selectShot(r.shot.id);
    return true;
  } catch (e) { writeError(e); return false; }
}
// 射の設定（区切り・時刻合わせ・身長・メモ）はまとめて書く
function shareShot(patch) {
  if (!canShare()) return;
  SH.shotPatch = Object.assign(SH.shotPatch || {}, patch);
  clearTimeout(SH.shotTimer);
  const id = SH.shotId;
  SH.shotTimer = setTimeout(() => {
    const body = SH.shotPatch; SH.shotPatch = null;
    SH.shotChain = SH.shotChain.then(() => track(api('updateShot', { id, patch: body }))).catch(writeError);
  }, 600);
}
async function uploadBlob(shotId, blob, name) {
  const b64 = await blobToB64(blob);
  const r = await api('putBlob', { id: shotId, b64, mime: blob.type === 'image/png' ? 'image/png' : 'image/jpeg', name });
  SH.blobs[shotId + '/' + r.fileId] = Promise.resolve(URL.createObjectURL(blob));
  return r.fileId;
}
async function sharePart(key, v, frames, thumbs, tH) {
  if (!canShare()) return;
  const shotId = SH.shotId;
  SH.pending++;
  try {
    SH.msg = `${v.label}の結果を共有しています…`; renderShotBar();
    let sheets = [];
    if (thumbs) {
      try {
        const blobs = (await thumbs.finish()).filter(Boolean);
        for (let i = 0; i < blobs.length; i++) { SH.msg = `${v.label}のコマ画像を送っています（${i + 1}/${blobs.length}）…`; renderShotBar(); sheets.push(await uploadBlob(shotId, blobs[i], `${key}-sheet${i}`)); }
      } catch (e) { console.warn(e); sheets = []; }
    }
    let fr = frames.map((f, i) => ({ t: f.t, k: f.k, i }));
    let ef = encodeFrames(fr);
    while (ef.k.length > 1200000 && fr.length > 20) { fr = fr.filter((f, j) => j % 2 === 0 || (Number.isFinite(tH) && Math.abs(f.t - tH) < 0.7)); ef = encodeFrames(fr); }
    if (SH.shotId !== shotId) return;
    const r = await api('putPart', { id: shotId, kind: key, name: SH.name, dev: SH.uid, frames: { t: ef.t, k: ef.k, ti: ef.ti }, meta: { w: v.w, h: v.h, duration: v.duration, n: ef.n, sheets, tile: sheets.length ? { w: thumbs.tw, h: thumbs.th, cols: thumbs.cols, per: thumbs.per } : null } });
    v.partAt = r.at; v.partShot = shotId; v.by = SH.uid; SH.names[SH.uid] = SH.name;
    SH.msg = '';
  } catch (e) { writeError(e); }
  finally { SH.pending--; }
  renderShotBar(); renderSlots();
}
async function sharePhoto(file) {
  if (!canShare()) return;
  const shotId = SH.shotId, tg = S.target;
  SH.pending++;
  try {
    SH.msg = '矢所の写真を共有しています…'; renderShotBar();
    let photo = null;
    if (tg.src) {
      try {
        const s = Math.min(1, 1600 / Math.max(tg.w, tg.h));
        const c = document.createElement('canvas'); c.width = Math.round(tg.w * s); c.height = Math.round(tg.h * s);
        c.getContext('2d').drawImage(tg.src, 0, 0, c.width, c.height);
        const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
        photo = await uploadBlob(shotId, blob, 'target');
        // 共有する写真の大きさに合わせる（印の座標の基準）。アップロード中に付けた印も縮める
        const sc = (q) => (q ? Object.fromEntries(Object.entries(q).map(([k2, v2]) => [k2, typeof v2 === 'number' ? v2 * s : v2])) : q);
        tg.src = c; tg.w = c.width; tg.h = c.height; tg.calib = sc(tg.calib); tg.tmp = sc(tg.tmp) || {}; tg.marks = tg.marks.map(m => ({ x: m.x * s, y: m.y * s }));
      } catch (e) { console.warn(e); }
    }
    void file;
    if (SH.shotId !== shotId) return;
    tg.photoId = photo; tg.by = SH.uid;
    const r = await api('updateShot', { id: shotId, patch: { target: { name: SH.name, dev: SH.uid, photo, w: tg.w, h: tg.h, calib: tg.calib || null, marks: tg.marks.map(m => ({ x: m.x, y: m.y })), rightIsMae: tg.rightIsMae, shot: tg.shot || 0 } } });
    tg.partAt = r.target && r.target.at;
    SH.msg = photo ? '' : '写真は共有できませんでしたが、印は共有されます。';
  } catch (e) { writeError(e); }
  finally { SH.pending--; }
  renderTarget(); renderShotBar(); renderSlots();
}
function shareTarget() {
  if (!canShare() || !(SH.shot && SH.shot.target) && !S.target.photoId) return;
  clearTimeout(SH.targetTimer);
  const id = SH.shotId;
  SH.pending++;
  SH.targetTimer = setTimeout(async () => {
    const tg = S.target;
    try {
      const r = await api('updateShot', { id, patch: { target: { calib: tg.calib, marks: tg.marks.map(m => ({ x: Math.round(m.x * 10) / 10, y: Math.round(m.y * 10) / 10 })), rightIsMae: tg.rightIsMae, shot: tg.shot } } });
      if (r.target) tg.partAt = r.target.at;
    } catch (e) { writeError(e); }
    finally { SH.pending--; }
  }, 500);
}
async function deleteShot() {
  const id = SH.shotId; if (!id) return;
  try { await track(api('deleteShot', { id })); } catch (e) { writeError(e); return; }
  SH.shots = SH.shots.filter(s => s.id !== id);
  SH.declinedAuto = true; selectShot(null);
}
async function makeCoach() {
  if (!SH.shotId || SH.coachBusy) return;
  SH.coachBusy = true; renderCoach();
  try {
    const r = await track(api('coach', { id: SH.shotId, text: summaryText(), name: SH.name }));
    if (SH.shot) SH.shot = { ...SH.shot, coach: r.coach };
    SH.aiLeft = r.aiLeft;
  } catch (e) { $('#coachMsg').textContent = e.message || '講評を作れませんでした。'; }
  SH.coachBusy = false; renderCoach();
}
function refreshNames() { /* 名前は記録に入っている */ }
function whoText(id) {
  if (!id) return '共有済み';
  if (id === SH.uid) return 'あなたが登録';
  return (SH.names[id] || 'ほかの人') + 'が登録';
}
function fmtShot(s) { return (s.title || '射') + (s.memo ? `（${s.memo}）` : ''); }
const ROLE_NAME = { view: '閲覧のみ', edit: '登録できます', admin: '管理者' };
function renderShotBar() {
  const bar = $('#shotbar');
  if (!API_URL) {
    bar.hidden = false;
    $('#loginBox').hidden = true; $('#shotMain').hidden = true;
    $('#shotNote').textContent = 'サーバーがまだ設定されていません（config.js）。解析は使えますが、記録は共有されません。';
    return;
  }
  bar.hidden = false;
  const inn = !!SH.db;
  $('#loginBox').hidden = inn; $('#shotMain').hidden = !inn;
  if (!inn) {
    const nm = $('#loginName'); if (document.activeElement !== nm && !nm.value) nm.value = SH.name;
    $('#shotNote').textContent = SH.msg || '部の合言葉を入れると、記録を見たり登録したりできます。合言葉は、この端末に覚えておきます。';
    $('#whoami').textContent = '';
    return;
  }
  $('#whoami').textContent = `${SH.club ? SH.club + '・' : ''}${SH.name || '名無し'}（${ROLE_NAME[SH.role] || ''}）`;
  const sel = $('#shotSel');
  const opts = [['', 'サンプル（合成データ）']].concat(SH.shots.map(s => [s.id, fmtShot(s)]));
  if (SH.shotId && !SH.shots.some(s => s.id === SH.shotId) && SH.shot) opts.splice(1, 0, [SH.shotId, fmtShot(SH.shot)]);
  sel.textContent = '';
  for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
  sel.value = SH.shotId || '';
  sel.disabled = S.busy;
  const ro = SH.writeBlocked || !SH.canWrite;
  $('#newShot').hidden = ro;
  const memo = $('#shotMemo');
  memo.hidden = !SH.shotId;
  memo.disabled = ro || !SH.shotId;
  if (document.activeElement !== memo) memo.value = (SH.shot && SH.shot.memo) || '';
  $('#delShot').hidden = !(SH.shotId && SH.canEdit) || SH.confirmDel;
  $('#delConfirm').hidden = !SH.confirmDel;
  const notes = [];
  if (SH.listState === 'loading') notes.push('記録を読み込んでいます…');
  if (SH.msg) notes.push(SH.msg);
  if (ro && !SH.msg) notes.push('閲覧のみの合言葉です。ここで解析した結果は共有されません。');
  if (!SH.shotId && !ro) notes.push('動画か写真を選ぶと新しい射の記録ができ、合言葉を知っている人に届きます。');
  if (SH.shotId && !ro && SH.shot) {
    const filled = ['front', 'side'].filter(k => SH.shot.parts && SH.shot.parts[k]).length + (SH.shot.target ? 1 : 0);
    notes.push(filled < 3 ? '正面・馬手側・矢所を、撮った人がそれぞれの端末から登録できます。' : '3つとも登録されました。');
  }
  $('#shotNote').textContent = notes.join(' ');
  const nw = $('#shotNewer');
  const ns = SH.newer && SH.shots.find(s => s.id === SH.newer);
  nw.hidden = !ns;
  if (ns) $('#shotNewerText').textContent = `新しい射「${fmtShot(ns)}」が作られました。`;
}
function renderCoach() {
  const box = $('#coachBox'); if (!box) return;
  const c = SH.shot && SH.shot.coach;
  const canMake = !!(SH.db && SH.ai && SH.canWrite && SH.shotId && S.metrics.length);
  box.hidden = !(c || canMake);
  if (box.hidden) return;
  $('#coachText').textContent = c ? c.text : '';
  $('#coachText').hidden = !c;
  const d = c ? new Date(c.at) : null;
  $('#coachMeta').textContent = c ? `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}・${c.by || ''}が作成。自動の計測をもとにした参考の意見です。` : '計測の結果をもとに、AIが講評の文章を作ります。';
  const b = $('#coachBtn');
  b.hidden = !canMake;
  b.disabled = SH.coachBusy || SH.aiLeft <= 0;
  b.textContent = SH.coachBusy ? '講評を作っています…' : (c ? '講評を作り直す' : 'AIの講評を作る');
  if (!SH.coachBusy) $('#coachMsg').textContent = canMake ? `今日あと ${SH.aiLeft} 回` : '';
}
$('#shotSel').addEventListener('change', (e) => { const id = e.target.value || null; if (!id) SH.declinedAuto = true; SH.msg = ''; selectShot(id); });
$('#newShot').addEventListener('click', async () => { if (S.busy) return; SH.msg = ''; await createShot(); });
$('#shotMemo').addEventListener('change', (e) => { const m = e.target.value.slice(0, 60); if (SH.shot) { SH.shot = { ...SH.shot, memo: m }; shareShot({ memo: m }); } });
$('#delShot').addEventListener('click', () => { SH.confirmDel = true; renderShotBar(); });
$('#delNo').addEventListener('click', () => { SH.confirmDel = false; renderShotBar(); });
$('#delYes').addEventListener('click', () => { SH.confirmDel = false; deleteShot(); });
$('#shotGo').addEventListener('click', () => { if (SH.newer) selectShot(SH.newer); });
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const k = $('#loginKey').value.trim(), n = $('#loginName').value.trim().slice(0, 20);
  if (!k) { SH.msg = '合言葉を入れてください。'; renderShotBar(); return; }
  if (!n) { SH.msg = '名前を入れてください（誰が登録したかの表示に使います）。'; renderShotBar(); return; }
  $('#loginKey').value = '';
  SH.declinedAuto = false;
  login(k, n, false);
});
$('#logout').addEventListener('click', logout);
$('#coachBtn').addEventListener('click', makeCoach);

// ---------- 設定 ----------
const hIn = $('#height'); hIn.value = S.heightCm;
hIn.addEventListener('change', () => { const v = Number(hIn.value); if (v >= 120 && v <= 210) { S.heightCm = v; store.set('height', v); shareShot({ heightCm: v }); recompute(false); } else hIn.value = S.heightCm; });
const mSel = $('#modelSel'); mSel.value = S.model; mSel.addEventListener('change', () => { S.model = mSel.value; store.set('model', S.model); });
const fSel = $('#fpsSel'); fSel.value = String(S.fps); fSel.addEventListener('change', () => { S.fps = Number(fSel.value); store.set('fps', S.fps); });

$('#in-front').addEventListener('change', (e) => { onVideoFile('front', e.target.files[0]); e.target.value = ''; });
$('#in-side').addEventListener('change', (e) => { onVideoFile('side', e.target.files[0]); e.target.value = ''; });
$('#in-photo').addEventListener('change', (e) => { onPhotoFile(e.target.files[0]); e.target.value = ''; });

// ---------- まとめて描き直す ----------
function renderAll() {
  $('#sampleBanner').hidden = !S.sample;
  renderCoach();
  for (const v of Object.values(V)) {
    const hasVid = !S.sample && v.url && v.status !== 'error';
    v.video.hidden = !hasVid;
  }
  if (V.side.track) { try { S.sideFacing = sideFacingSign(); } catch (e) { S.sideFacing = 1; } }
  renderShotBar(); layoutFrames(); renderSlots(); renderPaneMsgs(); renderPhaseRow(); renderAdjust(); renderMetrics(); renderTarget();
  drawAll(); drawTimeline(); drawChart();
}
function sideFacingSign() {
  const tr = V.side.track, tTop = S.ph ? viewTime('side', S.ph.tTop) : tr.grid.gt[Math.floor(tr.grid.G / 2)];
  const g = K.gIndex(tr, tTop), k = K.kpAtGrid(tr, g);
  const d = (k[9].x + k[10].x) / 2 - (k[5].x + k[6].x) / 2;
  return d >= 0 ? 1 : -1;
}
let rsT = 0;
window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { layoutFrames(); drawAll(); drawTimeline(); drawChart(); drawPhoto(); }, 120); });

loadSample();
initShared();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawAll(); drawTimeline(); drawChart(); });
})();
