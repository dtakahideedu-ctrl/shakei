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
let uiMode = 'shakei';

// ---------- 状態 ----------
const S = {
  sample: true, layout: '3d', t: 0, playing: false, rate: 0.5,
  layers: { skel: true, arrow: true, cross: true, trail: false },
  master: 'front', offset: 0, offsetAuto: 0, offsetManual: false, align: null, syncMethod: '', ph: null, metrics: [],
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
const redrawTheme = () => { readColors(); drawAll(); drawTimeline(); drawChart(); renderTarget(); drawTeAll(); };
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
  S.sample = true; syncBanner();
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
  syncBanner();
  S.ph = null; S.metrics = []; S.t = 0; S.offsetManual = false; S.align = null;
}

// ---------- 解析結果のまとめ ----------
function recompute(resetPhases) {
  const F = V.front.track, D = V.side.track;
  S.master = F ? 'front' : (D ? 'side' : (V.front.status !== 'empty' ? 'front' : (V.side.status !== 'empty' ? 'side' : 'front')));
  if (F && D) {
    const sy = computeSync(F, D);
    S.offsetAuto = sy.offset; S.syncMethod = sy.method;
    if (resetPhases || !S.offsetManual) S.offset = sy.offset;
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
  // 1 本だけ（または 2 本を組み合わせられない時）は、その動画から奥行きを推して立体にする
  if (!S.fz && S.ph && M) { S.fz = K.fuseSingle(M, S.master, S.ph, S.heightCm); if (S.fz && F && D) S.fz.fallback = true; }
  try {
    S.metrics = K.computeMetrics({ front: F, side: D, ph: S.ph, offset: S.offset, heightCm: S.heightCm, master: S.master });
  } catch (e) { console.error(e); S.metrics = []; }
  renderAll();
}
const clonePh = (p) => ({ ...p, bounds: p.bounds.slice() });
// 2 本のずれ: 両方の音があれば音（弦音など）で、なければ体の動きで
let syncCache = null;
function computeSync(F, D) {
  const motion = K.syncOffset(F, D), a = V.front.audio, b = V.side.audio;
  let au = null;
  if (a && b) {
    if (syncCache && syncCache.a === a && syncCache.b === b) au = syncCache.res;
    else { try { au = K.audioSync(a, b); } catch (e) { au = null; } syncCache = { a, b, res: au }; }
  }
  return K.chooseSync(motion, au) || motion;
}

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
  $$('#viewer .viewbar .seg button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.layout === l)));
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

// サンプル用の人形（道着と袴）。撮影した動画の代わりに、骨格の点から描く
function paintMannequin(g, k, view, s) {
  const P = (p, dx = 0, dy = 0) => [(p.x + dx) * s, (p.y + dy) * s];
  const cap = (a, b, w, col) => { g.strokeStyle = col; g.lineWidth = w * s; g.lineCap = 'round'; g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke(); };
  const poly = (pts, col) => { g.fillStyle = col; g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath(); g.fill(); };
  const ell = (c, rx, ry, col, a0 = 0, a1 = Math.PI * 2) => { g.fillStyle = col; g.beginPath(); g.ellipse(c.x * s, c.y * s, rx * s, ry * s, 0, a0, a1); g.fill(); };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const SKIN = '#e2ba96', WHITE = '#eeeee8', SLEEVE = '#e4e4de', BLACK = '#1c1c22', HAIR = '#141210', GLOVE = '#966e46';
  const ls = k[5], rs = k[6], lh = k[11], rh = k[12], la = k[15], ra = k[16];
  const wide = view === 'front' ? 12 : 28, foot = view === 'front' ? 28 : 40;
  poly([P(lh, wide, -8), P(rh, -wide, -8), P(ra, -foot, 12), P(la, foot, 12)], BLACK); // 袴
  cap(k[13], la, 32, BLACK); cap(k[14], ra, 32, BLACK); cap(lh, k[13], 40, BLACK); cap(rh, k[14], 40, BLACK);
  if (view === 'front') poly([P(ls, 8, -8), P(rs, -8, -8), P(rh, -4, 0), P(lh, 4, 0)], WHITE);
  else { const cx = (ls.x + rs.x) / 2, hx = (lh.x + rh.x) / 2; poly([[(cx + 40) * s, (ls.y - 8) * s], [(cx - 40) * s, (rs.y - 8) * s], [(hx - 36) * s, rh.y * s], [(hx + 36) * s, lh.y * s]], WHITE); }
  ell({ x: la.x, y: la.y + 4 }, 18, 11, WHITE); ell({ x: ra.x, y: ra.y + 4 }, 18, 11, WHITE); // 足袋
  cap(ls, k[7], 26, WHITE); cap(k[7], k[9], 22, SLEEVE); cap(rs, k[8], 26, WHITE); cap(k[8], k[10], 22, SLEEVE);
  ell(k[9], 14, 14, SKIN); ell(k[10], 14, 14, GLOVE);
  const nk = mid(ls, rs), hc = { x: (k[3].x + k[4].x) / 2, y: (k[3].y + k[4].y) / 2 - 8 };
  cap(nk, { x: hc.x, y: hc.y + 20 }, 24, SKIN);
  ell(hc, 34, 40, SKIN); ell({ x: hc.x, y: hc.y - 4 }, 36, 38, HAIR, Math.PI, Math.PI * 2);
  ell(k[1], 4, 4, '#1e1e1e'); ell(k[2], 4, 4, '#1e1e1e'); ell(k[0], 4, 4, '#be8c6e');
}
// サンプルの「撮影場所」: 道場の壁と床
function drawStageBg(ctx, W, H, sc, noLabel) {
  const floorY = 1112 * sc;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#a39a86'); g.addColorStop(floorY / H, '#8f8672'); g.addColorStop(Math.min(1, floorY / H + 0.001), '#7a5c3c'); g.addColorStop(1, '#5e462d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(40,25,10,.18)'; ctx.lineWidth = 1;
  for (let y = floorY + 14 * sc; y < H; y += 26 * sc) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  if (noLabel) return;
  ctx.fillStyle = 'rgba(255,255,255,.38)'; ctx.font = `${Math.round(11 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textAlign = 'right'; ctx.fillText('合成サンプル', W - 8 * dpr, H - 8 * dpr); ctx.textAlign = 'left';
}

function drawView(v) {
  const c = v.canvas; const ctx = c.getContext('2d'); const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!v.w || v.pane.hidden) { v.hudPhase.textContent = ''; v.hudVal.textContent = ''; return; }
  const sc = W / v.w;
  if (v.sampleBg) { drawStageBg(ctx, W, H, sc); const km = v.track && K.kpAt(v.track, viewTime(v.key, S.t)); if (km) paintMannequin(ctx, km, v.key, sc); }
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

// 撮影した動画を、撮った向きの面に半透明で貼る。正面の動画は体の正面の面（z=0）、馬手側の動画は横の面（x=0）
const VID = { on: store.get('vidOn') !== '0', alpha: clamp(Number(store.get('vidAlpha')) || 0.55, 0.1, 1) };
const sampleCv = {};
function frameSource(v) {
  if (!v.track || !v.w || !v.h) return null;
  const tv = viewTime(v.key, S.t);
  if (v.sampleBg) {
    let c = sampleCv[v.key];
    if (!c) { c = sampleCv[v.key] = document.createElement('canvas'); c.width = Math.round(v.w / 2); c.height = Math.round(v.h / 2); }
    const g = c.getContext('2d'), s = c.width / v.w;
    drawStageBg(g, c.width, c.height, s, true);
    const k = K.kpAt(v.track, tv); if (k) paintMannequin(g, k, v.key, s);
    return { img: c, ox: 0, oy: 0, sx: s, sy: s };
  }
  const vid = v.video;
  if (v.url && vid.readyState >= 2 && vid.videoWidth) return { img: vid, ox: 0, oy: 0, sx: vid.videoWidth / v.w, sy: vid.videoHeight / v.h };
  const f = v.flip;
  if (f && f.order.length) {
    const o = f.order; let lo = 0, hi = o.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (o[m].t <= tv) lo = m; else hi = m; }
    const pick = Math.abs(o[hi].t - tv) < Math.abs(o[lo].t - tv) ? o[hi] : o[lo];
    const tl = f.tile, im = f.imgs[Math.floor(pick.i / tl.per)], idx = pick.i % tl.per;
    if (!im || !im.complete || !im.naturalWidth) return null;
    return { img: im, ox: (idx % tl.cols) * tl.w, oy: Math.floor(idx / tl.cols) * tl.h, sx: tl.w / v.w, sy: tl.h / v.h };
  }
  return null;
}
// 画像の三角形を、画面の三角形へ写す（遠近は細かく分けた三角形で近似）
function texTri(ctx, img, a, b, c, iw, ih) {
  const den = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
  if (Math.abs(den) < 1e-9) return;
  const m11 = ((b.x - a.x) * (c.v - a.v) - (c.x - a.x) * (b.v - a.v)) / den;
  const m12 = ((b.y - a.y) * (c.v - a.v) - (c.y - a.y) * (b.v - a.v)) / den;
  const m21 = ((c.x - a.x) * (b.u - a.u) - (b.x - a.x) * (c.u - a.u)) / den;
  const m22 = ((c.y - a.y) * (b.u - a.u) - (b.y - a.y) * (c.u - a.u)) / den;
  const e = a.x - m11 * a.u - m21 * a.v, f = a.y - m12 * a.u - m22 * a.v;
  const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
  const grow = (p) => { const dx = p.x - cx, dy = p.y - cy, L = Math.hypot(dx, dy) || 1; return [p.x + dx / L * 0.9, p.y + dy / L * 0.9]; };
  ctx.save();
  ctx.beginPath(); ctx.moveTo(...grow(a)); ctx.lineTo(...grow(b)); ctx.lineTo(...grow(c)); ctx.closePath(); ctx.clip();
  ctx.setTransform(m11, m12, m21, m22, e, f);
  const u0 = clamp(Math.floor(Math.min(a.u, b.u, c.u)) - 1, 0, iw - 1), v0 = clamp(Math.floor(Math.min(a.v, b.v, c.v)) - 1, 0, ih - 1);
  const u1 = clamp(Math.ceil(Math.max(a.u, b.u, c.u)) + 1, u0 + 1, iw), v1 = clamp(Math.ceil(Math.max(a.v, b.v, c.v)) + 1, v0 + 1, ih);
  try { ctx.drawImage(img, u0, v0, u1 - u0, v1 - v0, u0, v0, u1 - u0, v1 - v0); } catch (err) { /* 読み込み途中のコマ */ }
  ctx.restore();
}
function drawVideoPlanes(ctx, pr, dir) {
  const fz = S.fz, planes = [];
  let any = false;
  for (const key of ['front', 'side']) {
    const v = V[key], src = frameSource(v);
    if (!src) continue;
    any = true;
    const facing = Math.abs(dir(key === 'front' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }).d);
    const a = VID.alpha * Math.pow(clamp((facing - 0.12) / 0.88, 0, 1), 1.2);
    if (a < 0.02) continue;
    const toW = key === 'front'
      ? (px, py) => ({ x: (px - fz.oF.x) * fz.cppF * fz.sT, y: (fz.oF.y - py) * fz.cppF, z: 0 })
      : (px, py) => ({ x: 0, y: (fz.oS.y - py) * fz.cppS, z: (px - fz.oS.x) * fz.cppS * fz.sF });
    planes.push({ v, src, a, facing, toW });
  }
  planes.sort((p, q) => p.facing - q.facing);
  for (const { v, src, a, toW } of planes) {
    const N = 5, iw = src.img.videoWidth || src.img.naturalWidth || src.img.width, ih = src.img.videoHeight || src.img.naturalHeight || src.img.height;
    const pts = [];
    for (let j = 0; j <= N; j++) {
      const row = [];
      for (let i = 0; i <= N; i++) { const px = v.w * i / N, py = v.h * j / N, P = pr(toW(px, py)); row.push({ x: P.x, y: P.y, u: src.ox + px * src.sx, v: src.oy + py * src.sy }); }
      pts.push(row);
    }
    ctx.save(); ctx.globalAlpha = a;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      texTri(ctx, src.img, pts[j][i], pts[j][i + 1], pts[j + 1][i + 1], iw, ih);
      texTri(ctx, src.img, pts[j][i], pts[j + 1][i + 1], pts[j + 1][i], iw, ih);
    }
    ctx.restore();
  }
  return { any, shown: planes.length };
}
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
  const vinfo = S.fz && VID.on ? drawVideoPlanes(ctx, pr, dir) : null;
  // 床（射場の板）と 20cm の目盛り
  const fq = [[-110, -90], [130, -90], [130, 90], [-110, 90]].map(([x, z]) => pr({ x, y: 0, z }));
  ctx.fillStyle = below ? 'rgba(255,255,255,.02)' : 'rgba(255,236,205,.045)';
  ctx.beginPath(); fq.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  const gl = (a, b) => { const A = pr(a), B = pr(b); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); };
  for (let x = -110; x <= 130; x += 20) gl({ x, y: 0, z: -90 }, { x, y: 0, z: 90 });
  for (let z = -90; z <= 90; z += 20) gl({ x: -110, y: 0, z }, { x: 130, y: 0, z });
  drawGizmo(ctx, dir, W, H, font);
  if (vinfo && vinfo.any && !vinfo.shown) {
    ctx.font = `${Math.round(11.5 * dpr)}px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillText('動画は 斜め・正面・馬手側 から見ると重なります', W / 2, H - 12 * dpr); ctx.textAlign = 'left';
  }
  if (!S.fz) {
    $('#topNote').hidden = true;
    TOP.msg.hidden = false;
    TOP.msg.textContent = V.front.track || V.side.track ? '立体に組み立てられませんでした。動画に足踏みから残心まで全身が写っているか確かめてください。' : '正面か馬手側の動画を解析すると、立体で見られます。2本そろうと、2方向を合わせてより正確になります。';
    TOP.hudPhase.textContent = ''; TOP.hudVal.textContent = '';
    return;
  }
  TOP.msg.hidden = true;
  const p3 = K.pose3dAt(S.fz, S.t);
  // 1 本の動画から推した立体であることを、図の下に書く
  {
    const note = $('#topNote'), f = S.fz.single;
    note.hidden = !f;
    if (f) {
      const nm = f === 'front' ? '正面' : '馬手側', miss = f === 'front' ? '前後' : '的の方向';
      note.textContent = S.fz.fallback ? `2本の動画を組み合わせられなかったので、${nm}の動画だけから推定しています。「区切りと時刻合わせを直す」で時刻を合わせると、2方向で組み立てます。`
        : `${nm}の動画だけから推定した立体です。${miss}の位置は、体の寸法と射法の形から推しています。もう1方向の動画があると正確になります。`;
    }
  }
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
    if (pi === 5 && !S.fz.single) {
      const ref = Math.atan2(la.z - ra.z, la.x - ra.x), a = (Math.atan2(d.z, d.x) - ref) * 180 / Math.PI;
      hud = `矢先 ${a >= 0 ? '前' : '後ろ'}へ ${Math.abs(a).toFixed(1)}°`;
    }
  }
  ctx.lineCap = 'round';
  prims.sort((a, b) => a.d - b.d).forEach(p => p.f());
  ctx.globalAlpha = 1; ctx.setLineDash([]);
  if (!hud && pi >= 1) {
    const ref = Math.atan2(la.z - ra.z, la.x - ra.x), a = (Math.atan2(p3[5].z - p3[6].z, p3[5].x - p3[6].x) - ref) * 180 / Math.PI;
    if (Number.isFinite(a) && !S.fz.single) hud = `肩 ${a >= 0 ? '弓手側' : '馬手側'}が前へ ${Math.abs(a).toFixed(1)}°`;
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
{
  const on = $('#vidOn'), al = $('#vidAlpha');
  on.checked = VID.on; al.value = Math.round(VID.alpha * 100); al.disabled = !VID.on;
  on.addEventListener('change', () => { VID.on = on.checked; al.disabled = !VID.on; store.set('vidOn', VID.on ? '1' : '0'); drawTop(); });
  al.addEventListener('input', () => { VID.alpha = clamp(Number(al.value) / 100, 0.1, 1); store.set('vidAlpha', String(VID.alpha)); drawTop(); });
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
$$('#viewer .rate button').forEach(b => b.addEventListener('click', () => {
  S.rate = Number(b.dataset.rate);
  $$('#viewer .rate button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  for (const v of Object.values(V)) if (videoActive(v)) v.video.playbackRate = S.rate;
}));
$$('#viewer .viewbar .seg button').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));
$$('#viewer .tog').forEach(b => {
  b.setAttribute('aria-pressed', String(!!S.layers[b.dataset.layer]));
  b.addEventListener('click', () => { const k = b.dataset.layer; S.layers[k] = !S.layers[k]; b.setAttribute('aria-pressed', String(S.layers[k])); drawAll(); });
});
for (const v of Object.values(V)) {
  v.video.addEventListener('seeked', () => { if (!S.busy) { drawView(v); if (!TOP.pane.hidden) drawTop(); } });
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
    const manual = S.offsetManual || (SH.shot && Number.isFinite(SH.shot.offset));
    row.innerHTML = `<span class="lbl">馬手側の時刻のずれ <small style="color:var(--muted)">（${manual ? '手で直した値' : '自動: ' + S.syncMethod}）</small></span><span class="tv">${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)}秒</span><button type="button" data-o="-0.033">−1コマ</button><button type="button" data-o="0.033">＋1コマ</button><button type="button" data-auto>自動</button><button type="button" class="wide-btn" data-align>離れの瞬間で合わせる（2画面で確かめながら）</button>`;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.hasAttribute('data-align')) { startAlign(); return; }
      const auto = btn.hasAttribute('data-auto');
      S.offset = auto ? S.offsetAuto : S.offset + Number(btn.dataset.o);
      S.offsetManual = !auto;
      shareShot({ offset: auto ? null : S.offset });
      if (SH.shot) SH.shot = { ...SH.shot, offset: auto ? null : S.offset };
      recompute(false); setTime(S.t);
    });
    L.appendChild(row);
  }
}
// ---- 離れの瞬間で 2 本をそろえる（正面 → 馬手側の順に、離れのコマを示す） ----
function startAlign() {
  if (!(V.front.track && V.side.track) || S.busy) return;
  pause();
  S.align = { step: 1, layout: S.layout, offset: S.offset };
  setLayout('front');
  const ph = V.front.track.phasesAuto || S.ph;
  if (ph) setTime(ph.tHanare);
  renderAlign();
  $('#viewer').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function renderAlign() {
  const bar = $('#alignBar'), a = S.align;
  bar.hidden = !a; if (!a) return;
  if (a.step === 1) {
    $('#alignMsg').innerHTML = '<b>1/2 正面</b>　動画を離れの瞬間（弦から矢が離れたコマ）に合わせて「ここが離れ」を押してください。下の ◀ ▶ で1コマずつ動かせます。';
    $('#alignBtns').innerHTML = '<button type="button" class="btn small" data-a="here">ここが離れ</button><button type="button" class="btn small ghost" data-a="cancel">やめる</button>';
  } else {
    $('#alignMsg').innerHTML = '<b>2/2 馬手側</b>　馬手側の動画も離れの瞬間に合わせて「これで合わせる」を押してください。下のボタンでは馬手側だけが動きます。';
    $('#alignBtns').innerHTML = '<button type="button" data-a="s" data-d="-0.5">◀◀ 0.5秒</button><button type="button" data-a="s" data-d="-1f">◀ 1コマ</button><button type="button" data-a="s" data-d="1f">1コマ ▶</button><button type="button" data-a="s" data-d="0.5">0.5秒 ▶▶</button><button type="button" class="btn small" data-a="ok">これで合わせる</button><button type="button" class="btn small ghost" data-a="cancel">やめる</button>';
  }
}
$('#alignBtns').addEventListener('click', (e) => {
  const b = e.target.closest('button'); const a = S.align; if (!b || !a) return;
  const act = b.dataset.a;
  if (act === 'cancel') { S.offset = a.offset; S.align = null; setLayout(a.layout); recompute(false); setTime(S.t); renderAlign(); return; }
  if (act === 'here') {
    pause(); a.tf = S.t; a.step = 2;
    // 馬手側は、自動で見つけた離れのコマから始める
    const ps = V.side.track.phasesAuto; if (ps) S.offset = a.tf - ps.tHanare;
    setLayout('side'); setTime(a.tf); renderAlign(); return;
  }
  if (act === 's') {
    const d = b.dataset.d.endsWith('f') ? Number(b.dataset.d.slice(0, -1)) / 30 : Number(b.dataset.d); S.offset -= d;
    V.side.cap.textContent = `時刻のずれ ${S.offset >= 0 ? '+' : ''}${S.offset.toFixed(2)} 秒`;
    setTime(S.t); return;
  }
  if (act === 'ok') {
    S.offsetManual = true; shareShot({ offset: S.offset }); if (SH.shot) SH.shot = { ...SH.shot, offset: S.offset };
    const t = a.tf; S.align = null; setLayout(a.layout === 'side' || a.layout === 'front' ? 'both' : a.layout);
    recompute(false); setTime(t); renderAlign();
  }
});
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
const STEP_HINT = ['的の中心（中白）をタップすると、輪を自動で合わせます。', '輪を自動で合わせられませんでした。的の右の縁（外黒の外側）をタップしてください。', '的の上の縁をタップしてください。', '矢所をタップすると印が付きます。輪がずれていたら白い丸を、印は印をドラッグして直します。'];
function renderTarget() {
  const tg = S.target;
  $$('#steps .step').forEach((s) => { const k = Number(s.dataset.step); s.setAttribute('aria-current', String(!!tg.src && (k === 3 ? tg.step === 3 : tg.step < 3))); s.classList.toggle('done', !!tg.src && k === 0 && tg.step === 3); });
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
      // 輪を直すつまみ（中心・右・上）
      if (tg.step === 3 && tg.calib) {
        for (const [hx, hy] of [[X, Y], [X + rx * s, Y], [X, Y - ry * s]]) {
          ctx.beginPath(); ctx.arc(hx, hy, 7 * dpr, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fill();
          ctx.lineWidth = 2 * dpr; ctx.strokeStyle = C['ov-guide']; ctx.stroke();
        }
      }
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
// 写真の輝度（明るさ）を、指定の範囲だけ W×H に縮めて取り出す
function lumOf(src, sx, sy, sw, sh, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, L = new Float32Array(W * H);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return L;
}
// 中心のタップから、霞的の輪の並びに合う楕円を探す。見つからなければ null
function autoFitTarget(tg, px, py) {
  try {
    const s = Math.min(1, 900 / Math.max(tg.w, tg.h)), W = Math.max(2, Math.round(tg.w * s)), H = Math.max(2, Math.round(tg.h * s));
    const r = K.fitTarget(lumOf(tg.src, 0, 0, tg.w, tg.h, W, H), W, H, px * s, py * s);
    let fit = r ? { cx: r.cx / s, cy: r.cy / s, rx: r.rx / s, ry: r.ry / s } : null;
    // 的が小さく写っている時は、まわりを切り出して細かく合わせ直す
    if (!fit || Math.max(fit.rx, fit.ry) * s < 70) {
      const half = fit ? Math.max(fit.rx, fit.ry) * 1.7 : Math.max(tg.w, tg.h) * 0.18;
      const ccx = fit ? fit.cx : px, ccy = fit ? fit.cy : py;
      const x0 = clamp(ccx - half, 0, tg.w - 2), y0 = clamp(ccy - half, 0, tg.h - 2), x1 = clamp(ccx + half, x0 + 2, tg.w), y1 = clamp(ccy + half, y0 + 2, tg.h);
      const k = Math.min(4, 600 / Math.max(x1 - x0, y1 - y0)), CW = Math.max(2, Math.round((x1 - x0) * k)), CH = Math.max(2, Math.round((y1 - y0) * k));
      const r2 = K.fitTarget(lumOf(tg.src, x0, y0, x1 - x0, y1 - y0, CW, CH), CW, CH, (ccx - x0) * k, (ccy - y0) * k);
      if (r2) fit = { cx: x0 + r2.cx / k, cy: y0 + r2.cy / k, rx: r2.rx / k, ry: r2.ry / k };
    }
    return fit;
  } catch (e) { console.warn(e); return null; }
}
let drag = null;
function photoPt(e) { const r = photo.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * S.target.w, y: (e.clientY - r.top) / r.height * S.target.h }; }
photo.addEventListener('pointerdown', (e) => {
  const tg = S.target; if (!tg.src) return;
  const p = photoPt(e);
  const tol = 20 / (photo.getBoundingClientRect().width / tg.w);
  let hit = -1, hd = tol, handle = null;
  if (tg.step === 3) tg.marks.forEach((m, i) => { const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < hd) { hd = d; hit = i; } });
  if (tg.step === 3 && tg.calib) {
    const c = tg.calib;
    for (const [k, hx, hy] of [['c', c.cx, c.cy], ['r', c.cx + c.rx, c.cy], ['t', c.cx, c.cy - c.ry]]) { const d = Math.hypot(hx - p.x, hy - p.y); if (d < hd) { hd = d; handle = k; hit = -1; } }
  }
  drag = { i: hit, handle, c0: tg.calib ? { ...tg.calib } : null, start: p, moved: false };
  SH.dragging = true;
  photo.setPointerCapture(e.pointerId);
});
photo.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = photoPt(e);
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 2) drag.moved = true;
  if (drag.handle && drag.moved) {
    const c = S.target.calib, c0 = drag.c0;
    if (drag.handle === 'c') { c.cx = c0.cx + p.x - drag.start.x; c.cy = c0.cy + p.y - drag.start.y; }
    else if (drag.handle === 'r') c.rx = Math.max(5, Math.abs(p.x - c.cx));
    else c.ry = Math.max(5, Math.abs(c.cy - p.y));
    drawPhoto(); renderSchem(); return;
  }
  if (drag.i < 0) return;
  S.target.marks[drag.i] = p; drawPhoto(); renderSchem();
});
photo.addEventListener('pointerup', (e) => {
  const tg = S.target; if (!drag) return;
  const p = photoPt(e); const d = drag; drag = null; SH.dragging = false;
  if (d.handle && d.moved) { renderTarget(); shareTarget(); return; }
  if (d.i >= 0) { if (!d.moved) { tg.shot = tg.shot === d.i + 1 ? 0 : d.i + 1; } renderTarget(); renderSlots(); shareTarget(); return; }
  if (tg.step === 0) {
    const fit = autoFitTarget(tg, p.x, p.y);
    if (fit) { tg.calib = fit; tg.tmp = {}; tg.step = 3; }
    else { tg.tmp = { cx: p.x, cy: p.y }; tg.calib = null; tg.step = 1; }
  }
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
  startAudio(v, file);
  // 動画を入れ替えたら、手で直した時刻のずれは使わない
  S.offsetManual = false; S.align = null;
  if (SH.shot && Number.isFinite(SH.shot.offset)) { SH.shot = { ...SH.shot, offset: null }; shareShot({ offset: null }); }
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
    $$('#viewer .viewbar .seg button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.layout === 'both')));
  } catch (e) {
    v.status = 'error'; v.error = 'この動画は読み込めませんでした。MP4（H.264）か MOV で試してください。';
  }
  if (!V.front.track && !V.side.track) S.master = key === 'front' || V.front.status !== 'empty' ? 'front' : 'side';
  renderAll();
}
// ---------- 音（時刻合わせ用。音の立ち上がりの強さだけを取り出す） ----------
async function extractAudio(file) {
  try {
    if (!file || file.size > 600e6) return null;
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!AC) return null;
    const buf = await file.arrayBuffer();
    const ctx = new AC(1, 1, 44100);
    const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
    if (!ab || !ab.length) return null;
    const chs = []; for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) chs.push(ab.getChannelData(c));
    const env = K.audioEnvelope(chs, ab.sampleRate, ab.duration > 120 ? 100 : 200);
    return env.env.some(x => x > 0) ? env : null; // 音のない動画は使わない
  } catch (e) { return null; }
}
function startAudio(v, file) {
  v.audio = null;
  v.audioP = extractAudio(file).then(a => {
    if (v.file === file) { v.audio = a; if (V.front.track && V.side.track && !S.busy) { recompute(false); setTime(S.t); } }
    return a;
  });
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
  S.busy = true; cancelFlag = false; syncModeBtns();
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
  S.busy = false; cancelFlag = false; syncModeBtns();
  recompute(true);
  const M = masterTrack();
  if (S.fz) { const pre = S.fz.single ? 'oblique' : 'top'; [CAM.yaw, CAM.pitch] = CAM_PRESETS[pre]; CAM.zoom = 1; setCamPressed(pre); setLayout('3d'); }
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
    im.onload = () => { drawAll(); drawTeAll(); };
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
  SH.key = ''; store.set('key', ''); SH.db = null; SH.role = null; SH.shots = []; HR.list = []; SH.listState = 'off';
  SH.declinedAuto = true; HR.declinedAuto = true; SH.msg = '';
  if (HR.id) selectHand(null);
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
    if (SH.shotId) { try { await pollShot(); } catch (e) { if (e.code !== 'not_found') throw e; SH.msg = 'この射の記録は消されました。'; selectShot(null); } }
    if (HR.id) { try { await pollHand(); } catch (e) { if (e.code !== 'not_found') throw e; SH.msg = 'この手の記録は消されました。'; selectHand(null); } }
    if (SH.fails) { SH.fails = 0; if (SH.msg.startsWith('サーバー')) SH.msg = ''; renderShotBar(); }
  } catch (e) {
    SH.fails++;
    if (e.code === 'bad_key') { logout(); SH.msg = '合言葉が変わりました。入れ直してください。'; renderShotBar(); return; }
    if (SH.fails >= 2) { SH.msg = e.message; renderShotBar(); }
  }
  schedulePoll();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && SH.db) { clearTimeout(SH.pollT); pollTick(); } });
async function pollList(first) {
  const prev = new Set(SH.shots.map(s => s.id)), prevH = new Set(HR.list.map(s => s.id));
  const r = await api('list');
  lastList = Date.now();
  const all = r.shots || [];
  SH.shots = all.filter(s => s.type !== 'hand');
  HR.list = all.filter(s => s.type === 'hand');
  SH.listState = 'ok';
  const fresh = (s) => Date.now() - (s.createdAt || 0) < 12 * 3600e3;
  const nh = HR.list[0];
  if (nh && !HR.id && !HR.declinedAuto && !S.busy && !anyTeWork() && fresh(nh)) selectHand(nh.id);
  else if (nh && HR.id && nh.id !== HR.id && !first && !prevH.has(nh.id) && nh.createdBy !== SH.uid) HR.newer = nh.id;
  const newest = SH.shots[0];
  if (newest && !SH.shotId && !SH.declinedAuto && !S.busy && (S.sample || !anyLocalWork()) && fresh(newest)) { selectShot(newest.id); return; }
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
    Object.assign(v, { track: null, status: 'empty', w: 0, h: 0, duration: 0, sampleBg: false, flip: null, partAt: null, partShot: null, by: null, pick: null, liveK: null, thumbs: null, audio: null, audioP: null });
  }
  Object.assign(S.target, { src: null, w: 0, h: 0, calib: null, step: 0, marks: [], rightIsMae: true, shot: 0, tmp: {}, photoId: null, partAt: null, by: null, name: '' });
  S.ph = null; S.metrics = []; S.fz = null; S.t = 0; S.offset = 0; S.offsetManual = false; S.align = null;
}
function selectShot(id) {
  if (S.busy) return;
  SH.shotId = id; SH.shot = null; SH.updatedAt = 0; SH.newer = null; SH.confirmDel = false;
  pause(); resetViews();
  if (!id) { loadSample(); renderShotBar(); renderCoach(); return; }
  S.sample = false; syncBanner();
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
      Object.assign(v, { track: tr, status: 'done', w: p.w, h: p.h, duration: p.duration, sampleBg: false, partAt: p.at, partShot: id, by: p.dev, flip: makeFlip(p, frames, id), liveK: null, audio: r.frames.au ? { rate: p.auRate || 200, env: bytesFromB64(r.frames.au) } : null, audioP: null });
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
    if (v.audioP) { try { await Promise.race([v.audioP, new Promise(r => setTimeout(r, 15000))]); } catch (e) { /* 音なし */ } }
    const au = v.audio && v.audio.env.length <= 30000 ? b64FromBytes(v.audio.env) : '';
    let fr = frames.map((f, i) => ({ t: f.t, k: f.k, i }));
    let ef = encodeFrames(fr);
    while (ef.k.length > 1200000 && fr.length > 20) { fr = fr.filter((f, j) => j % 2 === 0 || (Number.isFinite(tH) && Math.abs(f.t - tH) < 0.7)); ef = encodeFrames(fr); }
    if (SH.shotId !== shotId) return;
    const r = await api('putPart', { id: shotId, kind: key, name: SH.name, dev: SH.uid, frames: { t: ef.t, k: ef.k, ti: ef.ti, au }, meta: { w: v.w, h: v.h, duration: v.duration, n: ef.n, auRate: au ? v.audio.rate : null, sheets, tile: sheets.length ? { w: thumbs.tw, h: thumbs.th, cols: thumbs.cols, per: thumbs.per } : null } });
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
  syncModeBtns();
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
  const te = uiMode === 'te';
  const curId = te ? HR.id : SH.shotId, cur = te ? HR.rec : SH.shot, list = te ? HR.list : SH.shots, confirm = te ? HR.confirmDel : SH.confirmDel;
  $('#shotLbl').textContent = te ? '手の記録' : '射の記録';
  const sel = $('#shotSel');
  sel.setAttribute('aria-label', te ? '手の記録を選ぶ' : '射の記録を選ぶ');
  const opts = [['', 'サンプル（合成データ）']].concat(list.map(s => [s.id, fmtShot(s.id === curId && cur ? cur : s)]));
  if (curId && !list.some(s => s.id === curId) && cur) opts.splice(1, 0, [curId, fmtShot(cur)]);
  sel.textContent = '';
  for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
  sel.value = curId || '';
  sel.disabled = S.busy;
  const ro = SH.writeBlocked || !SH.canWrite;
  const nb = $('#newShot'); nb.hidden = ro; nb.textContent = te ? '＋ 新しい記録' : '＋ 新しい射';
  const memo = $('#shotMemo');
  memo.hidden = !curId;
  memo.disabled = ro || !curId;
  if (document.activeElement !== memo) memo.value = (cur && cur.memo) || '';
  const del = $('#delShot');
  del.hidden = !(curId && SH.canEdit) || confirm;
  del.textContent = te ? 'この手の記録を消す' : 'この射の記録を消す';
  $('#delConfirm').hidden = !confirm;
  $('#delWhat').textContent = te ? '弓手・馬手の結果と映像がすべて消えます。' : '動画の結果・写真・印がすべて消えます。';
  const notes = [];
  if (SH.listState === 'loading') notes.push('記録を読み込んでいます…');
  if (SH.msg) notes.push(SH.msg);
  if (ro && !SH.msg) notes.push('閲覧のみの合言葉です。ここで解析した結果は共有されません。');
  if (!curId && !ro) notes.push(te ? '接写の動画を選ぶと新しい手の記録ができ、合言葉を知っている人に届きます。' : '動画か写真を選ぶと新しい射の記録ができ、合言葉を知っている人に届きます。');
  if (curId && !ro && cur) {
    if (te) { const filled = TKEYS.filter(k => cur.parts && cur.parts[k]).length; notes.push(filled < 2 ? '弓手・馬手を、撮った人がそれぞれの端末から登録できます。' : '2つとも登録されました。'); }
    else { const filled = ['front', 'side'].filter(k => cur.parts && cur.parts[k]).length + (cur.target ? 1 : 0); notes.push(filled < 3 ? '正面・馬手側・矢所を、撮った人がそれぞれの端末から登録できます。' : '3つとも登録されました。'); }
  }
  $('#shotNote').textContent = notes.join(' ');
  const nw = $('#shotNewer');
  const nid = te ? HR.newer : SH.newer;
  const ns = nid && list.find(s => s.id === nid);
  nw.hidden = !ns;
  if (ns) { $('#shotNewerText').textContent = `新しい${te ? '手の記録' : '射'}「${fmtShot(ns)}」が作られました。`; $('#shotGo').textContent = te ? 'その記録へ移る' : 'その射へ移る'; }
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
$('#shotSel').addEventListener('change', (e) => {
  const id = e.target.value || null; SH.msg = '';
  if (uiMode === 'te') { if (!id) HR.declinedAuto = true; selectHand(id); }
  else { if (!id) SH.declinedAuto = true; selectShot(id); }
});
$('#newShot').addEventListener('click', async () => { if (S.busy) return; SH.msg = ''; if (uiMode === 'te') await createHand(); else await createShot(); });
$('#shotMemo').addEventListener('change', (e) => {
  const m = e.target.value.slice(0, 60);
  if (uiMode === 'te') { if (HR.rec) { HR.rec = { ...HR.rec, memo: m }; shareHand({ memo: m }); } }
  else if (SH.shot) { SH.shot = { ...SH.shot, memo: m }; shareShot({ memo: m }); }
});
$('#delShot').addEventListener('click', () => { if (uiMode === 'te') HR.confirmDel = true; else SH.confirmDel = true; renderShotBar(); });
$('#delNo').addEventListener('click', () => { HR.confirmDel = false; SH.confirmDel = false; renderShotBar(); });
$('#delYes').addEventListener('click', () => { const te = uiMode === 'te'; HR.confirmDel = false; SH.confirmDel = false; if (te) deleteHand(); else deleteShot(); });
$('#shotGo').addEventListener('click', () => { if (uiMode === 'te') { if (HR.newer) selectHand(HR.newer); } else if (SH.newer) selectShot(SH.newer); });
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

// ---- 手の内・ひねりの記録（GAS 版）。同じ表に type:'hand' の行として置く ----
const HR = { id: null, rec: null, updatedAt: 0, unsub: [], newer: null, declinedAuto: false, confirmDel: false, list: [], patch: null, timer: 0 };
const canShareTe = () => !!(SH.db && HR.id && !SH.writeBlocked && SH.canWrite);
const canCreateTe = () => !!(SH.db && !SH.writeBlocked && SH.canWrite);
async function createHand() {
  if (!canCreateTe()) return false;
  try {
    const r = await track(api('create', { type: 'hand', name: SH.name, dev: SH.uid }));
    HR.list.unshift({ id: r.shot.id, type: 'hand', title: r.shot.title, memo: '', createdAt: r.shot.createdAt, createdBy: SH.uid, parts: [] });
    HR.declinedAuto = false; selectHand(r.shot.id);
    return true;
  } catch (e) { writeError(e); return false; }
}
function selectHand(id) {
  if (S.busy) return;
  HR.id = id; HR.rec = null; HR.updatedAt = 0; HR.newer = null; HR.confirmDel = false;
  tePause(); resetTe();
  if (!id) { loadTeSample(); renderTe(); renderShotBar(); return; }
  renderTe(); renderShotBar();
  clearTimeout(SH.pollT);
  pollHand().catch(e => { SH.msg = e.message; renderShotBar(); }).finally(schedulePoll);
}
async function pollHand() {
  const id = HR.id;
  if (!id || SH.pending || HR.patch) return;
  const r = await api('get', { id, since: HR.updatedAt || 0 });
  if (HR.id !== id || r.unchanged || SH.pending || HR.patch) return;
  await applyHand(r.shot);
}
async function applyHand(rec) {
  const id = HR.id;
  const before = JSON.stringify((HR.rec && HR.rec.rel) || {});
  HR.rec = rec; HR.updatedAt = rec.updatedAt;
  if (rec.createdBy && rec.createdBy.dev) SH.names[rec.createdBy.dev] = rec.createdBy.name;
  const had = teActive().length > 0;
  let changed = false;
  for (const key of TKEYS) {
    const p = rec.parts && rec.parts[key], s = TV[key];
    if (!p) continue;
    if (p.dev) SH.names[p.dev] = p.by;
    if (s.partAt === p.at && s.partShot === id) { if (s.by !== p.dev) { s.by = p.dev; changed = true; } continue; }
    if (S.busy && s.status === 'analyzing') continue;
    try {
      const r = await api('getPart', { id, kind: key });
      if (HR.id !== id) return;
      teLoadPart(key, p, teDecode(key, r.frames), id);
      changed = true;
    } catch (e) { console.warn(e); SH.msg = e.message; }
  }
  if (changed) { recomputeTe(true); if (!had) TE.rel = -0.3; TE.rel = clamp(TE.rel, ...relRange()); renderTe(); }
  else if (JSON.stringify(rec.rel || {}) !== before && teActive().length) { recomputeTe(false); renderTe(); }
  else renderShotBar();
}
function shareHand(patch) {
  if (!canShareTe()) return;
  HR.patch = Object.assign(HR.patch || {}, patch);
  clearTimeout(HR.timer);
  const id = HR.id;
  HR.timer = setTimeout(() => {
    const body = HR.patch; HR.patch = null;
    SH.shotChain = SH.shotChain.then(() => track(api('updateShot', { id, patch: body }))).catch(writeError);
  }, 600);
}
async function shareTePart(key, s, frames, thumbs) {
  if (!canShareTe()) return;
  const hid = HR.id;
  SH.pending++;
  try {
    SH.msg = `${s.label}の結果を共有しています…`; renderShotBar();
    let sheets = s.sheets || [], tile = s.tile || null;
    if (thumbs) {
      sheets = []; tile = null;
      try {
        const blobs = (await thumbs.finish()).filter(Boolean);
        for (let i = 0; i < blobs.length; i++) { SH.msg = `${s.label}のコマ画像を送っています（${i + 1}/${blobs.length}）…`; renderShotBar(); sheets.push(await uploadBlob(hid, blobs[i], `${key}-sheet${i}`)); }
        if (sheets.length) tile = { w: thumbs.tw, h: thumbs.th, cols: thumbs.cols, per: thumbs.per };
      } catch (e) { console.warn(e); sheets = []; tile = null; }
    }
    const h = s.ph ? s.ph.tHanare : NaN;
    let fr = frames.slice(), ef = teEncode(key, fr);
    while (ef.k.length > 1200000 && fr.length > 20) { fr = fr.filter((f, j) => j % 2 === 0 || (Number.isFinite(h) && Math.abs(f.t - h) < 0.6)); ef = teEncode(key, fr); }
    if (HR.id !== hid) return;
    const r = await api('putPart', { id: hid, kind: key, name: SH.name, dev: SH.uid, frames: { t: ef.t, k: ef.k, p: ef.p, ti: ef.ti }, meta: { w: s.w, h: s.h, duration: s.duration, n: ef.n, fps: s.fps, slow: s.slow, sheets, tile } });
    s.partAt = r.at; s.partShot = hid; s.by = SH.uid; s.sheets = sheets; s.tile = tile; SH.names[SH.uid] = SH.name;
    SH.msg = '';
  } catch (e) { writeError(e); }
  finally { SH.pending--; }
  renderShotBar(); renderTeSlots();
}
async function deleteHand() {
  const id = HR.id; if (!id) return;
  try { await track(api('deleteShot', { id })); } catch (e) { writeError(e); return; }
  HR.list = HR.list.filter(s => s.id !== id);
  HR.declinedAuto = true; selectHand(null);
}

// ---------- 設定 ----------
const hIn = $('#height'); hIn.value = S.heightCm;
hIn.addEventListener('change', () => { const v = Number(hIn.value); if (v >= 120 && v <= 210) { S.heightCm = v; store.set('height', v); shareShot({ heightCm: v }); recompute(false); } else hIn.value = S.heightCm; });
const mSel = $('#modelSel'); mSel.value = S.model; mSel.addEventListener('change', () => { S.model = mSel.value; store.set('model', S.model); });
const fSel = $('#fpsSel'); fSel.value = String(S.fps); fSel.addEventListener('change', () => { S.fps = Number(fSel.value); store.set('fps', S.fps); });

$('#in-front').addEventListener('change', (e) => { onVideoFile('front', e.target.files[0]); e.target.value = ''; });
$('#in-side').addEventListener('change', (e) => { onVideoFile('side', e.target.files[0]); e.target.value = ''; });
$('#in-photo').addEventListener('change', (e) => { onPhotoFile(e.target.files[0]); e.target.value = ''; });

// ---------- 手の内・ひねりモード（弓手と馬手の接写） ----------
const TE = { view: 'both', rel: 0, playing: false, rate: 0.25, zoom: true, sample: true, layers: { skel: true, guide: true, trail: true }, spacingCm: clamp(Number(store.get('spacing')) || 5, 2, 12) };
const TKEYS = ['yunde', 'mete'];
const MK = [{ name: '黄', note: '甲・人差し指側', col: '#f5c542' }, { name: '青', note: '甲・小指側', col: '#3d8bff' }, { name: '緑', note: '手首', col: '#62c43a' }];
const TGROUPS = [['y_kai', '弓手・会', '引き収めた時の形'], ['y_hanare', '弓手・離れ', '離れの前後の変化'], ['m_kai', '馬手・会', '引き収めた時の捻り'], ['m_hanare', '馬手・離れ', '離れの前後の動き']];
function mkSlot(key, label) {
  const pane = $('#pane-' + key);
  return {
    key, label, pane, frame: $('.frame', pane), video: $('video', pane), canvas: $('canvas.ov', pane), hudPhase: $('.hud-phase', pane), hudVal: $('.hud-val', pane),
    msg: $('.pane-msg', pane), ctl: $('.te-ctl', pane), prog: $('.pane-prog', pane), slot: $('#slot-' + key), slowSel: $('#slow-' + key),
    file: null, url: null, track: null, ph: null, phAuto: null, manualT: null, metrics: [], status: 'empty', progress: 0, w: 0, h: 0, duration: 0, slow: 1, fps: 30,
    pick: null, marks: [], calT: null, liveK: null, flip: null, sampleBg: false, stage: null, partAt: null, partShot: null, by: null, thumbs: null, sheets: null, tile: null, error: ''
  };
}
const TV = { yunde: mkSlot('yunde', '弓手'), mete: mkSlot('mete', '馬手') };
const tH = (s) => (s.ph ? s.ph.tHanare : 0);
const realOf = (s, rel = TE.rel) => tH(s) + rel;
const anyTeWork = () => !TE.sample && Object.values(TV).some(s => s.status !== 'empty');
const teActive = () => TKEYS.map(k => TV[k]).filter(s => s.track);
function relRange() {
  let lo = Infinity, hi = -Infinity;
  for (const s of teActive()) { lo = Math.min(lo, s.track.grid.t0 - tH(s)); hi = Math.max(hi, s.duration / s.slow - tH(s)); }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}
const frameStep = () => Math.min(1 / 30, ...teActive().map(s => 1 / (s.fps * s.slow)));
const fmtRel = (r) => (Math.abs(r) < 2 ? `離れから ${r >= 0 ? '+' : '−'}${Math.abs(Math.round(r * 1000))} ミリ秒` : `離れから ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)} 秒`);

// ---- モード ----
function syncBanner() {
  const te = uiMode === 'te';
  $('#sampleBanner').hidden = !(te ? TE.sample : S.sample);
  $('#sampleText').textContent = te ? '合成データの弓手・馬手です。接写の動画を選ぶと、あなたの記録に切り替わります。' : '合成データの射です。動画を選ぶと、あなたの射に切り替わります。';
}
function syncModeBtns() { $$('#modeSeg button').forEach(b => { b.disabled = S.busy && b.dataset.mode !== uiMode; }); }
function setMode(m) {
  if (S.busy && m !== uiMode) return;
  uiMode = m;
  document.body.classList.toggle('mode-te', m === 'te');
  $$('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  store.set('mode', m);
  pause(); tePause();
  if (m === 'te') { layoutTe(); renderTe(); refreshNames(); }
  else { layoutFrames(); renderAll(); }
  renderShotBar();
  syncBanner();
}
$$('#modeSeg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---- サンプルと初期化 ----
function loadTeSample() {
  for (const key of TKEYS) {
    const s = TV[key], raw = key === 'yunde' ? K.makeYundeSample() : K.makeMeteSample();
    const tr = K.prepareClose(raw);
    Object.assign(s, { track: tr, status: 'done', w: tr.w, h: tr.h, duration: tr.duration, slow: 1, fps: 240, sampleBg: true, stage: raw.stage || null, flip: null, by: null, partAt: null, partShot: null, url: null, file: null, manualT: null, marks: [], error: '' });
    s.slowSel.value = slowPref(key);
  }
  TE.sample = true; recomputeTe(true); TE.rel = -0.25;
}
// 「時間の流れ」はカメラの設定なので、枠ごとに覚えておく
const slowPref = (key) => (['1', '4', '8'].includes(store.get('slow-' + key)) ? store.get('slow-' + key) : '1');
function resetTe() {
  tePause();
  for (const s of Object.values(TV)) {
    if (s.url) URL.revokeObjectURL(s.url);
    s.video.removeAttribute('src'); try { s.video.load(); } catch (e) { /* なし */ }
    Object.assign(s, { file: null, url: null, track: null, ph: null, phAuto: null, manualT: null, metrics: [], status: 'empty', progress: 0, w: 0, h: 0, duration: 0, slow: Number(slowPref(s.key)), fps: 30, pick: null, marks: [], calT: null, liveK: null, flip: null, sampleBg: false, stage: null, partAt: null, partShot: null, by: null, thumbs: null, sheets: null, tile: null, error: '' });
    s.slowSel.value = slowPref(s.key);
  }
  TE.rel = 0; TE.sample = false;
}
function recomputeTe(resetPh) {
  for (const s of Object.values(TV)) {
    if (!s.track) { s.ph = null; s.metrics = []; continue; }
    if (resetPh || !s.phAuto) s.phAuto = K.detectClosePhases(s.track);
    let ph = s.phAuto ? { ...s.phAuto } : null;
    if (!ph) { const gr = s.track.grid, a = gr.t0, b = gr.gt[gr.G - 1]; ph = { tStart: a, tKai: a, tHanare: a + (b - a) * 0.6, tEnd: b, auto: false, fallback: true }; }
    const shared = HR.rec && HR.rec.rel ? HR.rec.rel[s.key] : null;
    const ov = Number.isFinite(s.manualT) ? s.manualT : (Number.isFinite(shared) ? shared : null);
    if (Number.isFinite(ov)) { const d = ov - ph.tHanare; ph.tHanare = ov; ph.tKai = clamp(ph.tKai + d, ph.tStart, ov - 0.2); ph.auto = false; ph.fallback = false; }
    s.ph = ph;
    try { s.metrics = s.key === 'yunde' ? K.yundeMetrics(s.track, ph, { heightCm: S.heightCm }) : K.meteMetrics(s.track, ph, { spacingCm: TE.spacingCm }); }
    catch (e) { console.error(e); s.metrics = []; }
  }
}

// ---- 配置 ----
function teVisible() {
  if (TE.view !== 'both') return [TE.view];
  return TKEYS;
}
function layoutTe() {
  const keys = teVisible(), st = $('#teStage'), W = st.clientWidth || 320;
  const n = keys.length === 2 && W >= 560 ? 2 : 1;
  st.style.setProperty('--n', n);
  const colW = (W - 8 * (n - 1)) / n;
  const maxH = Math.max(220, Math.min(window.innerHeight * (keys.length === 2 && n === 1 ? 0.44 : 0.66), 760));
  for (const key of TKEYS) {
    const s = TV[key];
    s.pane.hidden = !keys.includes(key);
    if (s.pane.hidden) continue;
    const ar = s.w && s.h ? s.w / s.h : 3 / 4;
    let w = colW, h = w / ar; if (h > maxH) { h = maxH; w = h * ar; }
    s.frame.style.width = Math.floor(w) + 'px'; s.frame.style.height = Math.floor(h) + 'px';
    s.canvas.width = Math.round(Math.floor(w) * dpr); s.canvas.height = Math.round(Math.floor(h) * dpr);
  }
}

// ---- サンプルの「動画」 ----
function paintTeStage(g, W, H) {
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#4a4338'); gr.addColorStop(1, '#2e2a24');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
function paintHandSample(g, s, k, sc, real) {
  paintTeStage(g, g.canvas.width, g.canvas.height);
  const st = s.stage || { bowX0: 340, bowX1: 401, gripY0: 326, gripY1: 686, arrowY: 283, arrowH: 7 };
  const bx0 = st.bowX0 * sc, bx1 = st.bowX1 * sc, H = g.canvas.height;
  const wg = g.createLinearGradient(bx0, 0, bx1, 0); wg.addColorStop(0, '#7a5a2a'); wg.addColorStop(0.5, '#b88a45'); wg.addColorStop(1, '#6d4f24');
  g.fillStyle = wg; g.fillRect(bx0, 0, bx1 - bx0, H);
  g.fillStyle = '#4a2e1c'; g.fillRect(bx0 - 1, st.gripY0 * sc, bx1 - bx0 + 2, (st.gripY1 - st.gripY0) * sc);
  if (!s.ph || real < s.ph.tHanare) { g.fillStyle = '#d8c28a'; g.fillRect(0, st.arrowY * sc, g.canvas.width, st.arrowH * sc); }
  if (!k) return;
  const P = (p) => [p.x * sc, p.y * sc];
  const palm = Math.hypot(k[9].x - k[0].x, k[9].y - k[0].y) * sc;
  g.fillStyle = '#e2ba96'; g.beginPath(); [0, 1, 2, 5, 9, 13, 17].forEach((j, i) => (i ? g.lineTo(...P(k[j])) : g.moveTo(...P(k[j])))); g.closePath(); g.fill();
  g.strokeStyle = '#e2ba96'; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const f of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    g.lineWidth = palm * (f[0] === 1 ? 0.3 : 0.24); g.beginPath(); f.forEach((j, i) => (i ? g.lineTo(...P(k[j])) : g.moveTo(...P(k[j])))); g.stroke();
  }
  g.strokeStyle = '#d9b08a'; g.lineWidth = palm * 0.55; g.beginPath(); g.moveTo(...P(k[0])); g.lineTo(k[0].x * sc - palm * 0.9, k[0].y * sc + palm * 0.15); g.stroke();
}
function paintYugakeSample(g, m, sc) {
  paintTeStage(g, g.canvas.width, g.canvas.height);
  if (!m) return;
  const a = { x: m[0].x * sc, y: m[0].y * sc }, b = { x: m[1].x * sc, y: m[1].y * sc }, w = { x: m[2].x * sc, y: m[2].y * sc };
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ang = Math.atan2(b.y - a.y, b.x - a.x);
  g.strokeStyle = '#6f5034'; g.lineCap = 'round'; g.lineWidth = L * 0.75; g.beginPath(); g.moveTo(w.x, w.y); g.lineTo(w.x + (w.x - c.x) * 1.6, w.y + (w.y - c.y) * 1.6); g.stroke();
  g.fillStyle = '#7c5a39'; g.save(); g.translate(w.x, w.y); g.rotate(Math.atan2(w.y - c.y, w.x - c.x) - Math.PI / 2); roundRect(g, -L * 0.48, -L * 0.24, L * 0.96, L * 0.5, L * 0.08); g.fill(); g.restore();
  g.fillStyle = '#9b7650'; g.save(); g.translate(c.x, c.y); g.rotate(ang); roundRect(g, -L * 0.85, -L * 0.62, L * 1.7, L * 1.25, L * 0.3); g.fill(); g.restore();
  const r = L * 0.1;
  [[a, '#f5c542'], [b, '#2f7de1'], [w, '#5dbb3a']].forEach(([p, col]) => { g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill(); });
}

// ---- 描画 ----
function drawTeView(s) {
  const c = s.canvas, ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (!s.w || s.pane.hidden) { s.hudPhase.textContent = ''; s.hudVal.textContent = ''; return; }
  const sc = W / s.w, lw = Math.max(2, W / 150);
  const P = (p) => [p.x * sc, p.y * sc];
  const real = s.track ? realOf(s) : 0;
  if (s.sampleBg) { const q = K.closeAt(s.track, real); if (s.key === 'yunde') paintHandSample(ctx, s, q, sc, real); else paintYugakeSample(ctx, q, sc); }
  else if (s.flip && !s.url) drawFlip(ctx, s, real, W, H);
  else if (!s.url && s.track) { ctx.fillStyle = '#0e1013'; ctx.fillRect(0, 0, W, H); }
  if (s.status === 'analyzing') {
    if (s.liveK) { if (s.key === 'yunde') drawHandSkel(ctx, s.liveK, P, lw); else drawMarks(ctx, s.liveK, P, lw); }
    s.hudPhase.textContent = '解析中'; s.hudVal.textContent = ''; return;
  }
  if (s.status === 'ready') {
    if (s.key === 'yunde' && s.pick) { const [x, y] = P(s.pick); ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(x, y, 22 * dpr, 0, Math.PI * 2); ctx.stroke(); }
    if (s.key === 'mete') s.marks.forEach((m, i) => { const [x, y] = P(m); ctx.strokeStyle = '#fff'; ctx.lineWidth = lw * 0.8; ctx.beginPath(); ctx.arc(x, y, Math.max(10 * dpr, m.ref.r / m.sc * sc * 1.6), 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = MK[i].col; ctx.font = `700 ${Math.round(12 * dpr)}px ${getComputedStyle(document.body).fontFamily}`; ctx.fillText(MK[i].name, x + 14 * dpr, y - 10 * dpr); });
    s.hudPhase.textContent = ''; s.hudVal.textContent = ''; return;
  }
  if (!s.track) { s.hudPhase.textContent = ''; s.hudVal.textContent = ''; return; }
  const pi = K.closePhaseAt(s.ph, real);
  s.hudPhase.textContent = pi >= 0 ? K.TPH[pi].name : '';
  const q = K.closeAt(s.track, real);
  if (!q) { s.hudVal.textContent = '範囲外'; return; }
  if (s.key === 'yunde') drawYundeOverlay(ctx, s, q, P, lw, real, sc);
  else drawMeteOverlay(ctx, s, q, P, lw, real, sc);
}
function drawHandSkel(ctx, k, P, lw) {
  const col = { t: C['ov-ya'], f: C['ov-yunde'], p: C['ov-trunk'] };
  ctx.lineCap = 'round'; ctx.setLineDash([]);
  for (const [a, b, s] of K.HAND_EDGES) { ctx.globalAlpha = 0.95; ctx.strokeStyle = col[s]; ctx.lineWidth = lw * (s === 'p' ? 0.75 : 1); ctx.beginPath(); ctx.moveTo(...P(k[a])); ctx.lineTo(...P(k[b])); ctx.stroke(); }
  for (let j = 0; j < 21; j++) { ctx.fillStyle = j >= 1 && j <= 4 ? C['ov-ya'] : (j === 0 || j % 4 === 1 ? C['ov-trunk'] : C['ov-yunde']); ctx.beginPath(); ctx.arc(...P(k[j]), lw * (j === 4 ? 1.6 : 1.1), 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
}
function drawMarks(ctx, m, P, lw, ok) {
  m.forEach((p, i) => {
    const [x, y] = P(p);
    ctx.setLineDash(ok && !ok[i] ? [lw, lw] : []);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = lw * 0.8; ctx.beginPath(); ctx.arc(x, y, lw * 3.2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = MK[i].col; ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(x, y, lw * 1.4, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  });
  ctx.setLineDash([]);
}
function drawYundeOverlay(ctx, s, k, P, lw, real) {
  const sT = s.track.sT || 1;
  const palm = Math.hypot(k[9].x - k[0].x, k[9].y - k[0].y) * (ctx.canvas.width / s.w);
  const [mx, my] = P(k[2]), [tx, ty] = P(k[4]);
  if (TE.layers.guide) {
    ctx.setLineDash([lw * 2, lw * 1.5]); ctx.strokeStyle = C['ov-guide']; ctx.lineWidth = Math.max(1, lw * 0.6);
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + sT * palm * 1.5, my); ctx.stroke();
    const [wx, wy] = P(k[0]), [ux, uy] = P(k[9]);
    ctx.strokeStyle = 'rgba(233,237,242,.55)';
    ctx.beginPath(); ctx.moveTo(wx - (ux - wx) * 0.4, wy - (uy - wy) * 0.4); ctx.lineTo(ux + (ux - wx) * 0.9, uy + (uy - wy) * 0.9); ctx.stroke();
    ctx.setLineDash([]);
    const a0 = sT > 0 ? 0 : Math.PI, a1 = Math.atan2(ty - my, tx - mx);
    ctx.strokeStyle = C['ov-guide']; ctx.beginPath(); ctx.arc(mx, my, palm * 0.55, Math.min(a0, a1), Math.max(a0, a1)); ctx.stroke();
  }
  if (TE.layers.trail && s.ph && real > s.ph.tHanare - 0.05) {
    ctx.strokeStyle = C['ov-ya']; ctx.globalAlpha = 0.6; ctx.lineWidth = lw * 0.6; ctx.beginPath(); let f = true;
    for (let t = s.ph.tHanare - 0.05; t <= real; t += Math.max(s.track.dt, 1 / 240)) { const q = K.closeAt(s.track, t); if (!q) continue; const [x, y] = P(q[4]); if (f) { ctx.moveTo(x, y); f = false; } else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (TE.layers.skel) drawHandSkel(ctx, k, P, lw);
  const ang = Math.atan2(-(k[4].y - k[2].y), (k[4].x - k[2].x) * sT) * 180 / Math.PI;
  s.hudVal.textContent = `角見 ${ang >= 0 ? '上' : '下'}へ ${Math.abs(ang).toFixed(1)}°`;
}
function meteTheta(q) { return Math.atan2(-(q[1].y - q[0].y), q[1].x - q[0].x) * 180 / Math.PI; }
function drawMeteOverlay(ctx, s, q, P, lw, real) {
  const [ax, ay] = P(q[0]), [bx, by] = P(q[1]), [gx, gy] = P(q[2]);
  const L = Math.hypot(bx - ax, by - ay) || 1, th = meteTheta(q);
  if (TE.layers.trail && s.ph && real > s.ph.tHanare - 0.03) {
    ctx.strokeStyle = MK[2].col; ctx.globalAlpha = 0.65; ctx.lineWidth = lw * 0.6; ctx.beginPath(); let f = true;
    for (let t = s.ph.tHanare - 0.03; t <= real; t += Math.max(s.track.dt, 1 / 240)) { const r = K.closeAt(s.track, t); if (!r) continue; const [x, y] = P(r[2]); if (f) { ctx.moveTo(x, y); f = false; } else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (TE.layers.guide) {
    ctx.setLineDash([lw * 2, lw * 1.5]); ctx.strokeStyle = C['ov-guide']; ctx.lineWidth = Math.max(1, lw * 0.6);
    ctx.beginPath(); ctx.moveTo(ax - L * 0.2, ay); ctx.lineTo(ax + L * 1.4, ay); ctx.stroke(); ctx.setLineDash([]);
    const a1 = Math.atan2(by - ay, bx - ax);
    ctx.beginPath(); ctx.arc(ax, ay, L * 0.55, Math.min(0, a1), Math.max(0, a1)); ctx.stroke();
    ctx.strokeStyle = 'rgba(233,237,242,.6)'; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo((ax + bx) / 2, (ay + by) / 2); ctx.stroke();
  }
  if (TE.layers.skel) {
    ctx.strokeStyle = C['ov-ya']; ctx.lineWidth = lw * 1.1; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    drawMarks(ctx, q, P, lw, q.ok);
  }
  let txt = `捻り ${Math.abs(th).toFixed(1)}°（小指側が${th >= 0 ? '上' : '下'}）`;
  const base = s.metrics.find(m => m.key === 'm_twist');
  if (base && Number.isFinite(base.value)) { let d = th - base.value; while (d > 180) d -= 360; while (d < -180) d += 360; if (Math.abs(d) >= 0.5) txt += ` 会から${d >= 0 ? '内' : '外'}へ ${Math.abs(d).toFixed(1)}°`; }
  s.hudVal.textContent = txt;
}
function drawTeTimeline() {
  const cv = $('#teTimeline'); const [W, H] = sizeCanvas(cv, 50); const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = C.sunk; roundRect(ctx, 0, 0, W, H, 8 * dpr); ctx.fill();
  const [lo0, hi0] = relRange(); if (!(hi0 > lo0)) return;
  const [lo, hi] = TE.zoom ? [Math.max(lo0, -0.5), Math.min(hi0, 0.6)] : [lo0, hi0];
  const X = (r) => clamp((r - lo) / (hi - lo), 0, 1) * W, y0 = 6 * dpr, bh = H - 22 * dpr;
  const s = TV.mete.track ? TV.mete : TV.yunde;
  if (s.ph) {
    const h0 = tH(s), b = [lo0, s.ph.tKai - h0, 0, 0.3, hi0], cur = K.closePhaseAt(s.ph, realOf(s));
    ctx.font = `800 ${Math.round(12 * dpr)}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const x0 = X(b[i]), x1 = X(b[i + 1]); if (x1 - x0 < 0.5) continue;
      ctx.fillStyle = i === cur ? C.main : (i % 2 ? C.surface : C.bg); ctx.fillRect(x0, y0, x1 - x0, bh);
      if (x1 - x0 > 30 * dpr) { ctx.fillStyle = i === cur ? C.surface : C.ink; ctx.fillText(K.TPH[i].name, (x0 + x1) / 2, y0 + bh / 2 + 1); }
    }
  }
  ctx.fillStyle = C.muted; ctx.font = `${Math.round(10.5 * dpr)}px ${getComputedStyle(document.body).fontFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const span = hi - lo, step = span <= 1.2 ? 0.1 : span <= 3 ? 0.5 : span <= 8 ? 1 : 2;
  for (let r = Math.ceil(lo / step) * step; r <= hi + 1e-9; r += step) {
    const x = X(r); ctx.fillRect(x - 0.5, H - 15 * dpr, 1, 4 * dpr);
    const lab = step < 0.5 ? `${Math.round(r * 1000)}` : `${+r.toFixed(1)}秒`;
    if ((step < 0.5 && Math.round(r * 10) % 2 === 0) || step >= 0.5) ctx.fillText(lab, clamp(x, 14 * dpr, W - 14 * dpr), H - 3 * dpr);
  }
  const x0 = X(0); ctx.fillStyle = C.ya; ctx.beginPath(); ctx.moveTo(x0 - 5 * dpr, 0); ctx.lineTo(x0 + 5 * dpr, 0); ctx.lineTo(x0, 7 * dpr); ctx.closePath(); ctx.fill();
  const xp = X(TE.rel); ctx.fillStyle = C.sub; ctx.fillRect(xp - dpr, 0, 2 * dpr, H - 16 * dpr);
}
function teSeries() {
  const out = [];
  const y = TV.yunde, m = TV.mete;
  if (m.track && m.ph) {
    const base = (m.metrics.find(x => x.key === 'm_twist') || {}).value;
    const arr = []; const gr = m.track.grid;
    for (let g = 0; g < gr.G; g += Math.max(1, Math.floor(gr.G / 900))) { let d = m.track.sig.ori[g] - (Number.isFinite(base) ? base : 0); while (d > 180) d -= 360; while (d < -180) d += 360; arr.push([gr.gt[g] - tH(m), d]); }
    out.push({ name: '馬手の捻り（会からの変化、内が＋）', col: C['mete-ln'], arr });
  }
  if (y.track && y.ph) {
    const sT = y.track.sT || 1, gr = y.track.grid, a1 = [], a2 = [];
    const base = (y.metrics.find(x => x.key === 'y_tilt') || {}).value;
    for (let g = 0; g < gr.G; g += Math.max(1, Math.floor(gr.G / 900))) {
      const k = K.closeGrid(y.track, g), t = gr.gt[g] - tH(y);
      a1.push([t, Math.atan2(-(k[4].y - k[2].y), (k[4].x - k[2].x) * sT) * 180 / Math.PI]);
      a2.push([t, Math.atan2((k[17].x - k[5].x) * sT, k[17].y - k[5].y) * 180 / Math.PI - (Number.isFinite(base) ? base : 0)]);
    }
    out.push({ name: '弓手の角見（上が＋）', col: C['yunde-ln'], arr: a1 });
    out.push({ name: '弓手の手の内の回り（会からの変化）', col: C.ya, arr: a2 });
  }
  return out;
}
function drawTeChart() {
  const cv = $('#teChart'); const [W, H] = sizeCanvas(cv, 230); const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
  ctx.font = `${Math.round(11 * dpr)}px ${getComputedStyle(document.body).fontFamily}`;
  const ser = teSeries();
  const leg = $('#teLegend'); leg.textContent = '';
  for (const s of ser) { const sp = document.createElement('span'); const i = document.createElement('i'); i.style.background = s.col; sp.appendChild(i); sp.appendChild(document.createTextNode(s.name)); leg.appendChild(sp); }
  if (!ser.length) { ctx.fillStyle = C.muted; ctx.fillText('解析すると表示します', 12 * dpr, 24 * dpr); return; }
  const [lo0, hi0] = relRange();
  const [lo, hi] = TE.zoom ? [Math.max(lo0, -0.5), Math.min(hi0, 0.6)] : [lo0, hi0];
  const padL = 40 * dpr, padR = 10 * dpr, top = 10 * dpr, bot = H - 22 * dpr;
  const X = (t) => padL + clamp((t - lo) / (hi - lo), 0, 1) * (W - padL - padR);
  let vlo = Infinity, vhi = -Infinity;
  for (const s of ser) for (const [t, v] of s.arr) if (t >= lo && t <= hi && Number.isFinite(v)) { vlo = Math.min(vlo, v); vhi = Math.max(vhi, v); }
  if (!Number.isFinite(vlo)) { vlo = -10; vhi = 10; }
  const stepV = (vhi - vlo) > 120 ? 40 : (vhi - vlo) > 60 ? 20 : 10;
  vlo = Math.floor(Math.min(vlo, -5) / stepV) * stepV; vhi = Math.ceil(Math.max(vhi, 5) / stepV) * stepV;
  const Y = (v) => top + (1 - (v - vlo) / (vhi - vlo || 1)) * (bot - top);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = vlo; v <= vhi + 1e-6; v += stepV) { ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke(); ctx.fillText(v + '°', padL - 6 * dpr, Y(v)); }
  ctx.save(); ctx.beginPath(); ctx.rect(padL, 0, W - padL - padR, H); ctx.clip();
  for (const s of ser) {
    ctx.strokeStyle = s.col; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath(); let f = true;
    for (const [t, v] of s.arr) { if (t < lo - 0.05 || t > hi + 0.05 || !Number.isFinite(v)) continue; if (f) { ctx.moveTo(X(t), Y(v)); f = false; } else ctx.lineTo(X(t), Y(v)); }
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = C.ya; ctx.fillRect(X(0) - dpr * 0.75, top, 1.5 * dpr, bot - top);
  ctx.fillStyle = C.sub; ctx.fillRect(X(TE.rel) - dpr * 0.75, top, 1.5 * dpr, bot - top);
  ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const span = hi - lo, st = span <= 1.2 ? 0.2 : span <= 3 ? 0.5 : span <= 8 ? 1 : 2;
  for (let r = Math.ceil(lo / st) * st; r <= hi + 1e-9; r += st) ctx.fillText(st < 0.5 ? `${Math.round(r * 1000)}ms` : `${+r.toFixed(1)}秒`, clamp(X(r), padL + 16 * dpr, W - 24 * dpr), H - 6 * dpr);
}
function updateTeTransport() {
  $('#teTime').textContent = teActive().length ? fmtRel(TE.rel) : '—';
  $('#tePlayIcon').innerHTML = TE.playing ? '<path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z"/>' : '<path d="M6 4v12l10-6z"/>';
  $('#tePlay').setAttribute('aria-label', TE.playing ? '一時停止' : '再生');
}
function drawTeAll() {
  if (uiMode !== 'te') return;
  for (const s of Object.values(TV)) drawTeView(s);
  drawTeTimeline(); drawTeChart(); updateTeTransport();
}

// ---- 枠と案内 ----
function renderTeSlots() {
  for (const s of Object.values(TV)) {
    const c = $('[data-st]', s.slot), f = $('[data-file]', s.slot);
    const set = (st, cls, file) => { c.textContent = st; c.className = 'chip ' + (cls || ''); if (file != null) f.textContent = file; };
    const name = s.file ? s.file.name : '';
    if (TE.sample) set('サンプル', 'info', s.key === 'yunde' ? '正面寄りから弓手を大きく' : '後ろから馬手を大きく（目印3つ）');
    else if (s.status === 'empty') set('未選択', '', s.key === 'yunde' ? '正面寄りから弓手を大きく' : '後ろから馬手を大きく（目印3つ）');
    else if (s.status === 'loading') set('読み込み中', 'busy', name);
    else if (s.status === 'ready') set(s.key === 'mete' && s.marks.length < 3 ? `目印 ${s.marks.length}/3` : '解析待ち', 'warn', name);
    else if (s.status === 'analyzing') set(`解析中 ${Math.round(s.progress * 100)}%`, 'busy', null);
    else if (s.status === 'done') set('解析済み', 'ok', s.partShot && s.partShot === HR.id ? whoText(s.by) : name);
    else if (s.status === 'error') set('エラー', 'warn', name);
    s.slowSel.disabled = S.busy;
    const fpsEl = $('#fps-' + s.key);
    fpsEl.textContent = s.status === 'empty' || TE.sample ? '' : `毎秒 ${s.fps} コマ${s.slow > 1 ? `（実時間で ${s.fps * s.slow}）` : ''}`;
  }
}
function renderTeMsg(s) {
  const m = s.msg, ctl = s.ctl; s.prog.hidden = s.status !== 'analyzing';
  ctl.hidden = s.status !== 'ready';
  s.video.hidden = !(s.url && !TE.sample && s.status !== 'error' && s.status !== 'empty');
  if (s.status === 'empty' && !s.track) {
    m.hidden = false; m.className = 'pane-msg center';
    m.innerHTML = `<span>${s.label}の接写動画はまだありません</span><label class="btn small file-btn">動画を選ぶ<input type="file" accept="video/*" aria-label="${s.label}の接写動画を選ぶ"></label>`;
    $('input', m).addEventListener('change', (e) => onTeFile(s.key, e.target.files[0]));
  } else if (s.status === 'loading') { m.hidden = false; m.className = 'pane-msg center'; m.textContent = '読み込み中…（コマ数を調べています）'; }
  else if (s.status === 'ready') {
    m.hidden = true;
    const scrub = `<label class="scrub"><span>コマを選ぶ</span><input type="range" min="0" max="${s.duration.toFixed(3)}" step="${(1 / s.fps).toFixed(4)}" value="${s.video.currentTime.toFixed(3)}" aria-label="表示するコマ"></label>`;
    if (s.key === 'yunde') {
      ctl.innerHTML = `<span>弓手が画面の真ん中にない時は、解析の前に手をタップしてください。${s.pick ? '（指定済み）' : ''}</span>${scrub}<button type="button" class="btn small" data-go>解析する</button>`;
    } else {
      const n = s.marks.length;
      const warn = s.marks.filter(m => m.clash).map((m, i) => MK[s.marks.indexOf(m)].name);
      const next = n < 3 ? `目印がはっきり見えるコマで、<i class="mk-dot" style="background:${MK[n].col}"></i><b>${MK[n].name}</b>（${MK[n].note}）の真ん中をタップしてください（${n + 1}/3）` : '3つの目印の色を覚えました。';
      const wtxt = warn.length ? `<small class="ctl-warn">${warn.join('・')}の目印と同じような色が、ゆがけや背景にも写っています。うまく追えない時は、ほかと違う色の目印にしてください。</small>` : '';
      ctl.innerHTML = `<span>${next}</span>${wtxt}${n ? '' : scrub}<div class="msg-row">${n ? '<button type="button" class="btn small ghost" data-redo>やり直す</button>' : ''}<button type="button" class="btn small" data-go ${n < 3 ? 'disabled' : ''}>解析する</button></div>`;
      const redo = $('[data-redo]', ctl); if (redo) redo.addEventListener('click', () => { s.marks = []; s.calT = null; renderTe(); });
    }
    const r = $('input[type=range]', ctl);
    if (r) r.addEventListener('input', () => { seekTo(s.video, Number(r.value)).then(() => drawTeView(s)); });
    $('[data-go]', ctl).addEventListener('click', () => startTeAnalysis(s.key));
  } else if (s.status === 'error') {
    m.hidden = false; m.className = 'pane-msg center';
    m.innerHTML = '<span></span><label class="btn small file-btn">別の動画を選ぶ<input type="file" accept="video/*"></label>';
    $('span', m).textContent = s.error || '解析できませんでした';
    $('input', m).addEventListener('change', (e) => onTeFile(s.key, e.target.files[0]));
  } else m.hidden = true;
}
function renderTeAdj() {
  const L = $('#teAdj'); L.innerHTML = '';
  const any = teActive();
  if (!any.length) { L.innerHTML = '<p class="adj-note">解析が終わると直せます。</p>'; return; }
  for (const s of any) {
    const row = document.createElement('div'); row.className = 'adj-row';
    row.innerHTML = `<span class="lbl">${s.label}の離れ</span><span class="tv">${tH(s).toFixed(3)}秒${s.ph && s.ph.auto ? '' : '＊'}</span><button type="button" data-d="-1">−1コマ</button><button type="button" data-d="1">＋1コマ</button><button type="button" data-here>ここ</button><button type="button" data-auto>自動</button>`;
    row.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !s.ph) return;
      const real = realOf(s), fr = 1 / (s.fps * s.slow);
      let v = b.hasAttribute('data-auto') ? null : b.hasAttribute('data-here') ? real : tH(s) + Number(b.dataset.d) * fr;
      if (v != null) v = clamp(v, s.ph.tStart + 0.25, s.ph.tEnd - 0.05);
      if (canShareTe() && HR.rec) { HR.rec = { ...HR.rec, rel: { ...(HR.rec.rel || {}), [s.key]: v } }; s.manualT = null; shareHand({ rel: HR.rec.rel }); }
      else s.manualT = v;
      const keep = real; recomputeTe(false); TE.rel = keep - tH(s);
      renderTe();
    });
    L.appendChild(row);
  }
  const note = document.createElement('p'); note.className = 'adj-note';
  note.textContent = '「ここ」はいまの位置を離れにします。2本ある時は、それぞれの離れの瞬間で時刻をそろえて並べます。＊は手で直した位置です。';
  L.appendChild(note);
}
function renderTeMetrics() {
  const A = $('#teMetrics');
  const all = TKEYS.flatMap(k => TV[k].metrics);
  if (!all.length) { A.innerHTML = '<p class="empty-note">弓手・馬手の接写動画を解析すると、ここに手の内とひねりの計測が並びます。</p>'; return; }
  const fb = teActive().filter(s => s.ph && s.ph.fallback);
  let html = fb.length ? `<p class="empty-note" style="margin:0 0 12px">${fb.map(s => s.label).join('・')}の離れを自動で見つけられませんでした。「離れの位置を直す」で合わせてください。</p>` : '';
  html += '<div class="groups">';
  for (const [g, name, sub] of TGROUPS) {
    const rows = all.filter(m => m.group === g); if (!rows.length) continue;
    html += `<div class="group"><h3>${name}<span>${sub}</span></h3>`;
    for (const m of rows) html += `<button type="button" class="mrow" data-tkey="${m.key}"><span class="m-l">${esc(m.label)}</span>${m.verdict ? `<span class="chip ${m.status}">${esc(m.verdict)}</span>` : ''}<span class="m-v">${esc(m.display)}</span>${m.note ? `<span class="m-n">${esc(m.note)}</span>` : ''}</button>`;
    html += '</div>';
  }
  A.innerHTML = html + '</div>';
  $$('[data-tkey]', A).forEach(b => b.addEventListener('click', () => {
    const m = all.find(x => x.key === b.dataset.tkey); if (!m || !Number.isFinite(m.t)) return;
    const s = TV[m.side]; tePause();
    if (TE.view !== 'both' && TE.view !== m.side) setTeView(m.side);
    teSetTime(m.t - tH(s));
    $('#teSec').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
}
function renderTe() {
  renderTeSlots();
  if (uiMode !== 'te') return;
  syncBanner(); renderShotBar();
  layoutTe(); for (const s of Object.values(TV)) renderTeMsg(s);
  renderTeAdj(); renderTeMetrics(); drawTeAll();
}
function setTeView(v) { TE.view = v; $$('#teView button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tv === v))); layoutTe(); drawTeAll(); }
$$('#teView button').forEach(b => b.addEventListener('click', () => setTeView(b.dataset.tv)));
$$('#teLayers .tog').forEach(b => { b.setAttribute('aria-pressed', String(!!TE.layers[b.dataset.tl])); b.addEventListener('click', () => { const k = b.dataset.tl; TE.layers[k] = !TE.layers[k]; b.setAttribute('aria-pressed', String(TE.layers[k])); drawTeAll(); }); });
$('#teZoom').addEventListener('change', (e) => { TE.zoom = e.target.checked; drawTeAll(); });

// ---- 再生 ----
let teRaf = 0, teLast = 0;
const teVideoActive = (s) => !TE.sample && s.url && s.status === 'done' && s.track;
function teSetTime(rel) {
  const [lo, hi] = relRange(); TE.rel = clamp(rel, lo, hi);
  for (const s of Object.values(TV)) if (teVideoActive(s)) { const vt = realOf(s) * s.slow; if (vt >= 0 && vt <= s.duration) { try { s.video.currentTime = vt; } catch (e) { /* 読み込み中 */ } } }
  drawTeAll();
}
function tePlay() {
  if (!teActive().length) return;
  const [lo, hi] = relRange(); if (TE.rel >= hi - 0.005) TE.rel = lo;
  TE.playing = true;
  for (const s of Object.values(TV)) if (teVideoActive(s)) { s.video.playbackRate = clamp(TE.rate * s.slow, 0.0625, 16); const vt = realOf(s) * s.slow; if (vt >= 0 && vt < s.duration) { s.video.currentTime = vt; s.video.play().catch(() => {}); } }
  teLast = performance.now(); cancelAnimationFrame(teRaf); teRaf = requestAnimationFrame(teTick); updateTeTransport();
}
function tePause() {
  TE.playing = false; cancelAnimationFrame(teRaf);
  for (const s of Object.values(TV)) if (teVideoActive(s)) s.video.pause();
  if (uiMode === 'te' && $('#teTime')) updateTeTransport();
}
function teTick(now) {
  if (!TE.playing) return;
  const master = Object.values(TV).find(s => teVideoActive(s) && !s.video.paused);
  if (master) TE.rel = master.video.currentTime / master.slow - tH(master); else TE.rel += (now - teLast) / 1000 * TE.rate;
  teLast = now;
  for (const s of Object.values(TV)) {
    if (s === master || !teVideoActive(s)) continue;
    const vt = realOf(s) * s.slow;
    if (vt < 0 || vt > s.duration) { if (!s.video.paused) s.video.pause(); continue; }
    if (s.video.paused) { s.video.currentTime = vt; s.video.playbackRate = clamp(TE.rate * s.slow, 0.0625, 16); s.video.play().catch(() => {}); }
    else if (Math.abs(s.video.currentTime - vt) > 0.1 * s.slow) s.video.currentTime = vt;
  }
  const [, hi] = relRange(); if (TE.rel >= hi) { TE.rel = hi; tePause(); }
  drawTeAll();
  if (TE.playing) teRaf = requestAnimationFrame(teTick);
}
$('#tePlay').addEventListener('click', () => (TE.playing ? tePause() : tePlay()));
$('#teBack').addEventListener('click', () => { tePause(); teSetTime(TE.rel - frameStep()); });
$('#teFwd').addEventListener('click', () => { tePause(); teSetTime(TE.rel + frameStep()); });
$('#teJump').addEventListener('click', () => { tePause(); teSetTime(-0.3); });
$$('#teRate button').forEach(b => b.addEventListener('click', () => {
  TE.rate = Number(b.dataset.rate); $$('#teRate button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  for (const s of Object.values(TV)) if (teVideoActive(s)) s.video.playbackRate = clamp(TE.rate * s.slow, 0.0625, 16);
}));
{
  const tl = $('#teTimeline');
  const sc = (e) => { const r = tl.getBoundingClientRect(); const [lo0, hi0] = relRange(); const [lo, hi] = TE.zoom ? [Math.max(lo0, -0.5), Math.min(hi0, 0.6)] : [lo0, hi0]; teSetTime(lo + clamp((e.clientX - r.left) / r.width, 0, 1) * (hi - lo)); };
  tl.addEventListener('pointerdown', (e) => { tePause(); tl.setPointerCapture(e.pointerId); sc(e); });
  tl.addEventListener('pointermove', (e) => { if (tl.hasPointerCapture(e.pointerId)) sc(e); });
  $('#teChart').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); const u = (e.clientX - r.left - 40) / (r.width - 50); if (u < 0 || u > 1) return; const [lo0, hi0] = relRange(); const [lo, hi] = TE.zoom ? [Math.max(lo0, -0.5), Math.min(hi0, 0.6)] : [lo0, hi0]; tePause(); teSetTime(lo + u * (hi - lo)); });
}
for (const s of Object.values(TV)) {
  s.video.addEventListener('seeked', () => { if (!S.busy && uiMode === 'te') drawTeView(s); });
  $('.cancel', s.pane).addEventListener('click', () => { cancelFlag = true; });
  s.canvas.addEventListener('click', (e) => onTeTap(s, e));
  s.slowSel.addEventListener('change', () => onSlowChange(s));
}

// ---- 読み込み ----
function estimateFps(video) {
  return new Promise((res) => {
    if (!('requestVideoFrameCallback' in video)) { res(30); return; }
    const ts = []; let done = false;
    const fin = () => {
      if (done) return; done = true;
      try { video.pause(); } catch (e) { /* なし */ }
      video.playbackRate = 1;
      const d = []; for (let i = 1; i < ts.length; i++) { const x = ts[i] - ts[i - 1]; if (x > 1e-4) d.push(x); }
      if (d.length < 3) { res(30); return; }
      d.sort((a, b) => a - b);
      const f = 1 / d[Math.floor(d.length * 0.2)];
      let best = 30, bd = Infinity;
      for (const c of [24, 25, 30, 48, 50, 60, 90, 100, 120, 180, 240, 480]) { const e = Math.abs(Math.log(c / f)); if (e < bd) { bd = e; best = c; } }
      res(best);
    };
    const cb = (now, meta) => { ts.push(meta.mediaTime); if (!done && ts.length < 30) video.requestVideoFrameCallback(cb); else fin(); };
    video.playbackRate = 0.25; video.muted = true;
    video.requestVideoFrameCallback(cb);
    video.play().catch(fin);
    setTimeout(fin, 3500);
  });
}
async function onTeFile(key, file) {
  if (!file || S.busy) return;
  tePause(); pause();
  if (SH.db && !HR.id && canCreateTe()) await createHand();
  if (TE.sample) resetTe();
  const s = TV[key];
  if (s.url) URL.revokeObjectURL(s.url);
  Object.assign(s, { file, url: URL.createObjectURL(file), track: null, ph: null, phAuto: null, manualT: null, metrics: [], status: 'loading', pick: null, marks: [], calT: null, liveK: null, sampleBg: false, stage: null, flip: null, partAt: null, partShot: null, by: null, sheets: null, tile: null, error: '' });
  s.slow = Number(s.slowSel.value) || 1;
  renderTe();
  const vid = s.video; vid.src = s.url; vid.muted = true; vid.playsInline = true;
  try {
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout')), 20000); vid.onloadedmetadata = () => { clearTimeout(to); res(); }; vid.onerror = () => { clearTimeout(to); rej(new Error('decode')); }; vid.load(); });
    s.w = vid.videoWidth; s.h = vid.videoHeight; s.duration = vid.duration;
    if (!s.w || !Number.isFinite(s.duration)) throw new Error('meta');
    s.fps = await estimateFps(vid);
    await seekTo(vid, Math.min(0.1, s.duration / 2));
    s.status = 'ready';
  } catch (e) { s.status = 'error'; s.error = 'この動画は読み込めませんでした。MP4（H.264）か MOV で試してください。'; }
  renderTe();
}
$('#in-yunde').addEventListener('change', (e) => { onTeFile('yunde', e.target.files[0]); e.target.value = ''; });
$('#in-mete').addEventListener('change', (e) => { onTeFile('mete', e.target.files[0]); e.target.value = ''; });
// 解析のあとで「時間の流れ」を変えた時は、時刻だけ直す
function onSlowChange(s) {
  const nv = Number(s.slowSel.value) || 1, old = s.slow;
  if (!s.partShot || s.partShot !== HR.id || s.by === SH.uid) store.set('slow-' + s.key, String(nv));
  if (TE.sample) { renderTeSlots(); return; }
  s.slow = nv;
  if (s.track && old !== nv) {
    const f = old / nv;
    const frames = s.track.frames.map(fr => ({ ...fr, t: fr.t * f }));
    s.track = K.prepareClose({ kind: s.key, w: s.w, h: s.h, duration: s.duration, fps: s.fps, slow: nv, frames });
    if (Number.isFinite(s.manualT)) s.manualT *= f;
    if (HR.rec && HR.rec.rel && Number.isFinite(HR.rec.rel[s.key])) { HR.rec = { ...HR.rec, rel: { ...HR.rec.rel, [s.key]: HR.rec.rel[s.key] * f } }; shareHand({ rel: HR.rec.rel }); }
    recomputeTe(true);
    if (canShareTe() && s.partShot === HR.id) shareTePart(s.key, s, s.track.frames.map((fr, i) => ({ ...fr, i: Number.isFinite(fr.i) ? fr.i : i })), null);
    TE.rel = clamp(TE.rel, ...relRange());
  }
  renderTe();
}

// ---- タップ（弓手は手の位置、馬手は目印の色） ----
const teWork = document.createElement('canvas');
function workFrame(s) {
  const sc = Math.min(1, 640 / Math.max(s.w, s.h)), W = Math.max(2, Math.round(s.w * sc)), H = Math.max(2, Math.round(s.h * sc));
  if (teWork.width !== W || teWork.height !== H) { teWork.width = W; teWork.height = H; }
  const g = teWork.getContext('2d', { willReadFrequently: true });
  g.drawImage(s.video, 0, 0, W, H);
  return { img: g.getImageData(0, 0, W, H), W, H, sc };
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, mx ? d / mx : 0, mx];
}
// 目印の色か。明るさに左右されにくい色度（r・g の割合）で比べ、くすんだ色（革や肌）は鮮やかさの下限で除く
function pixMatch(d, i, ref) {
  const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b);
  if (mx < ref.vmin) return false;
  const mn = Math.min(r, g, b);
  if (mx - mn < ref.smin * mx) return false;
  const sum = r + g + b, dr = r / sum - ref.cr, dg = g / sum - ref.cg;
  return dr * dr + dg * dg < ref.thr2;
}
function finishRef(ref, crs, cgs) {
  ref.cr = K.median(crs); ref.cg = K.median(cgs);
  const sat = Math.hypot(ref.cr - 1 / 3, ref.cg - 1 / 3);
  ref.thr2 = clamp(0.3 * sat, 0.03, 0.07) ** 2;
  ref.vmin = Math.max(30, 0.35 * ref.v * 255); ref.smin = Math.max(0.15, 0.5 * ref.s);
  return ref;
}
function pixHsv(d, i) { return rgb2hsv(d[i], d[i + 1], d[i + 2]); }
function sampleRef(fr, x, y) {
  const d = fr.img.data, W = fr.W, H = fr.H;
  // 指が少しずれても拾えるよう、近くで一番鮮やかな所を中心にする
  let best = -1, cx = Math.round(x), cy = Math.round(y);
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
    const r2 = dx * dx + dy * dy; if (r2 > 144) continue;
    const px = Math.round(x + dx), py = Math.round(y + dy); if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const hsv = pixHsv(d, (py * W + px) * 4), sc = hsv[1] * Math.sqrt(hsv[2]) - r2 / 144 * 0.15;
    if (sc > best) { best = sc; cx = px; cy = py; }
  }
  const c = pixHsv(d, (cy * W + cx) * 4);
  if (c[1] < 0.3 || c[2] < 0.2) return null;
  let cs = 0, sn = 0; const ss = [], vs = [], crs = [], cgs = [];
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    if (dx * dx + dy * dy > 36) continue;
    const px = cx + dx, py = cy + dy; if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const i = (py * W + px) * 4, hsv = pixHsv(d, i);
    let dh = Math.abs(hsv[0] - c[0]); if (dh > 180) dh = 360 - dh;
    if (dh > 20 || hsv[1] < 0.6 * c[1] || hsv[2] < 0.15) continue;
    cs += Math.cos(hsv[0] / DEGS); sn += Math.sin(hsv[0] / DEGS); ss.push(hsv[1]); vs.push(hsv[2]);
    const sum = d[i] + d[i + 1] + d[i + 2]; crs.push(d[i] / sum); cgs.push(d[i + 1] / sum);
  }
  if (ss.length < 4) return null;
  let h = Math.atan2(sn, cs) * DEGS; if (h < 0) h += 360;
  const ref = finishRef({ h, s: K.median(ss), v: K.median(vs), r: 4 }, crs, cgs);
  const blob = findBlob(fr.img, W, H, ref, cx, cy, 45, 0, Infinity);
  if (!blob) return null;
  ref.r = clamp(Math.sqrt(blob.area / Math.PI), 2.5, 40);
  // 同じ色が目印の外にどれだけあるか（多いと追い間違えやすい）
  let n = 0; const rr = (ref.r * 3) ** 2;
  for (let py = 0; py < H; py += 2) for (let px = 0; px < W; px += 2) {
    if ((px - blob.x) ** 2 + (py - blob.y) ** 2 < rr) continue;
    if (pixMatch(d, (py * W + px) * 4, ref)) n += 4;
  }
  return { ref, x: blob.x, y: blob.y, clash: n > 3 * blob.area, big: blob.area > Math.PI * 40 * 40 };
}
const DEGS = 180 / Math.PI;
// 色が近い画素の塊を探す。予想の位置に近く大きい塊を選ぶ
function findBlob(img, W, H, ref, cx, cy, R, minA, maxA) {
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const ww = x1 - x0 + 1, hh = y1 - y0 + 1; if (ww < 2 || hh < 2) return null;
  const d = img.data, mask = new Uint8Array(ww * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
    if (pixMatch(d, ((y0 + y) * W + (x0 + x)) * 4, ref)) mask[y * ww + x] = 1;
  }
  const minArea = minA != null ? minA : Math.max(3, 0.18 * Math.PI * ref.r * ref.r);
  const maxArea = maxA != null ? maxA : Math.max(60, 14 * Math.PI * ref.r * ref.r); // ゆがけなど広い所に同じ色があっても、目印とは見なさない
  const stack = new Int32Array(ww * hh); let best = null, bestScore = -1;
  for (let i0 = 0; i0 < ww * hh; i0++) {
    if (mask[i0] !== 1) continue;
    let top = 0, area = 0, sx = 0, sy = 0; stack[top++] = i0; mask[i0] = 2;
    while (top) {
      const i = stack[--top], x = i % ww, y = (i / ww) | 0; area++; sx += x; sy += y;
      if (x > 0 && mask[i - 1] === 1) { mask[i - 1] = 2; stack[top++] = i - 1; }
      if (x < ww - 1 && mask[i + 1] === 1) { mask[i + 1] = 2; stack[top++] = i + 1; }
      if (y > 0 && mask[i - ww] === 1) { mask[i - ww] = 2; stack[top++] = i - ww; }
      if (y < hh - 1 && mask[i + ww] === 1) { mask[i + ww] = 2; stack[top++] = i + ww; }
    }
    if (area < minArea || area > maxArea) continue;
    const bx = x0 + sx / area, by = y0 + sy / area, dist = Math.hypot(bx - cx, by - cy);
    const score = area / Math.pow(1 + dist / (2 * ref.r + 4), 2);
    if (score > bestScore) { bestScore = score; best = { x: bx, y: by, area }; }
  }
  return best;
}
function onTeTap(s, e) {
  if (s.status !== 'ready') return;
  const r = s.canvas.getBoundingClientRect();
  const p = { x: (e.clientX - r.left) / r.width * s.w, y: (e.clientY - r.top) / r.height * s.h };
  if (s.key === 'yunde') { s.pick = p; renderTeMsg(s); drawTeView(s); return; }
  if (s.marks.length >= 3) return;
  if (s.marks.length && Math.abs(s.video.currentTime - s.calT) > 1e-3) { s.marks = []; }
  const fr = workFrame(s);
  const got = sampleRef(fr, p.x * fr.sc, p.y * fr.sc);
  const span = $('span', s.ctl);
  if (!got) { if (span) span.textContent = `${MK[s.marks.length].name}の目印の色をうまく取れませんでした。目印の真ん中をタップしてください。`; return; }
  s.calT = s.video.currentTime;
  s.marks.push({ x: got.x / fr.sc, y: got.y / fr.sc, ref: got.ref, sc: fr.sc, clash: got.clash || got.big });
  renderTeSlots(); renderTeMsg(s); drawTeView(s);
}

// ---- 解析 ----
let handModel = null;
async function ensureHandModel(onStage) {
  await ensureTf(onStage);
  if (handModel) return handModel;
  onStage('手の検出モデルを読み込んでいます');
  handModel = await loadShardModel('handlandmark-full.json');
  const z = tf.zeros([1, 224, 224, 3]); const r = handModel.execute(z, ['Identity:0', 'Identity_1:0']); await Promise.all(r.map(x => x.data())); tf.dispose([z, ...r]);
  return handModel;
}
const hCrop = document.createElement('canvas'); hCrop.width = 224; hCrop.height = 224;
async function handInfer(src, Cc, Sz, theta) {
  const g = hCrop.getContext('2d'), k = 224 / Sz;
  g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, 224, 224);
  g.translate(112, 112); g.scale(k, k); g.rotate(-theta); g.translate(-Cc.x, -Cc.y);
  try { g.drawImage(src, 0, 0); } catch (e) { /* 描けないコマ */ }
  g.setTransform(1, 0, 0, 1, 0, 0);
  const input = tf.tidy(() => tf.browser.fromPixels(hCrop).toFloat().div(255).expandDims(0));
  const [lm, pr] = handModel.execute(input, ['Identity:0', 'Identity_1:0']);
  const d = await lm.data(), p = (await pr.data())[0];
  tf.dispose([input, lm, pr]);
  const c = Math.cos(theta), sn = Math.sin(theta), out = new Array(63);
  for (let j = 0; j < 21; j++) {
    const u = (d[j * 3] - 112) / k, v = (d[j * 3 + 1] - 112) / k;
    out[j * 3] = Cc.x + u * c - v * sn; out[j * 3 + 1] = Cc.y + u * sn + v * c; out[j * 3 + 2] = d[j * 3 + 2] / k;
  }
  return { k: out, p: p >= 0 && p <= 1 ? p : 1 / (1 + Math.exp(-p)) };
}
function handBox(k) {
  const theta = Math.atan2(k[28] - k[1], k[27] - k[0]) + Math.PI / 2;
  const c = Math.cos(-theta), sn = Math.sin(-theta);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < 21; j++) { const rx = k[j * 3] * c - k[j * 3 + 1] * sn, ry = k[j * 3] * sn + k[j * 3 + 1] * c; x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { C: { x: cx * Math.cos(theta) - cy * Math.sin(theta), y: cx * Math.sin(theta) + cy * Math.cos(theta) }, S: Math.max(40, Math.max(x1 - x0, y1 - y0) * 1.9), theta };
}
async function handSearch(src, Cc, M, sizes) {
  let best = null;
  for (const f of sizes) for (const th of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const r = await handInfer(src, Cc, f * M, th);
    if (!best || r.p > best.r.p) best = { r, C: Cc, S: f * M, theta: th };
  }
  if (best.r.p > 0.25) for (let i = 0; i < 2; i++) { const b = handBox(best.r.k); const r = await handInfer(src, b.C, b.S, b.theta); if (r.p >= best.r.p * 0.9) best = { r, ...b }; }
  return best;
}
async function runHandPass(s, vtimes, setProg, base, span, startBox) {
  const vid = s.video, M = Math.min(s.w, s.h);
  let box = startBox, lastGood = startBox, miss = 0; const out = [], t0 = performance.now();
  for (let i = 0; i < vtimes.length; i++) {
    if (cancelFlag) throw new Error('cancel');
    await seekTo(vid, vtimes[i]);
    let r;
    if (!box) { const b = await handSearch(vid, s.pick || { x: s.w / 2, y: s.h / 2 }, M, [0.3, 0.5, 0.75]); r = b.r; box = b; }
    else r = await handInfer(vid, box.C, box.S, box.theta);
    // 見失った時の探し直しは重いので、続けて見失っている間は数コマおきにする
    if (r.p < 0.4 && miss % 4 === 0) { const ref = lastGood || box; const b = await handSearch(vid, ref.C, M, [ref.S / M, 0.5]); if (b.r.p > r.p) r = b.r; }
    if (r.p >= 0.4) { box = handBox(r.k); lastGood = box; miss = 0; } else miss++;
    out.push({ t: vtimes[i] / s.slow, k: r.k, p: r.p });
    if (s.thumbs) s.thumbs.add(vid);
    s.liveK = []; for (let j = 0; j < 21; j++) s.liveK.push({ x: r.k[j * 3], y: r.k[j * 3 + 1] });
    if (i % 3 === 0) drawTeView(s);
    const el = (performance.now() - t0) / 1000; setProg(base + span * (i + 1) / vtimes.length, el / (i + 1) * (vtimes.length - i - 1));
  }
  return { out, box };
}
function makeTracker(refs, init) {
  const st = init.map(p => ({ x: p.x, y: p.y, vx: 0, vy: 0, t: null, miss: 0 }));
  return (fr, vt) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = refs[i], q = st[i];
      const dtv = q.t == null ? 0 : vt - q.t;
      const px = q.x + q.vx * dtv, py = q.y + q.vy * dtv;
      const base = Math.max(4 * r.r, 18);
      const R = clamp(base * Math.pow(1.7, q.miss) + Math.hypot(q.vx, q.vy) * Math.abs(dtv) * 0.6, base, Math.max(fr.W, fr.H) * 0.35);
      const hit = findBlob(fr.img, fr.W, fr.H, r, px, py, R);
      if (hit) {
        if (q.t != null && Math.abs(dtv) > 1e-6) { q.vx = 0.5 * q.vx + 0.5 * (hit.x - q.x) / dtv; q.vy = 0.5 * q.vy + 0.5 * (hit.y - q.y) / dtv; }
        q.x = hit.x; q.y = hit.y; q.t = vt; q.miss = 0; out.push(hit.x / fr.sc, hit.y / fr.sc, 1);
      } else { q.miss = Math.min(q.miss + 1, 4); out.push(px / fr.sc, py / fr.sc, 0); }
    }
    return out;
  };
}
async function runMarkPass(s, vtimes, init, setProg, base, span) {
  const fr0 = workFrame(s);
  const refs = s.marks.map(m => m.ref);
  const step = makeTracker(refs, init.map(p => ({ x: p.x * fr0.sc, y: p.y * fr0.sc })));
  const out = [], t0 = performance.now();
  for (let i = 0; i < vtimes.length; i++) {
    if (cancelFlag) throw new Error('cancel');
    await seekTo(s.video, vtimes[i]);
    const fr = workFrame(s);
    const m = step(fr, vtimes[i]);
    out.push({ t: vtimes[i] / s.slow, m });
    if (s.thumbs) s.thumbs.add(s.video);
    s.liveK = [{ x: m[0], y: m[1] }, { x: m[3], y: m[4] }, { x: m[6], y: m[7] }];
    if (i % 3 === 0) drawTeView(s);
    const el = (performance.now() - t0) / 1000; setProg(base + span * (i + 1) / vtimes.length, el / (i + 1) * (vtimes.length - i - 1));
  }
  return out;
}
const nearest = (arr, t) => arr.reduce((a, f) => (Math.abs(f.t - t) < Math.abs(a.t - t) ? f : a), arr[0]);
async function analyzeYunde(s, setProg, stage) {
  await ensureHandModel(stage);
  const vstep = Math.max(1 / s.fps, s.slow / 15), times = [];
  for (let v = 0.02; v < s.duration - 0.01; v += vstep) times.push(v);
  const p1 = await runHandPass(s, times, setProg, 0, 0.55, null);
  let all = p1.out;
  if (all.filter(f => f.p >= 0.4).length < all.length * 0.3) return all; // 手が写っていない。細かい解析はしない
  const tr = K.prepareClose({ kind: 'yunde', w: s.w, h: s.h, duration: s.duration, frames: all.map(f => ({ t: f.t, k: f.k, p: f.p })) });
  const ph = K.detectClosePhases(tr);
  if (ph) {
    const dense = [], have = new Set(times.map(v => Math.round(v * s.fps)));
    for (let v = Math.max(0, (ph.tHanare - 0.45) * s.slow); v <= Math.min(s.duration - 0.01, (ph.tHanare + 0.55) * s.slow); v += 1 / s.fps) if (!have.has(Math.round(v * s.fps))) dense.push(v);
    const near = nearest(all, dense.length ? dense[0] / s.slow : ph.tHanare);
    const p2 = await runHandPass(s, dense, setProg, 0.55, 0.45, handBox(near.k));
    all = all.concat(p2.out);
  }
  return all;
}
async function analyzeMete(s, setProg) {
  const vstep = Math.max(1 / s.fps, s.slow / 15), tc = s.calT || 0;
  const fwd = [], bwd = [];
  for (let v = tc; v < s.duration - 0.01; v += vstep) fwd.push(v);
  for (let v = tc - vstep; v >= 0; v -= vstep) bwd.push(v);
  const init = s.marks.map(m => ({ x: m.x, y: m.y }));
  const n1 = fwd.length + bwd.length;
  let all = await runMarkPass(s, fwd, init, setProg, 0, 0.55 * fwd.length / n1);
  all = all.concat(await runMarkPass(s, bwd, init, setProg, 0.55 * fwd.length / n1, 0.55 * bwd.length / n1));
  const tr = K.prepareClose({ kind: 'mete', w: s.w, h: s.h, duration: s.duration, frames: all.map(f => ({ t: f.t, m: f.m })) });
  const ph = K.detectClosePhases(tr);
  if (ph) {
    const have = new Set(fwd.concat(bwd).map(v => Math.round(v * s.fps))), dense = [];
    for (let v = Math.max(0, (ph.tHanare - 0.45) * s.slow); v <= Math.min(s.duration - 0.01, (ph.tHanare + 0.55) * s.slow); v += 1 / s.fps) if (!have.has(Math.round(v * s.fps))) dense.push(v);
    if (dense.length) {
      const st = nearest(all, dense[0] / s.slow);
      const init2 = [0, 1, 2].map(i => ({ x: st.m[i * 3], y: st.m[i * 3 + 1] }));
      all = all.concat(await runMarkPass(s, dense, init2, setProg, 0.55, 0.45));
    }
  }
  return all;
}
async function startTeAnalysis(key) {
  const s = TV[key];
  if (S.busy || s.status !== 'ready' || (key === 'mete' && s.marks.length < 3)) return;
  tePause(); pause();
  S.busy = true; cancelFlag = false; syncModeBtns();
  s.status = 'analyzing'; s.progress = 0; s.liveK = null; renderTe();
  const bar = $('.bar i', s.prog), txt = $('.ptxt', s.prog);
  const stage = (t) => { txt.textContent = t; };
  const setProg = (p, rest) => { s.progress = p; bar.style.width = (p * 100).toFixed(1) + '%'; txt.textContent = `${s.label}を解析中 ${Math.round(p * 100)}% ${Number.isFinite(rest) ? (rest > 90 ? `あと約${Math.ceil(rest / 60)}分` : `あと約${Math.max(1, Math.round(rest))}秒`) : ''}`; renderTeSlots(); };
  try {
    s.thumbs = canShareTe() ? new ThumbSheets(s.w, s.h) : null;
    const all = key === 'yunde' ? await analyzeYunde(s, setProg, stage) : await analyzeMete(s, setProg);
    all.forEach((f, i) => { f.i = i; });
    const frames = all.map(f => (key === 'yunde' ? { t: f.t, k: f.k, p: f.p, i: f.i } : { t: f.t, m: f.m, i: f.i }));
    const okRate = key === 'yunde' ? all.reduce((a, f) => a + (f.p > 0.4 ? 1 : 0), 0) / all.length : all.reduce((a, f) => a + (f.m[2] && f.m[5] && f.m[8] ? 1 : 0), 0) / all.length;
    if (!(okRate >= 0.35)) {
      s.status = 'error';
      s.error = key === 'yunde' ? '手をうまく見つけられませんでした。弓手をもっと大きく写すか、解析の前に手をタップしてください。' : '目印をうまく追えませんでした。目印がはっきり写るように撮り直すか、目印の真ん中をタップし直してください。';
    } else {
      s.track = K.prepareClose({ kind: key, w: s.w, h: s.h, duration: s.duration, fps: s.fps, slow: s.slow, frames });
      s.status = 'done'; s.manualT = null; s.liveK = null;
      recomputeTe(true);
      if (canShareTe()) { txt.textContent = '結果を共有しています'; await shareTePart(key, s, frames, s.thumbs); }
    }
  } catch (e) {
    s.liveK = null;
    if (e && e.message === 'cancel') s.status = 'ready';
    else { console.error(e); s.status = 'error'; s.error = e && (e.message === 'script' || e.message === 'model') ? '解析の部品を読み込めませんでした。通信を確認して、もう一度お試しください。' : '解析中に問題が起きました。もう一度お試しください。'; }
  }
  s.thumbs = null; S.busy = false; cancelFlag = false; syncModeBtns();
  if (s.ph) TE.rel = -0.3;
  renderTe(); teSetTime(TE.rel);
}

// ---- 共有用の形 ----
function teEncode(key, frames) {
  const n = frames.length, t = new Float32Array(n), ti = new Uint16Array(n), p = new Uint8Array(n);
  const C = key === 'yunde' ? 63 : 6, k = new Int16Array(n * C);
  frames.forEach((f, i) => {
    t[i] = f.t; ti[i] = f.i;
    if (key === 'yunde') { p[i] = clamp(Math.round(f.p * 255), 0, 255); for (let j = 0; j < 63; j++) k[i * 63 + j] = clamp(Math.round(f.k[j] * 4), -32767, 32767); }
    else { p[i] = (f.m[2] ? 1 : 0) | (f.m[5] ? 2 : 0) | (f.m[8] ? 4 : 0); for (let j = 0; j < 3; j++) { k[i * 6 + j * 2] = clamp(Math.round(f.m[j * 3] * 4), -32767, 32767); k[i * 6 + j * 2 + 1] = clamp(Math.round(f.m[j * 3 + 1] * 4), -32767, 32767); } }
  });
  return { n, t: b64FromBytes(new Uint8Array(t.buffer)), k: b64FromBytes(new Uint8Array(k.buffer)), p: b64FromBytes(p), ti: b64FromBytes(new Uint8Array(ti.buffer)) };
}
function teDecode(key, d) {
  const t = new Float32Array(bytesFromB64(d.t).buffer), k = new Int16Array(bytesFromB64(d.k).buffer), p = bytesFromB64(d.p || '');
  const ti = d.ti ? new Uint16Array(bytesFromB64(d.ti).buffer) : null, out = [];
  for (let i = 0; i < t.length; i++) {
    if (key === 'yunde') { const a = new Array(63); for (let j = 0; j < 63; j++) a[j] = k[i * 63 + j] / 4; out.push({ t: t[i], k: a, p: (p[i] || 0) / 255, i: ti ? ti[i] : i }); }
    else { const m = []; for (let j = 0; j < 3; j++) m.push(k[i * 6 + j * 2] / 4, k[i * 6 + j * 2 + 1] / 4, (p[i] >> j) & 1); out.push({ t: t[i], m, i: ti ? ti[i] : i }); }
  }
  return out;
}
// 共有された結果を読み込む（相手の端末で）
function teLoadPart(key, part, frames, shotId) {
  const s = TV[key];
  if (s.url) { URL.revokeObjectURL(s.url); s.url = null; s.file = null; s.video.removeAttribute('src'); }
  const tr = K.prepareClose({ kind: key, w: part.w, h: part.h, duration: part.duration, fps: part.fps, slow: part.slow, frames });
  Object.assign(s, { track: tr, status: 'done', w: part.w, h: part.h, duration: part.duration, slow: part.slow || 1, fps: part.fps || 30, sampleBg: false, stage: null, partAt: part.at, partShot: shotId, by: part.dev || part.by, flip: makeFlip(part, frames, shotId), liveK: null, manualT: null, marks: [], sheets: part.sheets || null, tile: part.tile || null, error: '' });
  s.slowSel.value = String(s.slow);
}
function teSummary() {
  const L = ['射形分析帳・手の内とひねり' + (HR.id && HR.rec ? `（${fmtShot(HR.rec)}）` : '')];
  for (const [g, name] of TGROUPS) {
    const rows = TKEYS.flatMap(k => TV[k].metrics).filter(m => m.group === g); if (!rows.length) continue;
    L.push(`【${name}】`);
    for (const m of rows) L.push(`・${m.label}: ${m.display}${m.verdict ? ' … ' + m.verdict : ''}`);
  }
  if (TE.sample) L.push('※合成サンプルの結果です');
  return L.join('\n');
}
$('#teCopy').addEventListener('click', () => {
  const text = teSummary(), msg = $('#teCopyMsg'), fb = $('#teCopyFallback');
  const showFb = () => { fb.hidden = false; fb.value = text; fb.focus(); fb.select(); msg.textContent = 'コピーできなかったので、下の文章を選択しました。'; };
  try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; fb.hidden = true; }, showFb); } catch (e) { showFb(); }
});
{
  const sp = $('#spacing'); sp.value = TE.spacingCm;
  sp.addEventListener('change', () => { const v = Number(sp.value); if (v >= 2 && v <= 12) { TE.spacingCm = v; store.set('spacing', v); recomputeTe(false); renderTe(); } else sp.value = TE.spacingCm; });
}



// ---------- まとめて描き直す ----------
function renderAll() {
  syncBanner();
  renderCoach();
  for (const v of Object.values(V)) {
    const hasVid = !S.sample && v.url && v.status !== 'error';
    v.video.hidden = !hasVid;
  }
  if (V.side.track) { try { S.sideFacing = sideFacingSign(); } catch (e) { S.sideFacing = 1; } }
  renderShotBar(); layoutFrames(); renderSlots(); renderPaneMsgs(); renderPhaseRow(); renderAdjust(); renderMetrics(); renderTarget(); renderAlign();
  drawAll(); drawTimeline(); drawChart();
}
function sideFacingSign() {
  const tr = V.side.track, tTop = S.ph ? viewTime('side', S.ph.tTop) : tr.grid.gt[Math.floor(tr.grid.G / 2)];
  const g = K.gIndex(tr, tTop), k = K.kpAtGrid(tr, g);
  const d = (k[9].x + k[10].x) / 2 - (k[5].x + k[6].x) / 2;
  return d >= 0 ? 1 : -1;
}
let rsT = 0;
window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (uiMode === 'te') { layoutTe(); drawTeAll(); } else { layoutFrames(); drawAll(); drawTimeline(); drawChart(); drawPhoto(); } }, 120); });

loadSample();
loadTeSample();
setMode(store.get('mode') === 'te' ? 'te' : 'shakei');
initShared();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawAll(); drawTimeline(); drawChart(); drawTeAll(); });
})();
