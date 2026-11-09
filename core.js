/* 射形分析帳 — 解析コア（DOM 非依存。Node でもテストできる） */
const Kyu = (() => {
  const KP = { nose: 0, leye: 1, reye: 2, lear: 3, rear: 4, lsh: 5, rsh: 6, lel: 7, rel: 8, lwr: 9, rwr: 10, lhip: 11, rhip: 12, lkn: 13, rkn: 14, lan: 15, ran: 16 };
  const NK = 17;
  // 骨格の線: [a, b, 区分]  区分: y=弓手(左) m=馬手(右) c=体幹
  const EDGES = [
    [5, 7, 'y'], [7, 9, 'y'], [6, 8, 'm'], [8, 10, 'm'],
    [5, 6, 'c'], [11, 12, 'c'], [5, 11, 'y'], [6, 12, 'm'],
    [11, 13, 'y'], [13, 15, 'y'], [12, 14, 'm'], [14, 16, 'm'],
    [0, 1, 'c'], [0, 2, 'c'], [1, 3, 'c'], [2, 4, 'c']
  ];
  const PHASES = [
    { key: 'ashibumi', name: '足踏み', short: '足踏' },
    { key: 'dozukuri', name: '胴造り', short: '胴造' },
    { key: 'yugamae', name: '弓構え', short: '弓構' },
    { key: 'uchiokoshi', name: '打起し', short: '打起' },
    { key: 'hikiwake', name: '引分け', short: '引分' },
    { key: 'kai', name: '会', short: '会' },
    { key: 'hanare', name: '離れ', short: '離れ' },
    { key: 'zanshin', name: '残心', short: '残心' }
  ];
  const DT = 1 / 30;
  const DEG = 180 / Math.PI;

  // ---------- 小道具 ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function median(arr) {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function percentile(arr, p) {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return NaN;
    return a[clamp(Math.round(p * (a.length - 1)), 0, a.length - 1)];
  }
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- 前処理 ----------
  // track: { view, w, h, duration, frames:[{t, k:[x,y,s]*17}] }
  function prepareTrack(track) {
    const fr = track.frames.slice().sort((a, b) => a.t - b.t);
    const frames = [];
    for (const f of fr) { if (!frames.length || f.t - frames[frames.length - 1].t > 1e-4) frames.push(f); }
    track.frames = frames;
    const n = frames.length;
    // 時間方向の平滑化（信頼度で重み付け）
    const sigma = 0.06, win = sigma * 2.5;
    const sm = new Array(n);
    let lo = 0;
    for (let i = 0; i < n; i++) {
      const t = frames[i].t;
      while (frames[lo].t < t - win) lo++;
      const out = new Float32Array(NK * 3);
      for (let j = 0; j < NK; j++) {
        let sx = 0, sy = 0, ss = 0, sw = 0, swc = 0;
        for (let q = lo; q < n && frames[q].t <= t + win; q++) {
          const dt = frames[q].t - t;
          const g = Math.exp(-dt * dt / (2 * sigma * sigma));
          const s = frames[q].k[j * 3 + 2];
          const w = g * Math.max(s, 0.03) * Math.max(s, 0.03);
          sx += frames[q].k[j * 3] * w; sy += frames[q].k[j * 3 + 1] * w; sw += w;
          ss += s * g; swc += g;
        }
        out[j * 3] = sx / sw; out[j * 3 + 1] = sy / sw; out[j * 3 + 2] = ss / swc;
      }
      sm[i] = out;
    }
    track.sm = sm;
    track.times = frames.map(f => f.t);
    // 30Hz の等間隔グリッドに再標本化
    const t0 = n ? frames[0].t : 0, t1 = n ? frames[n - 1].t : 0;
    const G = Math.max(1, Math.floor((t1 - t0) / DT) + 1);
    const X = [], Y = [], Sc = [];
    for (let j = 0; j < NK; j++) { X.push(new Float32Array(G)); Y.push(new Float32Array(G)); Sc.push(new Float32Array(G)); }
    const gt = new Float32Array(G);
    let p = 0;
    for (let g = 0; g < G; g++) {
      const t = t0 + g * DT; gt[g] = t;
      while (p < n - 2 && track.times[p + 1] < t) p++;
      const a = sm[p], b = sm[Math.min(p + 1, n - 1)];
      const ta = track.times[p], tb = track.times[Math.min(p + 1, n - 1)];
      const u = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
      for (let j = 0; j < NK; j++) {
        X[j][g] = a[j * 3] + (b[j * 3] - a[j * 3]) * u;
        Y[j][g] = a[j * 3 + 1] + (b[j * 3 + 1] - a[j * 3 + 1]) * u;
        Sc[j][g] = a[j * 3 + 2] + (b[j * 3 + 2] - a[j * 3 + 2]) * u;
      }
    }
    // 体幹長（肩の中点〜腰の中点）を長さの単位にする
    const torso = [];
    for (let g = 0; g < G; g++) {
      if (Math.min(Sc[5][g], Sc[6][g], Sc[11][g], Sc[12][g]) < 0.25) continue;
      const sx = (X[5][g] + X[6][g]) / 2, sy = (Y[5][g] + Y[6][g]) / 2;
      const hx = (X[11][g] + X[12][g]) / 2, hy = (Y[11][g] + Y[12][g]) / 2;
      torso.push(Math.hypot(sx - hx, sy - hy));
    }
    let T = median(torso);
    if (!Number.isFinite(T) || T < 5) T = Math.max(track.h, track.w) * 0.18;
    // 信号
    const hL = new Float32Array(G), hR = new Float32Array(G), h = new Float32Array(G);
    const sep = new Float32Array(G), ank = new Float32Array(G), shw = new Float32Array(G);
    for (let g = 0; g < G; g++) {
      const shy = (Y[5][g] + Y[6][g]) / 2;
      hL[g] = (shy - Y[9][g]) / T; hR[g] = (shy - Y[10][g]) / T; h[g] = (hL[g] + hR[g]) / 2;
      sep[g] = Math.hypot(X[9][g] - X[10][g], Y[9][g] - Y[10][g]) / T;
      ank[g] = Math.abs(X[15][g] - X[16][g]) / T;
      shw[g] = Math.abs(X[5][g] - X[6][g]) / T;
    }
    const speed = (j) => {
      const v = new Float32Array(G);
      for (let g = 0; g < G; g++) {
        const a = Math.max(0, g - 1), b = Math.min(G - 1, g + 1);
        v[g] = b > a ? Math.hypot(X[j][b] - X[j][a], Y[j][b] - Y[j][a]) / ((b - a) * DT) / T : 0;
      }
      return v;
    };
    track.grid = { t0, G, gt, X, Y, S: Sc };
    track.T = T;
    track.sig = { hL, hR, h, sep, ank, shw, vL: speed(9), vR: speed(10) };
    // 身長換算用: 鼻〜足首の縦距離（px）。身長の約 0.88 倍とみなす
    const stand = [];
    for (let g = 0; g < G; g++) {
      if (Math.min(Sc[0][g], Sc[15][g], Sc[16][g]) < 0.25) continue;
      stand.push((Y[15][g] + Y[16][g]) / 2 - Y[0][g]);
    }
    track.noseAnkle = percentile(stand, 0.7);
    return track;
  }

  function gIndex(track, t) { return clamp(Math.round((t - track.grid.t0) / DT), 0, track.grid.G - 1); }
  function kpAtGrid(track, g) {
    const { X, Y, S } = track.grid; const o = [];
    for (let j = 0; j < NK; j++) o.push({ x: X[j][g], y: Y[j][g], s: S[j][g] });
    return o;
  }
  // 平滑化済みフレームを時刻 t で線形補間（描画用）
  function kpAt(track, t) {
    const ts = track.times, n = ts.length;
    if (!n) return null;
    if (t <= ts[0] - 0.25 || t >= ts[n - 1] + 0.25) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    const a = track.sm[lo], b = track.sm[hi];
    const u = ts[hi] > ts[lo] ? clamp((t - ts[lo]) / (ts[hi] - ts[lo]), 0, 1) : 0;
    const o = [];
    for (let j = 0; j < NK; j++) o.push({ x: a[j * 3] + (b[j * 3] - a[j * 3]) * u, y: a[j * 3 + 1] + (b[j * 3 + 1] - a[j * 3 + 1]) * u, s: a[j * 3 + 2] + (b[j * 3 + 2] - a[j * 3 + 2]) * u });
    return o;
  }

  // ---------- 射法八節の自動区切り ----------
  function detectPhases(track) {
    const { G, gt } = track.grid; const sig = track.sig;
    if (G < 30) return null;
    const { h, vL, vR, sep, ank } = sig;
    const wOK = (g) => Math.min(track.grid.S[9][g], track.grid.S[10][g]) > 0.15;
    // 会の判定用: ±0.2 秒の長い基線で測った拳の速さ（細かな揺れに強い）
    const { X, Y, S } = track.grid; const Tn = track.T;
    const slow = (j, g) => { const a = Math.max(0, g - 6), b = Math.min(G - 1, g + 6); return b > a ? Math.hypot(X[j][b] - X[j][a], Y[j][b] - Y[j][a]) / ((b - a) * DT) / Tn : 0; };
    const vmax = new Float32Array(G);
    for (let g = 0; g < G; g++) {
      const okL = S[9][g] > 0.5, okR = S[10][g] > 0.5;
      const a = slow(9, g), b = slow(10, g);
      vmax[g] = okL && okR ? Math.max(a, b) : okL ? a : okR ? b : Math.max(a, b);
    }
    // 静止とみなす速さ。動画ごとの揺れの大きさに合わせて上げる
    const thr0 = Math.max(0.16, percentile(Array.from(vmax), 0.1) * 2.2);
    // 打起しの頂点: 両拳がもっとも高い所
    let iTop = -1, best = -Infinity;
    for (let g = 0; g < G; g++) if (wOK(g) && h[g] > best) { best = h[g]; iTop = g; }
    if (iTop < 0 || best < 0.35) return null;
    // 離れ: 頂点より後で馬手が最も速く動いた所
    let iPeak = -1, vp = 0;
    for (let g = iTop + 3; g < G; g++) if (vR[g] > vp) { vp = vR[g]; iPeak = g; }
    if (iPeak < 0 || vp < 0.8) return null;
    // 離れの候補: 前に静止（会）、後にも静止（残心）があり、直後に拳が大きく下がらない（弓倒しでない）山
    const nG = (sec) => Math.round(sec / DT);
    const meanV = (a, b) => { let m = 0, c = 0; for (let q = Math.max(0, a); q <= Math.min(G - 1, b); q++) { m += vmax[q]; c++; } return c ? m / c : Infinity; };
    let bestScore = -Infinity, cand = -1;
    for (let g = iTop + 3; g < G - 1; g++) {
      if (vR[g] < vp * 0.25 || vR[g] < vR[g - 1] || vR[g] < vR[g + 1]) continue;
      const dh = h[Math.min(G - 1, g + nG(0.8))] - h[Math.max(0, g - nG(0.3))];
      if (dh < -0.6) continue;
      const pre = meanV(g - nG(1.3), g - nG(0.35)), post = meanV(g + nG(0.45), g + nG(1.4));
      if (pre > thr0 * 1.3 || post > thr0 * 2) continue;
      if (vR[g] > bestScore) { bestScore = vR[g]; cand = g; }
    }
    if (cand >= 0) { iPeak = cand; vp = vR[cand]; }
    // 速度が最大値の半分を超えた瞬間を離れとする
    let iH = iPeak;
    while (iH > iTop && vR[iH - 1] > vp * 0.4) iH--;
    // 会: 離れの前、両拳がほぼ止まっている区間
    const thr = thr0;
    let g = iH - 1, over = 0, iKai = iH;
    while (g > iTop && vmax[g] > thr && iH - g < 12) g--; // 離れの立ち上がりを除く
    for (; g > iTop; g--) {
      if (vmax[g] < thr) { over = 0; iKai = g; }
      else if (++over * DT > 0.3) break;
    }
    const sepRef = sep[Math.max(iTop, iH - 4)];
    while (iKai < iH - 1 && sep[iKai] < sepRef * 0.88) iKai++;
    // 大三〜引分けの開始: 頂点のあと弓手が動き出す所
    let iDai = iTop;
    for (let q = iTop; q < iKai; q++) { if (vL[q] > 0.25 && vL[Math.min(q + 2, G - 1)] > 0.25) { iDai = q; break; } }
    // 打起しの開始: 頂点へ向かう連続した上昇の始まり
    const r = new Float32Array(G);
    for (let q = 0; q < G; q++) { const a = Math.max(0, q - 3), b = Math.min(G - 1, q + 3); r[q] = (h[b] - h[a]) / ((b - a) * DT || 1); }
    let hb = percentile(Array.from(h.slice(0, iTop + 1)), 0.15);
    const A = h[iTop] - hb;
    let g0 = iTop; while (g0 > 0 && h[g0] > h[iTop] - 0.15 * A) g0--;
    let cnt = 0, q = g0;
    for (; q > 0; q--) { if (r[q] < 0.12) { if (++cnt * DT >= 0.2) break; } else cnt = 0; }
    let iUchi = clamp(q + cnt, 0, iTop);
    // 残心の終わり: 拳が大きく下がった所（弓倒し）
    const iH5 = Math.min(G - 1, iH + Math.round(0.5 / DT));
    const hz = median(Array.from(h.slice(iH5, Math.min(G, iH + Math.round(1.3 / DT)))));
    let iEnd = G - 1;
    for (let q2 = iH5; q2 < G; q2++) { if (h[q2] < hz - 0.3) { iEnd = q2; break; } }
    let iHanEnd = Math.min(iEnd, iH + Math.round(0.35 / DT));
    // 足踏み: 足首の開きが落ち着くまで
    const ankFinal = median(Array.from(ank.slice(Math.max(0, iUchi - Math.round(2 / DT)), iUchi + 1)));
    let iAshi = 0;
    for (let q2 = 0; q2 < iUchi && ankFinal > 0.35; q2++) {
      if (ank[q2] >= ankFinal * 0.9) {
        let okk = true;
        for (let z = q2; z < Math.min(iUchi, q2 + Math.round(1 / DT)); z++) if (ank[z] < ankFinal * 0.85) { okk = false; break; }
        if (okk) { iAshi = q2; break; }
      }
    }
    if (iAshi * DT < 0.3) iAshi = 0;
    // 弓構え: 拳が腰から体の前へ上がる所
    let iYu = -1;
    const hRest = percentile(Array.from(h.slice(iAshi, Math.max(iAshi + 1, iUchi))), 0.1);
    for (let q2 = iAshi; q2 < iUchi; q2++) {
      if (h[q2] > hRest + 0.15) {
        let okk = true;
        for (let z = q2; z < Math.min(iUchi, q2 + Math.round(0.3 / DT)); z++) if (h[z] <= hRest + 0.15) { okk = false; break; }
        if (okk) { iYu = q2; break; }
      }
    }
    if (iYu < 0 || iYu <= iAshi) iYu = Math.round((iAshi + iUchi) / 2);
    const T = (i) => gt[clamp(i, 0, G - 1)];
    const bounds = [T(0), T(iAshi), T(iYu), T(iUchi), T(iDai), T(iKai), T(iH), T(iHanEnd), T(iEnd)];
    // 単調にそろえる
    for (let i = 1; i < bounds.length; i++) if (bounds[i] < bounds[i - 1]) bounds[i] = bounds[i - 1];
    return {
      bounds, // 9 個の境界 = 8 区間
      tTop: T(iTop), tHanare: T(iH), tKai: T(iKai), auto: true
    };
  }

  // 正面と馬手側の時刻合わせ: 馬手の高さの推移を相互相関で重ねる。馬手側の時刻 = 正面の時刻 − offset
  function syncOffset(front, side) {
    // 信頼度の低い所は 0 として相関に入れない
    const z = (tr) => {
      const v = tr.sig.hR, sc = tr.grid.S[10];
      const ok = Array.from(v, (q, i) => sc[i] > 0.3 && Number.isFinite(q));
      const vals = Array.from(v).filter((q, i) => ok[i]);
      if (vals.length < 10) return Array.from(v, () => 0);
      const m = vals.reduce((p, q) => p + q, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((p, q) => p + (q - m) * (q - m), 0) / vals.length) || 1;
      return Array.from(v, (q, i) => (ok[i] ? (q - m) / sd : 0));
    };
    const A = z(front), Bv = z(side);
    const fa = front.grid.t0, fb = side.grid.t0;
    let best = -Infinity, bestK = 0;
    const maxLag = Math.round(20 / DT);
    for (let k = -maxLag; k <= maxLag; k++) {
      // front[g] と side[g - k] を比べる
      let sum = 0, n = 0;
      for (let g = Math.max(0, k); g < A.length && g - k < Bv.length; g++) { sum += A[g] * Bv[g - k]; n++; }
      if (n * DT < 5) continue;
      const c = sum / n;
      if (c > best) { best = c; bestK = k; }
    }
    // front 時刻 fa + g*DT と side 時刻 fb + (g-k)*DT が対応
    let offset = fa - fb + bestK * DT;
    const pf = front.phasesAuto, ps = side.phasesAuto;
    let method = '動きの相関';
    if (pf && ps) {
      const o2 = pf.tHanare - ps.tHanare;
      if (Math.abs(o2 - offset) < 0.5) { offset = o2; method = '離れの瞬間'; }
    }
    return { offset, corr: best, method };
  }

  function evenPhases(t0, t1) {
    const b = []; for (let i = 0; i <= 8; i++) b.push(t0 + (t1 - t0) * i / 8);
    return { bounds: b, tTop: b[4], tHanare: b[6], tKai: b[5], auto: false };
  }
  function phaseAt(bounds, t) {
    if (!bounds) return -1;
    for (let i = 0; i < 8; i++) if (t >= bounds[i] && t < bounds[i + 1]) return i;
    return t >= bounds[8] ? 7 : -1;
  }


  // ---------- 2方向の合成（頭上ビュー） ----------
  // 正面の横位置 → X（的の方向が +）、馬手側の横位置 → Z（体の前が +）、高さは両方の重み付き平均。単位 cm、原点は足首の中点
  function fuseSetup(front, side, ph, offset, heightCm) {
    if (!front || !side || !ph) return null;
    const B = ph.bounds;
    const kaiA = B[5] + (B[6] - B[5]) * 0.15, kaiB = B[5] + (B[6] - B[5]) * 0.85;
    const sT = targetSign(front, kaiA, kaiB);
    const sF = facingSign(side, ph.tTop - offset);
    const cppF = heightCm * 0.88 / front.noseAnkle, cppS = heightCm * 0.88 / side.noseAnkle;
    if (!(cppF > 0) || !(cppS > 0)) return null;
    const s0 = B[1] + 0.2, s1 = Math.max(B[1] + 0.4, B[8]);
    const oF = { x: medOver(front, s0, s1, k => (k[15].x + k[16].x) / 2), y: medOver(front, s0, s1, k => (k[15].y + k[16].y) / 2) };
    const oS = { x: medOver(side, s0 - offset, s1 - offset, k => (k[15].x + k[16].x) / 2), y: medOver(side, s0 - offset, s1 - offset, k => (k[15].y + k[16].y) / 2) };
    // 区間が動画の外に出た時は、動画全体の足首の位置を使う
    const whole = (tr) => [tr.grid.gt[0], tr.grid.gt[tr.grid.G - 1]];
    if (!Number.isFinite(oF.x) || !Number.isFinite(oF.y)) { const [a, b] = whole(front); oF.x = medOver(front, a, b, k => (k[15].x + k[16].x) / 2); oF.y = medOver(front, a, b, k => (k[15].y + k[16].y) / 2); }
    if (!Number.isFinite(oS.x) || !Number.isFinite(oS.y)) { const [a, b] = whole(side); oS.x = medOver(side, a, b, k => (k[15].x + k[16].x) / 2); oS.y = medOver(side, a, b, k => (k[15].y + k[16].y) / 2); }
    if (![oF.x, oF.y, oS.x, oS.y].every(Number.isFinite)) return null;
    const fz = { sT, sF, cppF, cppS, oF, oS, offset, front, side };
    // 上腕・前腕の長さ: 2方向で信頼できる場面の中央値。身長からの目安の 0.85〜1.2 倍に収める
    const seg = { up: [], fo: [] };
    for (let t = s0; t <= s1; t += 0.1) {
      const p = pose3dRaw(fz, t); if (!p) continue;
      for (const [sh, el, wr] of [[5, 7, 9], [6, 8, 10]]) {
        if (Math.min(p[sh].s, p[el].s) > 0.35) seg.up.push(Math.hypot(p[el].x - p[sh].x, p[el].y - p[sh].y, p[el].z - p[sh].z));
        if (Math.min(p[el].s, p[wr].s) > 0.35) seg.fo.push(Math.hypot(p[wr].x - p[el].x, p[wr].y - p[el].y, p[wr].z - p[el].z));
      }
    }
    const fit = (vals, ref) => { const m = median(vals); return Number.isFinite(m) ? clamp(m, ref * 0.85, ref * 1.2) : ref; };
    fz.upper = fit(seg.up, heightCm * 0.186);
    fz.fore = fit(seg.fo, heightCm * 0.146);
    return fz;
  }
  // 肩と手首から、腕の長さを保つ肘の位置を求める（測った肘に一番近い所。測れない時は外側・後ろへ）
  function solveElbow(S, E, W, L1, L2, bias) {
    const d = { x: W.x - S.x, y: W.y - S.y, z: W.z - S.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (!(len > 1e-3)) return { ...E };
    const n = { x: d.x / len, y: d.y / len, z: d.z / len };
    if (len >= L1 + L2) return { x: S.x + n.x * L1, y: S.y + n.y * L1, z: S.z + n.z * L1, s: E.s };
    const L = Math.max(len, Math.abs(L1 - L2) + 1e-3);
    const a = (L1 * L1 - L2 * L2 + L * L) / (2 * L), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    let px = E.x - S.x + bias.x, py = E.y - S.y + bias.y, pz = E.z - S.z + bias.z;
    const pd = px * n.x + py * n.y + pz * n.z;
    px -= pd * n.x; py -= pd * n.y; pz -= pd * n.z;
    const pl = Math.hypot(px, py, pz) || 1;
    return { x: S.x + n.x * a + px / pl * h, y: S.y + n.y * a + py / pl * h, z: S.z + n.z * a + pz / pl * h, s: E.s };
  }
  // ---------- 1 本の動画から立体を推す ----------
  // 正面の動画なら前後、馬手側の動画なら的の方向が写らない。その向きの位置を、
  // 体の各部の長さ（身長と動画から）と、射法の形（どちらへ出るか）から推す。測った値ではない。
  function fuseSingle(track, view, ph, heightCm) {
    if (!track || !ph || !(track.noseAnkle > 10)) return null;
    const H = heightCm, cpp = H * 0.88 / track.noseAnkle;
    const whole = [track.grid.gt[0], track.grid.gt[track.grid.G - 1]];
    const s0 = ph.bounds[1] + 0.2, s1 = Math.max(ph.bounds[1] + 0.4, ph.bounds[8]);
    let o = { x: medOver(track, s0, s1, k => (k[15].x + k[16].x) / 2), y: medOver(track, s0, s1, k => (k[15].y + k[16].y) / 2) };
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) o = { x: medOver(track, ...whole, k => (k[15].x + k[16].x) / 2), y: medOver(track, ...whole, k => (k[15].y + k[16].y) / 2) };
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
    const B = ph.bounds, kaiA = B[5] + (B[6] - B[5]) * 0.15, kaiB = B[5] + (B[6] - B[5]) * 0.85;
    const fz = { single: view, track, H, cpp, o, ph };
    // 動画を立体に重ねる時に使う名前でも持っておく
    if (view === 'front') { fz.oF = o; fz.cppF = cpp; } else { fz.oS = o; fz.cppS = cpp; }
    if (view === 'front') fz.sT = targetSign(track, kaiA, kaiB); else fz.sF = facingSign(track, ph.tTop);
    // 骨の長さ: 身長からの目安と、動画で一番長く写った長さ（画面に沿った時）の大きい方
    const p95 = (a, b) => {
      const vals = [];
      for (let g = 0; g < track.grid.G; g += 2) { const k = kpAtGrid(track, g); if (Math.min(k[a].s, k[b].s) > 0.35) vals.push(Math.hypot(k[b].x - k[a].x, k[b].y - k[a].y) * cpp); }
      return percentile(vals, 0.95);
    };
    const len = (pairs, ref) => { const v = Math.max(...pairs.map(([a, b]) => p95(a, b)).filter(Number.isFinite), 0); return clamp(Math.max(v, ref * 0.9), ref * 0.9, ref * 1.25); };
    fz.L = {
      up: len([[5, 7], [6, 8]], H * 0.186), fo: len([[7, 9], [8, 10]], H * 0.146),
      th: len([[11, 13], [12, 14]], H * 0.245), sh: len([[13, 15], [14, 16]], H * 0.246),
      shW: H * 0.215, hipW: H * 0.13, earW: H * 0.085, nose: H * 0.06
    };
    fz.upper = fz.L.up; fz.fore = fz.L.fo;
    return fz;
  }
  const smooth01 = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  function pose3dSingle(fz, t) {
    const k = kpAt(fz.track, t); if (!k) return null;
    const c = fz.cpp, o = fz.o, L = fz.L, front = fz.single === 'front';
    const P = k.map(q => (front
      ? { x: (q.x - o.x) * c * fz.sT, y: (o.y - q.y) * c, z: 0, s: q.s }
      : { x: 0, y: (o.y - q.y) * c, z: (q.x - o.x) * c * fz.sF, s: q.s }));
    const d2 = (a, b) => (front ? Math.hypot(P[b].x - P[a].x, P[b].y - P[a].y) : Math.hypot(P[b].z - P[a].z, P[b].y - P[a].y));
    const rest = (len, a, b) => Math.sqrt(Math.max(0, len * len - d2(a, b) ** 2)); // 写らない向きの長さ
    const B = fz.ph.bounds, tH = fz.ph.tHanare;
    // 馬手の肘: 打起しまでは体の前、引分けで後ろへ回る。馬手の手首: 離れまでは内（顔の方）、離れで後ろへ振れる
    const draw = smooth01((t - B[4]) / Math.max(0.2, B[5] - B[4]));
    const rel = smooth01((t - tH) / 0.15);
    if (front) {
      // 前後（z, 前が +）。体幹と脚は正面を向いて画面に沿っているとみなす
      P[7].z = rest(L.up, 5, 7); P[9].z = P[7].z + rest(L.fo, 7, 9);
      P[8].z = (1 - 2 * draw) * rest(L.up, 6, 8); P[10].z = P[8].z + (1 - 2 * rel) * rest(L.fo, 8, 10);
      const hc = { x: (P[3].x + P[4].x) / 2, y: (P[3].y + P[4].y) / 2 };
      const nz = Math.sqrt(Math.max(0, L.nose * L.nose - (P[0].x - hc.x) ** 2 - (P[0].y - hc.y) ** 2));
      P[0].z = nz; P[1].z = P[2].z = nz * 0.85;
    } else {
      // 的の方向（x, 的が +）。弓手（左）側が的の方
      const half = (w, a, b) => rest(w, a, b) / 2;
      const hw = half(L.hipW, 11, 12), sw = half(L.shW, 5, 6), ew = half(L.earW, 3, 4);
      P[11].x = hw; P[12].x = -hw; P[5].x = sw; P[6].x = -sw; P[3].x = ew; P[4].x = -ew;
      P[13].x = P[11].x + rest(L.th, 11, 13); P[15].x = P[13].x + rest(L.sh, 13, 15);
      P[14].x = P[12].x - rest(L.th, 12, 14); P[16].x = P[14].x - rest(L.sh, 14, 16);
      // 弓手の前腕: 打起しまでは体の中心の方（内）、引分けからは的の方
      P[7].x = P[5].x + rest(L.up, 5, 7); P[9].x = P[7].x + (2 * draw - 1) * rest(L.fo, 7, 9);
      P[8].x = P[6].x - rest(L.up, 6, 8); P[10].x = P[8].x + (1 - 2 * rel) * rest(L.fo, 8, 10);
      const hc = { z: (P[3].z + P[4].z) / 2, y: (P[3].y + P[4].y) / 2 };
      const nx = Math.sqrt(Math.max(0, L.nose * L.nose - (P[0].z - hc.z) ** 2 - (P[0].y - hc.y) ** 2));
      P[0].x = nx; P[1].x = nx * 0.85 + ew * 0.4; P[2].x = nx * 0.85 - ew * 0.4;
      // 足首の中点を原点に
      const mx = (P[15].x + P[16].x) / 2; for (const q of P) q.x -= mx;
    }
    return P;
  }

  function pose3dAt(fz, t) {
    if (fz && fz.single) return pose3dSingle(fz, t);
    const p = pose3dRaw(fz, t);
    if (!p || !fz.upper) return p;
    // 測った肘が軸の上に来て向きが定まらない時のために、ごく小さく外側・後ろ寄りの癖を付ける
    p[8] = solveElbow(p[6], p[8], p[10], fz.upper, fz.fore, { x: -1.5, y: 0.3, z: -1.0 });
    p[7] = solveElbow(p[5], p[7], p[9], fz.upper, fz.fore, { x: 1.5, y: -0.6, z: 0.3 });
    return p;
  }
  function pose3dRaw(fz, t) {
    if (!fz) return null;
    const kf = kpAt(fz.front, t), ks = kpAt(fz.side, t - fz.offset);
    if (!kf || !ks) return null;
    return kf.map((pf, j) => {
      const ps = ks[j];
      const wf = Math.max(pf.s, 0.05), ws = Math.max(ps.s, 0.05);
      const yf = (fz.oF.y - pf.y) * fz.cppF, ys = (fz.oS.y - ps.y) * fz.cppS;
      return {
        x: (pf.x - fz.oF.x) * fz.cppF * fz.sT,
        y: (yf * wf + ys * ws) / (wf + ws),
        z: (ps.x - fz.oS.x) * fz.cppS * fz.sF,
        s: Math.min(pf.s, ps.s)
      };
    });
  }
  // 水平面での向き（的の方向 0°、前に向くと +）
  const axz = (a, b) => Math.atan2(b.z - a.z, b.x - a.x) * DEG;

  // ---------- 計測 ----------
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  // 水平に対する傾き。dirSign: 的（あるいは前）方向が +x なら 1
  function tilt(from, to, dirSign) { return Math.atan2(-(to.y - from.y), (to.x - from.x) * dirSign) * DEG; }
  function angleAt(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    return d ? Math.acos(clamp((v1x * v2x + v1y * v2y) / d, -1, 1)) * DEG : NaN;
  }
  function wrapDeg(a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }
  // 区間 [t0,t1] での中央値
  function medOver(track, t0, t1, fn) {
    if (!track || !(t1 > t0)) return NaN;
    const a = gIndex(track, t0), b = gIndex(track, t1);
    const vals = [];
    for (let g = a; g <= b; g++) { const v = fn(kpAtGrid(track, g), g); if (Number.isFinite(v)) vals.push(v); }
    return median(vals);
  }
  function posAt(track, t, j) { const g = gIndex(track, t); return { x: track.grid.X[j][g], y: track.grid.Y[j][g] }; }

  function targetSign(track, k0, k1) {
    // 正面: 弓手（左手首）がある側が的
    const v = medOver(track, k0, k1, k => k[9].x - k[10].x);
    return v >= 0 ? 1 : -1;
  }
  function facingSign(track, tTop) {
    // 馬手側: 打起しで拳が出ている側が体の前
    const v = medOver(track, tTop - 0.2, tTop + 0.2, k => (k[9].x + k[10].x) / 2 - (k[5].x + k[6].x) / 2);
    if (Number.isFinite(v) && Math.abs(v) > track.T * 0.08) return v >= 0 ? 1 : -1;
    const n = medOver(track, track.grid.gt[0], tTop, k => k[0].x - (k[3].x + k[4].x) / 2);
    return n >= 0 ? 1 : -1;
  }

  const fmt = (v, d = 1) => (Number.isFinite(v) ? (v > 0 && d >= 0 ? '+' : '') + v.toFixed(d) : '—');
  const fmtAbs = (v, d = 1) => (Number.isFinite(v) ? Math.abs(v).toFixed(d) : '—');

  // phases: マスター時刻の境界。offset: 馬手側の時刻 = マスター時刻 − offset
  function computeMetrics(opt) {
    const { front, side, ph, offset = 0, heightCm = 165, master = 'front' } = opt;
    const B = ph.bounds;
    const M = [];
    const add = (o) => { M.push(o); return o; };
    const kai0 = B[5], kai1 = B[6], tH = ph.tHanare;
    const kaiLen = tH - kai0;
    const kaiA = kai0 + (kai1 - kai0) * 0.15, kaiB = kai0 + (kai1 - kai0) * 0.85;
    const doz0 = B[1], doz1 = B[2];
    const dozA = doz1 - doz0 > 0.6 ? doz0 + 0.2 : B[2], dozB = doz1 - doz0 > 0.6 ? doz1 - 0.2 : B[3] - 0.2;

    add({ key: 'kaiLen', group: 'kai', view: master, label: '会の長さ', value: kaiLen, display: Number.isFinite(kaiLen) ? kaiLen.toFixed(1) + ' 秒' : '—',
      verdict: kaiLen < 2 ? '短め' : '十分', status: kaiLen < 2 ? 'warn' : 'ok', note: '引分けが止まってから離れまで。2秒未満は早気ぎみ', t: (kai0 + tH) / 2 });

    const cmPer = (track) => {
      // 1px あたりの cm
      if (!track || !Number.isFinite(track.noseAnkle) || track.noseAnkle < 10) return NaN;
      return heightCm * 0.88 / track.noseAnkle;
    };

    if (front) {
      const sT = targetSign(front, kaiA, kaiB);
      const lines = (k) => ({
        sh: tilt(k[6], k[5], sT), hip: tilt(k[12], k[11], sT), ank: tilt(k[16], k[15], sT)
      });
      const cross = (t0, t1, label, group, tJump) => {
        const sh = medOver(front, t0, t1, k => lines(k).sh), hp = medOver(front, t0, t1, k => lines(k).hip), an = medOver(front, t0, t1, k => lines(k).ank);
        const dev = Math.max(Math.abs(sh - hp), Math.abs(sh - an), Math.abs(hp - an));
        add({ key: 'cross_' + group, group, view: 'front', label, value: dev,
          display: `肩 ${fmt(sh)}° ／ 腰 ${fmt(hp)}° ／ 足 ${fmt(an)}°`,
          verdict: dev <= 3 ? '揃っている' : `ずれ ${dev.toFixed(1)}°`, status: dev <= 3 ? 'ok' : 'warn',
          note: '両肩・腰・足踏みの線が平行か（＋は弓手側が高い）', t: tJump });
      };
      const lean = (t0, t1, group, tJump) => {
        const v = medOver(front, t0, t1, k => { const s = mid(k[5], k[6]), hp = mid(k[11], k[12]); return Math.atan2((s.x - hp.x) * sT, -(s.y - hp.y)) * DEG; });
        const ok = Math.abs(v) <= 3;
        add({ key: 'leanLR_' + group, group, view: 'front', label: '胴の左右', value: v, display: `${v >= 0 ? '的側' : '的と反対側'}へ ${fmtAbs(v)}°`,
          verdict: ok ? '中胴' : (v > 0 ? '懸かる胴' : '退く胴'), status: ok ? 'ok' : 'warn',
          note: '縦線の左右の傾き。的側に傾くと懸かる、反対は退く', t: tJump });
      };
      // 足踏み・胴造り
      const ankR = medOver(front, dozA, dozB, k => Math.abs(k[15].x - k[16].x) / Math.max(1, Math.abs(k[5].x - k[6].x)));
      const cpf = cmPer(front);
      const ankCm = medOver(front, dozA, dozB, k => Math.abs(k[15].x - k[16].x)) * cpf;
      add({ key: 'ashiWidth', group: 'dozukuri', view: 'front', label: '足踏みの幅', value: ankR,
        display: Number.isFinite(ankCm) ? `約 ${Math.round(ankCm)} cm` : '—', verdict: Number.isFinite(ankR) ? `肩幅の ${ankR.toFixed(1)} 倍` : '', status: 'info',
        note: '左右の足首の間隔（身長から換算）。目安はつま先の間隔が自分の矢束', t: (dozA + dozB) / 2 });
      cross(dozA, dozB, '三重十文字', 'dozukuri', (dozA + dozB) / 2);
      lean(dozA, dozB, 'dozukuri', (dozA + dozB) / 2);

      // 打起し: 両拳の高さの差
      const tt = ph.tTop;
      const fistDy = medOver(front, tt - 0.25, tt + 0.25, k => k[10].y - k[9].y) * cpf; // +: 弓手が高い
      add({ key: 'uchiLevel', group: 'uchiokoshi', view: 'front', label: '両拳の水平', value: fistDy, display: Number.isFinite(fistDy) ? `${fistDy >= 0 ? '弓手' : '馬手'}が ${fmtAbs(fistDy, 0)} cm 高い` : '—',
        verdict: Math.abs(fistDy) <= 3 ? '水平' : (fistDy > 0 ? '弓手が高い' : '馬手が高い'), status: Math.abs(fistDy) <= 3 ? 'ok' : 'warn',
        note: '打起しの頂点での両拳の高さの差', t: tt });

      // 会
      const arrow = medOver(front, kaiA, kaiB, k => tilt(k[10], k[9], sT));
      add({ key: 'arrowTilt', group: 'kai', view: 'front', label: '矢の傾き（推定）', value: arrow, display: `矢先 ${arrow >= 0 ? '上' : '下'} ${fmtAbs(arrow)}°`,
        verdict: Math.abs(arrow) <= 2 ? '水平' : (arrow > 0 ? '矢先が上がる' : '矢先が下がる'), status: Math.abs(arrow) <= 2 ? 'ok' : 'warn',
        note: '両手首を結ぶ線から推定。矢そのものは検出していません', t: (kaiA + kaiB) / 2 });
      const shK = medOver(front, kaiA, kaiB, k => tilt(k[6], k[5], sT));
      const par = arrow - shK;
      add({ key: 'arrowShoulder', group: 'kai', view: 'front', label: '矢と肩の線', value: par, display: fmtAbs(par) + '° の差',
        verdict: Math.abs(par) <= 3 ? '平行' : '平行でない', status: Math.abs(par) <= 3 ? 'ok' : 'warn', note: '矢と両肩を結ぶ線が平行か', t: (kaiA + kaiB) / 2 });
      cross(kaiA, kaiB, '三重十文字', 'kai', (kaiA + kaiB) / 2);
      lean(kaiA, kaiB, 'kai', (kaiA + kaiB) / 2);
      const elb = medOver(front, kaiA, kaiB, k => angleAt(k[5], k[7], k[9]));
      add({ key: 'yunde', group: 'kai', view: 'front', label: '弓手の伸び', value: elb, display: Number.isFinite(elb) ? Math.round(elb) + '°' : '—',
        verdict: elb >= 165 ? '伸びている' : '肘が曲がる', status: elb >= 165 ? 'ok' : 'warn', note: '弓手の肘の角度（180°で一直線）', t: (kaiA + kaiB) / 2 });
      const melb = medOver(front, kaiA, kaiB, k => (k[6].y - k[8].y)) * cpf;
      add({ key: 'mElbow', group: 'kai', view: 'front', label: '馬手の肘の高さ', value: melb, display: Number.isFinite(melb) ? `肩より ${Math.abs(Math.round(melb))} cm ${melb >= 0 ? '上' : '下'}` : '—',
        verdict: '', status: 'info', note: '正面からは肘が体の陰になりやすく、目安です', t: (kaiA + kaiB) / 2 });
      // 伸び合いと緩み
      const sepAt = (t0, t1) => medOver(front, t0, t1, k => Math.hypot(k[9].x - k[10].x, k[9].y - k[10].y));
      const s0 = sepAt(kai0, Math.min(kai0 + 0.4, tH - 0.2)), s1 = sepAt(Math.max(kai0, tH - 0.5), tH - 0.15);
      const nobi = (s1 - s0) / s0 * 100;
      add({ key: 'nobiai', group: 'kai', view: 'front', label: '伸び合い', value: nobi, display: fmt(nobi) + ' %',
        verdict: nobi >= 0 ? '伸びている' : (nobi > -1 ? 'ほぼ一定' : '縮んでいる'), status: nobi > -1 ? 'ok' : 'warn',
        note: '会の始めと終わりで両拳の間隔がどう変わったか', t: (kai0 + tH) / 2 });
      let smax = -Infinity;
      for (let t = tH - 0.6; t <= tH - 0.1; t += DT) smax = Math.max(smax, sepAt(t, t + DT));
      const slack = (sepAt(tH - 0.1, tH - 0.03) - smax) / smax * 100;
      add({ key: 'yurumi', group: 'kai', view: 'front', label: '離れ直前の緩み', value: slack, display: fmt(slack) + ' %',
        verdict: slack < -1.5 ? '緩みあり' : '緩みなし', status: slack < -1.5 ? 'warn' : 'ok', note: '離れの直前に両拳の間隔が縮んだか', t: tH - 0.15 });

      // 離れ
      const p0r = posAt(front, tH - 0.08, 10), p1r = posAt(front, tH + 0.35, 10);
      const p0l = posAt(front, tH - 0.08, 9), p1l = posAt(front, tH + 0.35, 9);
      const awayAng = Math.atan2(-(p1r.y - p0r.y), -(p1r.x - p0r.x) * sT) * DEG; // 的と反対方向を 0° とした上下
      const relAng = wrapDeg(awayAng + arrow);
      const rDist = Math.hypot(p1r.x - p0r.x, p1r.y - p0r.y) * cpf;
      add({ key: 'mRelease', group: 'hanare', view: 'front', label: '馬手の抜ける方向', value: relAng,
        display: `矢筋より ${fmtAbs(relAng)}° ${relAng >= 0 ? '上' : '下'}`,
        verdict: Math.abs(relAng) <= 8 ? '矢筋どおり' : (relAng > 0 ? '上へ抜ける' : '下へ払う'), status: Math.abs(relAng) <= 8 ? 'ok' : 'warn',
        note: Number.isFinite(rDist) ? `離れで馬手が開いた距離 約 ${Math.round(rDist)} cm` : '', t: tH + 0.1 });
      const dxl = (p1l.x - p0l.x) * sT * cpf, dyl = -(p1l.y - p0l.y) * cpf;
      add({ key: 'yRelease', group: 'hanare', view: 'front', label: '弓手の動き', value: dyl,
        display: `${dyl >= 0 ? '上' : '下'} ${fmtAbs(dyl, 0)} cm ／ ${dxl >= 0 ? '的側' : '手前'} ${fmtAbs(dxl, 0)} cm`,
        verdict: Math.abs(dyl) <= 4 && Math.abs(dxl) <= 4 ? '小さい' : (Math.abs(dyl) >= Math.abs(dxl) ? (dyl < 0 ? '下へ' : '上へ') : (dxl > 0 ? '的側へ' : '手前へ')), status: 'info',
        note: '離れの前後 0.4 秒での弓手の移動', t: tH + 0.1 });
      const z0 = B[7], z1 = Math.min(B[8], B[7] + 1.5);
      const ichi = medOver(front, z0, z1, k => {
        const a1 = Math.atan2(k[9].y - k[5].y, k[9].x - k[5].x), a2 = Math.atan2(k[6].y - k[10].y, k[6].x - k[10].x);
        return Math.abs(wrapDeg((a1 - a2) * DEG));
      });
      const zt = medOver(front, z0, z1, k => tilt(k[10], k[9], sT));
      add({ key: 'zanshin', group: 'hanare', view: 'front', label: '残心の一文字', value: ichi, display: `折れ ${fmtAbs(ichi, 0)}° ／ 傾き ${fmtAbs(zt)}°`,
        verdict: ichi <= 12 ? '一文字' : '腕の線が折れる', status: ichi <= 12 ? 'ok' : 'warn', note: '両腕が肩を通って一直線か', t: (z0 + z1) / 2 });
    }

    if (side) {
      const o = offset;
      const sF = facingSign(side, ph.tTop - o);
      const cps = cmPer(side);
      const leanFB = (t0, t1, group, tj) => {
        const v = medOver(side, t0 - o, t1 - o, k => { const s = mid(k[5], k[6]), hp = mid(k[11], k[12]); return Math.atan2((s.x - hp.x) * sF, -(s.y - hp.y)) * DEG; });
        const ok = Math.abs(v) <= 3;
        add({ key: 'leanFB_' + group, group, view: 'side', label: '胴の前後', value: v, display: `${v >= 0 ? '前' : '後ろ'}へ ${fmtAbs(v)}°`,
          verdict: ok ? '中胴' : (v > 0 ? '屈む胴' : '反る胴'), status: ok ? 'ok' : 'warn', note: '縦線の前後の傾き。前に傾くと屈む、後ろは反る', t: tj });
      };
      leanFB(dozA, dozB, 'dozukuri', (dozA + dozB) / 2);
      const hipPos = medOver(side, dozA - o, dozB - o, k => (mid(k[11], k[12]).x - mid(k[15], k[16]).x) * sF) * cps;
      add({ key: 'hipPos', group: 'dozukuri', view: 'side', label: '腰の位置', value: hipPos, display: Number.isFinite(hipPos) ? `足首より ${Math.abs(Math.round(hipPos))} cm ${hipPos >= 0 ? '前' : '後ろ'}` : '—',
        verdict: Math.abs(hipPos) <= 6 ? '足の上' : (hipPos > 0 ? '前に出る' : '引けている'), status: Math.abs(hipPos) <= 6 ? 'ok' : 'warn', note: '腰の中心が足首の真上にあるか', t: (dozA + dozB) / 2 });
      const tt = ph.tTop - o;
      const elev = medOver(side, tt - 0.25, tt + 0.25, k => { const s = mid(k[5], k[6]), w = mid(k[9], k[10]); return Math.atan2(-(w.y - s.y), (w.x - s.x) * sF) * DEG; });
      add({ key: 'uchiAngle', group: 'uchiokoshi', view: 'side', label: '打起しの高さ', value: elev, display: Number.isFinite(elev) ? Math.round(elev) + '°' : '—',
        verdict: elev < 38 ? '低め' : (elev > 55 ? '高め' : '目安どおり'), status: elev < 38 || elev > 55 ? 'warn' : 'ok', note: '肩から拳への線が水平から何度上か。目安は約45°', t: ph.tTop });
      leanFB(kaiA, kaiB, 'kai', (kaiA + kaiB) / 2);
      const suji = medOver(side, kaiA - o, kaiB - o, k => (k[9].x - k[10].x) * sF) * cps;
      add({ key: 'yasuji', group: 'kai', view: 'side', label: '矢筋（推定）', value: suji, display: Number.isFinite(suji) ? `弓手が ${Math.abs(Math.round(suji))} cm ${suji >= 0 ? '前' : '後ろ'}` : '—',
        verdict: Math.abs(suji) <= 5 ? 'まっすぐ' : (suji > 0 ? '前を向く' : '後ろを向く'), status: Math.abs(suji) <= 5 ? 'ok' : 'warn',
        note: '馬手側から見た両拳の前後のずれ。カメラが矢の延長線上にある時に有効', t: (kaiA + kaiB) / 2 });
      const tHs = tH - o;
      const q0 = posAt(side, tHs - 0.08, 10), q1 = posAt(side, tHs + 0.35, 10);
      const fb = (q1.x - q0.x) * sF * cps, ud = -(q1.y - q0.y) * cps;
      add({ key: 'mReleaseSide', group: 'hanare', view: 'side', label: '馬手の抜け（前後）', value: fb,
        display: `${fb >= 0 ? '前' : '後ろ'} ${fmtAbs(fb, 0)} cm ／ ${ud >= 0 ? '上' : '下'} ${fmtAbs(ud, 0)} cm`,
        verdict: fb > 6 ? '前へ払う' : (fb < -15 ? '背中側へ大きく' : '矢筋の延長'), status: fb > 6 || fb < -15 ? 'warn' : 'ok', note: '矢の延長線上に抜けると前後の動きは小さい（肩の線へ開く分、少し後ろへ動く）', t: tH + 0.1 });
      const r0 = posAt(side, tHs - 0.08, 9), r1 = posAt(side, tHs + 0.35, 9);
      const lfb = (r1.x - r0.x) * sF * cps;
      add({ key: 'yReleaseSide', group: 'hanare', view: 'side', label: '弓手の振れ（前後）', value: lfb, display: `${lfb >= 0 ? '前' : '後ろ'} ${fmtAbs(lfb, 0)} cm`,
        verdict: Math.abs(lfb) <= 5 ? '小さい' : (lfb > 0 ? '前へ振れる' : '後ろへ振れる'), status: Math.abs(lfb) <= 5 ? 'ok' : 'warn', note: '離れの前後 0.4 秒での弓手の前後の移動', t: tH + 0.1 });
    }

    if (front && side) {
      const fz = fuseSetup(front, side, ph, offset, heightCm);
      const med3 = (t0, t1, fn) => {
        const vals = [];
        for (let t = t0; t <= t1; t += DT) { const p = pose3dAt(fz, t); if (p) { const v = fn(p); if (Number.isFinite(v)) vals.push(v); } }
        return median(vals);
      };
      if (fz) {
        const ref = med3(kaiA, kaiB, p => axz(p[16], p[15]));
        const twist = (a, b, label, key, note) => {
          const v = wrapDeg(med3(kaiA, kaiB, p => axz(p[a], p[b])) - ref);
          const ok = Math.abs(v) <= 5;
          add({ key, group: 'top', view: 'both', label, value: v, display: Number.isFinite(v) ? `${v >= 0 ? '弓手側' : '馬手側'}が前へ ${Math.abs(v).toFixed(1)}°` : '—',
            verdict: ok ? '足踏みと平行' : 'ねじれ', status: ok ? 'ok' : 'warn', note, t: (kaiA + kaiB) / 2 });
        };
        twist(6, 5, '肩の線（会）', 'top_sh', '頭上から見て、両肩の線が足踏みの線と平行か');
        twist(12, 11, '腰の線（会）', 'top_hip', '頭上から見て、腰の線が足踏みの線と平行か');
        const ar = wrapDeg(med3(kaiA, kaiB, p => axz(p[10], p[9])) - ref);
        add({ key: 'top_arrow', group: 'top', view: 'both', label: '矢の向き（会）', value: ar, display: Number.isFinite(ar) ? `矢先が${ar >= 0 ? '前' : '後ろ'}へ ${Math.abs(ar).toFixed(1)}°` : '—',
          verdict: Math.abs(ar) <= 3 ? 'まっすぐ' : (ar > 0 ? '前を向く' : '後ろを向く'), status: Math.abs(ar) <= 3 ? 'ok' : 'warn',
          note: '頭上から見た矢（推定）と足踏みの線の角度。矢所の前・後ろと見比べてください', t: (kaiA + kaiB) / 2 });
        const p0 = pose3dAt(fz, tH - 0.08), p1 = pose3dAt(fz, tH + 0.35), pk = pose3dAt(fz, (kaiA + kaiB) / 2);
        if (p0 && p1 && pk) {
          const dx = p1[10].x - p0[10].x, dz = p1[10].z - p0[10].z;
          const back = Math.atan2(-(pk[9].z - pk[10].z), -(pk[9].x - pk[10].x));
          const fwd = -wrapDeg((Math.atan2(dz, dx) - back) * DEG);
          add({ key: 'top_release', group: 'top', view: 'both', label: '馬手の離れ（頭上）', value: fwd,
            display: Number.isFinite(fwd) ? `矢筋より${fwd >= 0 ? '前' : '後ろ'}へ ${Math.abs(fwd).toFixed(0)}°` : '—',
            verdict: fwd > 8 ? '前へ払う' : (fwd < -25 ? '背中側へ大きく' : '矢筋の延長'), status: fwd > 8 || fwd < -25 ? 'warn' : 'ok',
            note: '肩の線へ開く分、少し後ろへ向かうのは自然です', t: tH + 0.1 });
        }
      }
    }
    return M;
  }

  // ---------- 矢所 ----------
  // 霞的（尺二）の外縁半径 cm と名称
  const KASUMI = [[3.6, '中白'], [7.2, '一の黒'], [10.2, '二の白'], [11.7, '二の黒'], [14.7, '三の白'], [18.0, '外黒']];
  function zoneOf(rcm) { for (const [r, n] of KASUMI) if (rcm <= r) return n; return '外れ'; }
  // calib: {cx,cy, rx (右端までの px), ry (上端までの px)}, marks: [{x,y}] 画像 px。rightIsMae: 写真の右が前
  function targetStats(calib, marks, rightIsMae = true) {
    if (!calib || !marks.length) return null;
    const pts = marks.map((m, i) => {
      const xcm = (m.x - calib.cx) / calib.rx * 18 * (rightIsMae ? 1 : -1); // +: 前
      const ycm = -(m.y - calib.cy) / calib.ry * 18; // +: 上
      const r = Math.hypot(xcm, ycm);
      let clock = Math.round(((Math.atan2(xcm * (rightIsMae ? 1 : -1), ycm) * DEG + 360) % 360) / 30);
      if (clock === 0) clock = 12;
      return { i: i + 1, xcm, ycm, r, zone: zoneOf(r), clock, hit: r <= 18 };
    });
    const cx = pts.reduce((a, p) => a + p.xcm, 0) / pts.length, cy = pts.reduce((a, p) => a + p.ycm, 0) / pts.length;
    const spread = pts.reduce((a, p) => a + Math.hypot(p.xcm - cx, p.ycm - cy), 0) / pts.length;
    return { pts, cx, cy, spread, hits: pts.filter(p => p.hit).length };
  }
  function dirWords(xcm, ycm) {
    const w = [];
    if (Math.abs(ycm) >= 1.5) w.push(ycm > 0 ? '上' : '下');
    if (Math.abs(xcm) >= 1.5) w.push(xcm > 0 ? '前' : '後ろ');
    return w.length ? w.join('・') : '中心付近';
  }

  // ---------- サンプル（合成データ） ----------
  function makeSample(noise = 1, seed = 7, step = 0.1) {
    const rnd = mulberry(seed);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const ease = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    // 手首のキーフレーム [時刻, 弓手, 馬手]  座標 m: X=的方向, Y=上, Z=体の前
    // [時刻, 弓手首, 馬手首, 弓手肘の目安, 馬手肘の目安]
    // 会では馬手の手首（関節）は肩のほぼ真上・口の高さ、肘は肩より外側・後ろ・やや上に引き収める
    const KF = [
      [0, [0.20, 0.93, 0.05], [-0.20, 0.91, 0.03], [0.24, 1.17, -0.02], [-0.24, 1.17, -0.04]],
      [6.0, [0.20, 0.93, 0.05], [-0.20, 0.91, 0.03], [0.24, 1.17, -0.02], [-0.24, 1.17, -0.04]],
      [7.6, [0.12, 1.08, 0.32], [-0.05, 1.05, 0.27], [0.36, 1.18, 0.12], [-0.36, 1.15, 0.12]],
      [11.0, [0.12, 1.08, 0.32], [-0.05, 1.05, 0.27], [0.36, 1.18, 0.12], [-0.36, 1.15, 0.12]],
      [13.4, [0.12, 1.83, 0.37], [-0.09, 1.81, 0.34], [0.36, 1.62, 0.16], [-0.36, 1.63, 0.14]],
      [14.2, [0.12, 1.83, 0.37], [-0.09, 1.81, 0.34], [0.36, 1.62, 0.16], [-0.36, 1.63, 0.14]],
      [15.8, [0.44, 1.73, 0.17], [-0.03, 1.79, 0.19], [0.40, 1.60, 0.06], [-0.40, 1.68, -0.02]],
      [16.4, [0.44, 1.73, 0.17], [-0.03, 1.79, 0.19], [0.40, 1.60, 0.06], [-0.40, 1.68, -0.02]],
      [19.2, [0.755, 1.475, 0.03], [-0.19, 1.51, -0.02], [0.47, 1.45, 0.01], [-0.42, 1.52, -0.15]],
      [23.6, [0.762, 1.474, 0.03], [-0.194, 1.51, -0.02], [0.47, 1.45, 0.01], [-0.42, 1.52, -0.15]],
      [23.72, [0.775, 1.452, 0.02], [-0.58, 1.535, -0.05], [0.48, 1.44, 0.01], [-0.42, 1.52, -0.10]],
      [24.0, [0.78, 1.445, 0.02], [-0.63, 1.54, -0.07], [0.48, 1.44, 0.01], [-0.42, 1.52, -0.06]],
      [27.2, [0.78, 1.44, 0.02], [-0.63, 1.53, -0.07], [0.48, 1.44, 0.01], [-0.42, 1.52, -0.06]],
      [29.0, [0.40, 1.05, 0.15], [-0.21, 0.92, 0.03], [0.30, 1.20, 0.0], [-0.25, 1.17, -0.04]],
      [30.0, [0.40, 1.05, 0.15], [-0.21, 0.92, 0.03], [0.30, 1.20, 0.0], [-0.25, 1.17, -0.04]]
    ];
    const wristAt = (t) => {
      let i = 0; while (i < KF.length - 2 && KF[i + 1][0] <= t) i++;
      const a = KF[i], b = KF[i + 1];
      const u = ease((t - a[0]) / (b[0] - a[0]));
      return [lerp3(a[1], b[1], u), lerp3(a[2], b[2], u), lerp3(a[3], b[3], u), lerp3(a[4], b[4], u)];
    };
    const elbowIK = (sh, wr, pole, L1 = 0.30, L2 = 0.28) => {
      const d = [wr[0] - sh[0], wr[1] - sh[1], wr[2] - sh[2]];
      const len = Math.min(Math.hypot(...d), L1 + L2 - 1e-3);
      const n = d.map(v => v / (Math.hypot(...d) || 1));
      const a = (L1 * L1 - L2 * L2 + len * len) / (2 * len);
      const hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const pd = pole[0] * n[0] + pole[1] * n[1] + pole[2] * n[2];
      let pp = [pole[0] - pd * n[0], pole[1] - pd * n[1], pole[2] - pd * n[2]];
      const pl = Math.hypot(...pp) || 1; pp = pp.map(v => v / pl);
      return [sh[0] + n[0] * a + pp[0] * hh, sh[1] + n[1] * a + pp[1] * hh, sh[2] + n[2] * a + pp[2] * hh];
    };
    const pose3d = (t) => {
      const lan = [0.08 + 0.32 * ease(t / 1.2), 0.08, 0], ran = [-0.08 - 0.32 * ease((t - 1.0) / 1.4), 0.08, 0];
      const draw = ease((t - 15.8) / 3.4) * (t < 27.2 ? 1 : 1 - ease((t - 27.2) / 1.8));
      const shiftX = -0.016 * draw, shiftZ = -0.010 * draw; // わずかに退く・反る
      const lsh = [0.19 + shiftX, 1.42 + 0.013 * draw, shiftZ], rsh = [-0.19 + shiftX, 1.42, shiftZ];
      const lhip = [0.13, 0.92, 0], rhip = [-0.13, 0.92, 0];
      const lkn = [(lan[0] + lhip[0]) / 2 + 0.02, 0.50, 0.02], rkn = [(ran[0] + rhip[0]) / 2 - 0.02, 0.50, 0.02];
      const [lwr, rwr, lh, rh] = wristAt(t);
      const lel = elbowIK(lsh, lwr, [lh[0] - lsh[0], lh[1] - lsh[1], lh[2] - lsh[2]]);
      const rel = elbowIK(rsh, rwr, [rh[0] - rsh[0], rh[1] - rsh[1], rh[2] - rsh[2]]);
      const th = ease((t - 9.6) / 1.0) * 70 / DEG * (t < 27.4 ? 1 : 1 - ease((t - 27.4) / 1.2));
      const rot = (p) => { const c = Math.cos(th), s = Math.sin(th); return [shiftX + p[0] * c + p[2] * s, 1.58 + p[1], shiftZ - p[0] * s + p[2] * c]; };
      const nose = rot([0, 0, 0.10]), leye = rot([0.035, 0.03, 0.08]), reye = rot([-0.035, 0.03, 0.08]);
      const lear = rot([0.075, 0.0, -0.01]), rear = rot([-0.075, 0.0, -0.01]);
      return [nose, leye, reye, lear, rear, lsh, rsh, lel, rel, lwr, rwr, lhip, rhip, lkn, rkn, lan, ran];
    };
    const W = 720, H = 1280, sc = 430;
    const proj = (view, p) => view === 'front'
      ? [330 + p[0] * sc, 1130 - p[1] * sc]
      : [300 + p[2] * sc, 1130 - p[1] * sc]; // 馬手側: 体の前が画面の右
    const hidden = (view, j) => view === 'side' && [1, 3, 5, 7, 9, 11, 13, 15].includes(j);
    const mk = (view, tOffset) => {
      const times = [];
      for (let t = 0.05; t < 29.9 - tOffset; t += step) times.push(t);
      const tH = 23.62 - tOffset;
      if (step > 0.05) for (let t = tH - 0.6; t <= tH + 0.6; t += 1 / 30) times.push(t);
      const frames = times.map((t) => {
        const P = pose3d(t + tOffset); const k = [];
        P.forEach((p, j) => {
          const [x, y] = proj(view, p);
          const hid = hidden(view, j);
          const sd = (hid ? 6 : 2.2) * noise;
          k.push(x + gauss() * sd, y + gauss() * sd, hid ? 0.35 + rnd() * 0.15 : 0.78 + rnd() * 0.17);
        });
        return { t, k };
      });
      return { view, w: W, h: H, duration: 29.9 - tOffset, frames, sample: true };
    };
    const target = {
      w: 900, h: 900, rightIsMae: true,
      calib: { cx: 452, cy: 446, rx: 330, ry: 312 },
      marksCm: [[3.2, 2.4], [5.6, -1.4], [-1.8, 4.6], [9.4, 1.1]]
    };
    target.marks = target.marksCm.map(([x, y]) => ({ x: target.calib.cx + x / 18 * target.calib.rx, y: target.calib.cy - y / 18 * target.calib.ry }));
    return { front: mk('front', 0), side: mk('side', 1.3), sideOffset: 1.3, target };
  }



  // ---------- 手の内・ひねり（弓手と馬手の接写） ----------
  // 時刻はすべて「実時間の秒」。スロー撮影の動画は、動画の時刻 ÷ スロー倍率 で実時間に直してから渡す
  // 弓手: 手の 21 点 {t, k:[x,y,z]*21, p}   0 手首, 1-4 親指, 5-8 人差し指, 9-12 中指, 13-16 薬指, 17-20 小指
  // 馬手: 目印 3 つ {t, m:[x,y,ok]*3}       0 黄（甲・人差し指側）, 1 青（甲・小指側）, 2 緑（手首）
  const HAND_EDGES = [[0, 1, 't'], [1, 2, 't'], [2, 3, 't'], [3, 4, 't'], [0, 5, 'p'], [5, 6, 'f'], [6, 7, 'f'], [7, 8, 'f'], [5, 9, 'p'], [9, 10, 'f'], [10, 11, 'f'], [11, 12, 'f'], [9, 13, 'p'], [13, 14, 'f'], [14, 15, 'f'], [15, 16, 'f'], [13, 17, 'p'], [0, 17, 'p'], [17, 18, 'f'], [18, 19, 'f'], [19, 20, 'f']];
  const TPH = [{ key: 'pre', name: '引分け' }, { key: 'kai', name: '会' }, { key: 'hanare', name: '離れ' }, { key: 'zanshin', name: '残心' }];
  function unwrapDeg(arr) {
    const out = new Float32Array(arr.length); let off = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i) { const d = arr[i] + off - out[i - 1]; if (d > 180) off -= 360; else if (d < -180) off += 360; }
      out[i] = arr[i] + off;
    }
    return out;
  }
  function prepareClose(track) {
    const yunde = track.kind === 'yunde';
    const fr = track.frames.filter(f => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
    const frames = [];
    for (const f of fr) if (!frames.length || f.t - frames[frames.length - 1].t > 1e-5) frames.push(f);
    track.frames = frames;
    const n = frames.length, C = yunde ? 63 : 6;
    const val = yunde ? (f, j) => f.k[j] : (f, j) => f.m[(j >> 1) * 3 + (j & 1)];
    const wt = yunde ? (f) => Math.max(f.p, 0.02) * Math.max(f.p, 0.02) : null;
    const okj = (f, j) => (f.m[(j >> 1) * 3 + 2] ? 1 : 0.0005);
    // 時間の細かさ: 一番細かく解析した所のコマの間隔
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(frames[i].t - frames[i - 1].t);
    let dt = clamp(percentile(gaps, 0.1) || 1 / 30, 1 / 480, 1 / 30);
    const t0 = n ? frames[0].t : 0, t1 = n ? frames[n - 1].t : 0;
    if ((t1 - t0) / dt > 20000) dt = (t1 - t0) / 20000;
    const sigma = Math.max(0.01, dt * 1.3), win = sigma * 2.5;
    const sm = new Array(n);
    let lo = 0;
    for (let i = 0; i < n; i++) {
      const t = frames[i].t;
      while (frames[lo].t < t - win) lo++;
      const out = new Float32Array(C + 1), acc = new Float64Array(C), sw = new Float64Array(C);
      let cs = 0, cg = 0;
      for (let q = lo; q < n && frames[q].t <= t + win; q++) {
        const d = frames[q].t - t, g = Math.exp(-d * d / (2 * sigma * sigma)), f = frames[q];
        if (yunde) { const w = g * wt(f); for (let j = 0; j < C; j++) { acc[j] += f.k[j] * w; sw[j] += w; } cs += f.p * g; }
        else { for (let j = 0; j < C; j++) { const w = g * okj(f, j); acc[j] += val(f, j) * w; sw[j] += w; } cs += (f.m[2] + f.m[5] + f.m[8]) / 3 * g; }
        cg += g;
      }
      for (let j = 0; j < C; j++) out[j] = acc[j] / sw[j];
      out[C] = cs / cg;
      sm[i] = out;
    }
    track.sm = sm; track.times = frames.map(f => f.t);
    const G = Math.max(1, Math.floor((t1 - t0) / dt) + 1);
    const gt = new Float32Array(G), V = [];
    for (let j = 0; j <= C; j++) V.push(new Float32Array(G));
    let p = 0;
    for (let g = 0; g < G; g++) {
      const t = t0 + g * dt; gt[g] = t;
      while (p < n - 2 && track.times[p + 1] < t) p++;
      const a = sm[p], b = sm[Math.min(p + 1, n - 1)], ta = track.times[p], tb = track.times[Math.min(p + 1, n - 1)];
      const u = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
      for (let j = 0; j <= C; j++) V[j][g] = a[j] + (b[j] - a[j]) * u;
    }
    track.grid = { t0, G, gt, V, dt, C };
    // 手の大きさの基準、中心の速さ、向きの回る速さ
    const X = (j, g) => V[j * (yunde ? 3 : 2)][g], Y = (j, g) => V[j * (yunde ? 3 : 2) + 1][g];
    const cx = new Float32Array(G), cy = new Float32Array(G), oriRaw = new Float32Array(G), sizes = [];
    for (let g = 0; g < G; g++) {
      if (yunde) {
        cx[g] = (X(0, g) + X(5, g) + X(9, g) + X(13, g) + X(17, g)) / 5; cy[g] = (Y(0, g) + Y(5, g) + Y(9, g) + Y(13, g) + Y(17, g)) / 5;
        oriRaw[g] = Math.atan2(-(Y(17, g) - Y(5, g)), X(17, g) - X(5, g)) * DEG;
        if (V[C][g] > 0.5) sizes.push(Math.hypot(X(9, g) - X(0, g), Y(9, g) - Y(0, g)));
      } else {
        cx[g] = (X(0, g) + X(1, g) + X(2, g)) / 3; cy[g] = (Y(0, g) + Y(1, g) + Y(2, g)) / 3;
        oriRaw[g] = Math.atan2(-(Y(1, g) - Y(0, g)), X(1, g) - X(0, g)) * DEG;
        if (V[C][g] > 0.6) sizes.push(Math.hypot(X(1, g) - X(0, g), Y(1, g) - Y(0, g)));
      }
    }
    let S = median(sizes);
    if (!Number.isFinite(S) || S < 3) S = Math.min(track.w, track.h) * 0.12;
    const ori = unwrapDeg(oriRaw);
    const hw = Math.max(1, Math.round(0.025 / dt));
    const sp = new Float32Array(G), av = new Float32Array(G);
    for (let g = 0; g < G; g++) {
      const a = Math.max(0, g - hw), b = Math.min(G - 1, g + hw), d = (b - a) * dt || 1;
      sp[g] = Math.hypot(cx[b] - cx[a], cy[b] - cy[a]) / d / S;
      av[g] = Math.abs(ori[b] - ori[a]) / d; // 度/秒
    }
    track.S = S; track.sig = { cx, cy, ori, sp, av };
    track.dt = dt;
    return track;
  }
  function cIndex(track, t) { const gr = track.grid; return clamp(Math.round((t - gr.t0) / gr.dt), 0, gr.G - 1); }
  function closeGrid(track, g) {
    const gr = track.grid, V = gr.V;
    if (track.kind === 'yunde') { const o = []; for (let j = 0; j < 21; j++) o.push({ x: V[j * 3][g], y: V[j * 3 + 1][g], z: V[j * 3 + 2][g] }); o.p = V[63][g]; return o; }
    const o = []; for (let j = 0; j < 3; j++) o.push({ x: V[j * 2][g], y: V[j * 2 + 1][g] }); o.p = V[6][g]; return o;
  }
  function closeAt(track, t) {
    const ts = track.times, n = ts.length;
    if (!n || t < ts[0] - 0.1 || t > ts[n - 1] + 0.1) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    const a = track.sm[lo], b = track.sm[hi], u = ts[hi] > ts[lo] ? clamp((t - ts[lo]) / (ts[hi] - ts[lo]), 0, 1) : 0;
    const L = (j) => a[j] + (b[j] - a[j]) * u;
    if (track.kind === 'yunde') { const o = []; for (let j = 0; j < 21; j++) o.push({ x: L(j * 3), y: L(j * 3 + 1), z: L(j * 3 + 2) }); o.p = L(63); return o; }
    const o = []; for (let j = 0; j < 3; j++) o.push({ x: L(j * 2), y: L(j * 2 + 1) }); o.p = L(6);
    // 目印ごとの見えている度合い（最寄りのコマ）
    const f = track.frames[u < 0.5 ? lo : hi];
    o.ok = [f.m[2], f.m[5], f.m[8]];
    return o;
  }
  // 離れ: 手が急に動いたり回ったりした瞬間。会: その前に手が止まっている区間
  function detectClosePhases(track) {
    const gr = track.grid, { G, gt, dt } = gr, { sp, av } = track.sig;
    if (G < 10) return null;
    const sc = new Float32Array(G);
    for (let g = 0; g < G; g++) sc[g] = sp[g] + 0.5 * av[g] / DEG;
    const g0 = Math.min(G - 1, Math.round(0.3 / dt));
    let iP = -1, best = 0;
    for (let g = g0; g < G; g++) if (sc[g] > best) { best = sc[g]; iP = g; }
    if (iP < 0 || best < 1.2) return null;
    let iH = iP; while (iH > 0 && sc[iH - 1] > best * 0.3) iH--;
    const thr = Math.max(0.35, percentile(Array.from(sc), 0.1) * 3);
    let g = iH - 1, over = 0, iK = iH;
    const back = Math.round(0.2 / dt);
    while (g > 0 && sc[g] > thr && iH - g < back) g--;
    for (; g >= 0; g--) {
      if (sc[g] < thr) { over = 0; iK = g; } else if (++over * dt > 0.25) break;
      if ((iH - g) * dt > 12) break;
    }
    const T = (i) => gt[clamp(i, 0, G - 1)];
    return { tStart: gt[0], tKai: T(iK), tHanare: T(iH), tEnd: gt[G - 1], auto: true };
  }
  function closePhaseAt(ph, t) {
    if (!ph) return -1;
    if (t < ph.tKai) return 0;
    if (t < ph.tHanare) return 1;
    if (t < ph.tHanare + 0.3) return 2;
    return 3;
  }
  // 区間の中央値・標準偏差・最大値
  function cmed(track, t0, t1, fn) { if (!(t1 > t0)) return NaN; const v = []; for (let g = cIndex(track, t0); g <= cIndex(track, t1); g++) { const x = fn(g); if (Number.isFinite(x)) v.push(x); } return median(v); }
  function csd(track, t0, t1, fn) { const v = []; for (let g = cIndex(track, t0); g <= cIndex(track, t1); g++) { const x = fn(g); if (Number.isFinite(x)) v.push(x); } if (v.length < 2) return NaN; const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); }
  function cmax(track, t0, t1, fn) { let m = -Infinity, at = NaN; for (let g = cIndex(track, t0); g <= cIndex(track, t1); g++) { const x = fn(g); if (x > m) { m = x; at = track.grid.gt[g]; } } return { v: m, t: at }; }
  const ms = (s) => Math.round(s * 1000);
  // 窓の取り方（会の前半・後半、離れの後）
  function windows(ph) {
    const span = Math.max(0.2, ph.tHanare - ph.tKai);
    const kA = ph.tKai + span * 0.15, kB = Math.max(kA + 0.02, ph.tHanare - Math.min(0.12, span * 0.2));
    return { kA, kB, early: [kA, kA + (kB - kA) * 0.25], late: [kB - (kB - kA) * 0.25, kB], pre: [ph.tHanare - 0.06, ph.tHanare - 0.015], post: [Math.min(ph.tEnd, ph.tHanare + 0.15), Math.min(ph.tEnd, ph.tHanare + 0.25)] };
  }
  const fineEnough = (track, need) => track.dt <= need + 1e-9;

  // 弓手。sT: 的の方向が画面の +x なら 1（会で親指の先がある側）
  function yundeMetrics(track, ph, opt = {}) {
    const M = [];
    if (!track || !ph) return M;
    const add = (o) => { o.side = 'yunde'; M.push(o); };
    const W = windows(ph), { kA, kB } = W;
    const vals = [];
    for (let g = cIndex(track, kA); g <= cIndex(track, kB); g++) { const k = closeGrid(track, g); vals.push(k[4].x - k[2].x); }
    const sT = (median(vals) >= 0 ? 1 : -1) * (opt.flip ? -1 : 1);
    track.sT = sT;
    const cpp = (opt.heightCm || 165) * 0.05 / track.S;
    const ang = (a, b) => Math.atan2(-(b.y - a.y), (b.x - a.x) * sT) * DEG;
    const K = (g) => closeGrid(track, g);
    const thumbA = (g) => { const k = K(g); return ang(k[2], k[4]); };
    const backA = (g) => { const k = K(g); return ang(k[0], k[9]); };
    const knA = (g) => { const k = K(g); return Math.atan2((k[17].x - k[5].x) * sT, k[17].y - k[5].y) * DEG; };
    const ud = (v) => (v >= 0 ? '上' : '下');
    const tk = (kA + kB) / 2, ta = (W.post[0] + W.post[1]) / 2;
    const thumb = cmed(track, kA, kB, thumbA);
    add({ key: 'y_thumb', group: 'y_kai', label: '角見（親指）の向き', value: thumb, display: `的の方向から${ud(thumb)}へ ${Math.abs(thumb).toFixed(1)}°`,
      verdict: Math.abs(thumb) <= 10 ? '的の方向' : (thumb > 0 ? '上を向く' : '下を向く'), status: Math.abs(thumb) <= 10 ? 'ok' : 'warn', note: '親指の付け根から先への線。目安は的の方向へまっすぐ', t: tk });
    const back = cmed(track, kA, kB, backA);
    add({ key: 'y_back', group: 'y_kai', label: '手首の折れ（手の甲）', value: back, display: `${ud(back)}へ ${Math.abs(back).toFixed(1)}°`,
      verdict: Math.abs(back) <= 12 ? 'まっすぐ' : (back > 0 ? '上を向く' : '下を向く'), status: Math.abs(back) <= 12 ? 'ok' : 'warn', note: '手首から中指の付け根への線。腕がほぼ水平な時の手首の折れの目安', t: tk });
    const open = cmed(track, kA, kB, (g) => { const k = K(g); const a = Math.atan2(k[4].y - k[2].y, k[4].x - k[2].x), b = Math.atan2(k[8].y - k[5].y, k[8].x - k[5].x); return Math.abs(wrapDeg((a - b) * DEG)); });
    add({ key: 'y_open', group: 'y_kai', label: '虎口の開き', value: open, display: Number.isFinite(open) ? `親指と人差し指 ${Math.round(open)}°` : '—', verdict: '', status: 'info', note: '人差し指の向きは流派で違うので参考', t: tk });
    const curl = cmed(track, kA, kB, (g) => { const k = K(g); return (angleAt(k[9], k[10], k[11]) + angleAt(k[13], k[14], k[15]) + angleAt(k[17], k[18], k[19])) / 3; });
    add({ key: 'y_curl', group: 'y_kai', label: '中指・薬指・小指の締め', value: curl, display: Number.isFinite(curl) ? `第二関節 平均 ${Math.round(curl)}°` : '—', verdict: '', status: 'info', note: '180°でまっすぐ。弓の陰の指は推定なので参考', t: tk });
    const tilt = cmed(track, kA, kB, knA);
    add({ key: 'y_tilt', group: 'y_kai', label: '指の付け根の線', value: tilt, display: `${tilt >= 0 ? '小指側が的の方へ' : '小指側が手前へ'} ${Math.abs(tilt).toFixed(1)}°`, verdict: '', status: 'info', note: '人差し指と小指の付け根を結ぶ線の、鉛直からの傾き', t: tk });
    const jit = csd(track, kA, kB, thumbA);
    add({ key: 'y_jit', group: 'y_kai', label: '会の間の角見のぶれ', value: jit, display: `標準偏差 ${jit.toFixed(1)}°`, verdict: jit <= 2.5 ? '安定' : 'ぶれあり', status: jit <= 2.5 ? 'ok' : 'warn', note: '会の間に親指の向きがどれだけ揺れたか', t: tk });
    // 離れの直前
    if (fineEnough(track, 1 / 50)) {
      const pre = cmed(track, ph.tHanare - 0.3, ph.tHanare - 0.15, thumbA) , just = cmed(track, ph.tHanare - 0.05, ph.tHanare - 0.01, thumbA);
      const d = just - pre;
      add({ key: 'y_prerel', group: 'y_hanare', label: '離れの直前の動き', value: d, display: Number.isFinite(d) ? `親指が${ud(d)}へ ${Math.abs(d).toFixed(1)}°（離れの 0.3〜0.01 秒前）` : '—',
        verdict: Math.abs(d) <= 3 ? '動いていない' : '離れの前に動き始めている', status: Math.abs(d) <= 3 ? 'ok' : 'warn', note: '離れの前に手の内が崩れ始めていないか', t: ph.tHanare - 0.1 });
    }
    if (W.post[1] > W.post[0]) {
      const dT = cmed(track, W.post[0], W.post[1], thumbA) - cmed(track, W.pre[0], W.pre[1], thumbA);
      add({ key: 'y_dthumb', group: 'y_hanare', label: '角見の変化', value: dT, display: `${ud(dT)}へ ${Math.abs(dT).toFixed(1)}°`,
        verdict: Math.abs(dT) <= 10 ? '保たれている' : (dT < 0 ? '下へ振れる' : '上へ振れる'), status: Math.abs(dT) <= 10 ? 'ok' : 'warn', note: '離れの直前と 0.15〜0.25 秒後の親指の向きの差', t: ta });
      const dB = cmed(track, W.post[0], W.post[1], backA) - cmed(track, W.pre[0], W.pre[1], backA);
      add({ key: 'y_dback', group: 'y_hanare', label: '手首の変化', value: dB, display: `${ud(dB)}へ ${Math.abs(dB).toFixed(1)}°`,
        verdict: Math.abs(dB) <= 12 ? '保たれている' : (dB < 0 ? '手首が下がる' : '手首が上がる'), status: Math.abs(dB) <= 12 ? 'ok' : 'warn', note: '離れで手首の角度が崩れたか', t: ta });
      const dK = wrapDeg(cmed(track, W.post[0], W.post[1], knA) - cmed(track, W.pre[0], W.pre[1], knA));
      add({ key: 'y_turn', group: 'y_hanare', label: '手の内の回り', value: dK, display: `${dK >= 0 ? '小指側が的の方へ' : '小指側が手前へ'} ${Math.abs(dK).toFixed(1)}°`,
        verdict: Math.abs(dK) <= 15 ? '小さい' : '大きく回る', status: Math.abs(dK) <= 15 ? 'ok' : 'warn', note: '指の付け根の線が離れでどれだけ回ったか', t: ta });
      if (fineEnough(track, 1 / 90)) {
        const ori = track.sig.ori, dt = track.dt, hw = Math.max(1, Math.round(0.01 / dt));
        const angv = (g) => { const a = Math.max(0, g - hw), b = Math.min(track.grid.G - 1, g + hw); return Math.abs(ori[b] - ori[a]) / ((b - a) * dt || 1); };
        const mx = cmax(track, ph.tHanare - 0.02, Math.min(ph.tEnd, ph.tHanare + 0.3), angv);
        let tStop = NaN;
        for (let g = cIndex(track, mx.t); g < track.grid.G; g++) if (angv(g) < mx.v * 0.1) { tStop = track.grid.gt[g]; break; }
        add({ key: 'y_vmax', group: 'y_hanare', label: '回りの最大の速さ', value: mx.v, display: `${Math.round(mx.v).toLocaleString()}°/秒`, verdict: '', status: 'info', note: '離れで手の内が一番速く回った時の速さ', t: mx.t });
        if (Number.isFinite(tStop)) add({ key: 'y_settle', group: 'y_hanare', label: '回りが収まるまで', value: tStop - ph.tHanare, display: `${ms(tStop - ph.tHanare)} ミリ秒`, verdict: '', status: 'info', note: '離れから、回りの速さが最大の 1 割に落ちるまで', t: tStop });
      } else {
        add({ key: 'y_vmax', group: 'y_hanare', label: '回りの最大の速さ', value: NaN, display: '—', verdict: '', status: 'info', note: 'スロー撮影（実時間で毎秒 120 コマ以上）で測れます', t: ph.tHanare });
      }
      const c = (k) => ({ x: (k[0].x + k[5].x + k[9].x + k[13].x + k[17].x) / 5, y: (k[0].y + k[5].y + k[9].y + k[13].y + k[17].y) / 5 });
      const c0 = c(K(cIndex(track, ph.tHanare - 0.03))), c1 = c(K(cIndex(track, Math.min(ph.tEnd, ph.tHanare + 0.4))));
      const dx = (c1.x - c0.x) * sT * cpp, dy = -(c1.y - c0.y) * cpp, dist = Math.hypot(dx, dy);
      add({ key: 'y_move', group: 'y_hanare', label: '弓手の振れ', value: dist, display: `${ud(dy)} ${Math.abs(dy).toFixed(0)} cm ／ ${dx >= 0 ? '的側' : '手前'} ${Math.abs(dx).toFixed(0)} cm`,
        verdict: dist <= 3 ? '小さい' : (Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? '下へ' : '上へ') : (dx > 0 ? '的側へ' : '手前へ')), status: dist <= 6 ? (dist <= 3 ? 'ok' : 'info') : 'warn', note: '離れの前後 0.4 秒での手のひらの中心の移動（身長から換算）', t: ph.tHanare + 0.2 });
    }
    return M;
  }

  // 馬手（目印）。角度は後ろから見た画面で、反時計回りを＋（右手を後ろから見ると、内へ捻る向き）
  function meteMetrics(track, ph, opt = {}) {
    const M = [];
    if (!track || !ph) return M;
    const add = (o) => { o.side = 'mete'; M.push(o); };
    const W = windows(ph), { kA, kB } = W, sig = track.sig;
    const cpp = (opt.spacingCm || 5) / track.S;
    const th = (g) => sig.ori[g];
    const io = (v) => (v >= 0 ? '内へ' : '外へ');
    const tk = (kA + kB) / 2;
    const theta = cmed(track, kA, kB, th);
    const thN = wrapDeg(theta);
    add({ key: 'm_twist', group: 'm_kai', label: '会の捻りの角度', value: thN, display: `甲の線：小指側が${thN >= 0 ? '上' : '下'}へ ${Math.abs(thN).toFixed(1)}°`, verdict: '', status: 'info', note: '黄（人差し指側）から青（小指側）への線の、水平からの傾き。カメラを水平に置いた時の値', t: tk });
    const d = cmed(track, W.late[0], W.late[1], th) - cmed(track, W.early[0], W.early[1], th);
    add({ key: 'm_drift', group: 'm_kai', label: '会の間の捻りの変化', value: d, display: `${io(d)} ${Math.abs(d).toFixed(1)}°`,
      verdict: Math.abs(d) <= 3 ? '保たれている' : (d < 0 ? '捻りが戻る（緩み）' : '捻りが強まる'), status: Math.abs(d) <= 3 ? 'ok' : (d < 0 ? 'warn' : 'info'), note: '会の始めと終わりの差。外へ＝捻りが戻る向き', t: tk });
    const jit = csd(track, kA, kB, th);
    add({ key: 'm_jit', group: 'm_kai', label: '会の間のぶれ', value: jit, display: `標準偏差 ${jit.toFixed(1)}°`, verdict: jit <= 2 ? '安定' : 'ぶれあり', status: jit <= 2 ? 'ok' : 'warn', note: '会の間に甲の向きがどれだけ揺れたか', t: tk });
    const V = track.grid.V;
    const wrist = (g) => { const mx = (V[0][g] + V[2][g]) / 2, my = (V[1][g] + V[3][g]) / 2; return Math.atan2(mx - V[4][g], -(my - V[5][g])) * DEG; };
    const wr = cmed(track, kA, kB, wrist), dwr = cmed(track, W.late[0], W.late[1], wrist) - cmed(track, W.early[0], W.early[1], wrist);
    add({ key: 'm_wrist', group: 'm_kai', label: '手首から甲への線', value: wr, display: `${wr >= 0 ? '外' : '内'}へ ${Math.abs(wr).toFixed(1)}°（会の間に ${dwr >= 0 ? '外' : '内'}へ ${Math.abs(dwr).toFixed(1)}°）`, verdict: '', status: 'info', note: '緑（手首）から甲の中心への線の、鉛直からの傾き。手首の折れの目安', t: tk });
    if (W.post[1] > W.post[0]) {
      const turn = cmed(track, W.post[0], W.post[1], th) - cmed(track, W.pre[0], W.pre[1], th);
      add({ key: 'm_turn', group: 'm_hanare', label: '離れでの回り', value: turn, display: `${io(turn)} ${Math.abs(turn).toFixed(1)}°`, verdict: turn < 0 ? '捻りが戻る向き' : 'さらに捻る向き', status: 'info', note: '離れの直前と 0.15〜0.25 秒後の、甲の向きの差', t: ph.tHanare + 0.1 });
      const hw = Math.max(1, Math.round(0.01 / track.dt));
      const angv = (g) => { const a = Math.max(0, g - hw), b = Math.min(track.grid.G - 1, g + hw); return Math.abs(sig.ori[b] - sig.ori[a]) / ((b - a) * track.dt || 1); };
      if (fineEnough(track, 1 / 90)) {
        const mx = cmax(track, ph.tHanare - 0.02, Math.min(ph.tEnd, ph.tHanare + 0.3), angv);
        add({ key: 'm_vmax', group: 'm_hanare', label: '回りの最大の速さ', value: mx.v, display: `${Math.round(mx.v).toLocaleString()}°/秒（離れから ${ms(mx.t - ph.tHanare)} ミリ秒）`, verdict: '', status: 'info', note: '離れで甲が一番速く回った時の速さ', t: mx.t });
      } else add({ key: 'm_vmax', group: 'm_hanare', label: '回りの最大の速さ', value: NaN, display: '—', verdict: '', status: 'info', note: 'スロー撮影（実時間で毎秒 120 コマ以上）で測れます', t: ph.tHanare });
      const g0 = cIndex(track, ph.tHanare - 0.02), g1 = cIndex(track, Math.min(ph.tEnd, ph.tHanare + 0.2));
      const dx = (V[4][g1] - V[4][g0]) * cpp, dy = -(V[5][g1] - V[5][g0]) * cpp, dist = Math.hypot(dx, dy);
      add({ key: 'm_path', group: 'm_hanare', label: '手の抜ける方向', value: Math.atan2(dy, dx) * DEG, display: `${dx >= 0 ? '外' : '内'}へ ${Math.abs(dx).toFixed(0)} cm ／ ${dy >= 0 ? '上' : '下'}へ ${Math.abs(dy).toFixed(0)} cm`,
        verdict: dist < 2 ? 'ほとんど動かない' : (Math.abs(dy) > Math.abs(dx) * 1.2 ? (dy < 0 ? '下へ抜ける' : '上へ抜ける') : '外へ抜ける'), status: 'info', note: '離れから 0.2 秒の手首（緑）の移動。目印の間隔から cm に換算', t: ph.tHanare + 0.1 });
      if (fineEnough(track, 1 / 50)) {
        const spd = (g) => sig.sp[g];
        const mx = cmax(track, ph.tHanare - 0.02, Math.min(ph.tEnd, ph.tHanare + 0.4), spd);
        let tStop = NaN;
        for (let g = cIndex(track, mx.t); g < track.grid.G; g++) if (spd(g) < mx.v * 0.15) { tStop = track.grid.gt[g]; break; }
        if (Number.isFinite(tStop)) add({ key: 'm_settle', group: 'm_hanare', label: '手が止まるまで', value: tStop - ph.tHanare, display: `${ms(tStop - ph.tHanare)} ミリ秒`, verdict: '', status: 'info', note: '離れから、手の速さが最大の 15% に落ちるまで', t: tStop });
      }
    }
    return M;
  }

  // ---- 合成サンプル ----
  function sampleTimes(dur, tH, fine) {
    const times = [];
    for (let t = 0.03; t < dur; t += 1 / 15) if (Math.abs(t - tH) > 0.45) times.push(t);
    for (let t = tH - 0.45; t <= tH + 0.55; t += fine) times.push(t);
    return times;
  }
  // 弓手（正面寄りから。的は画面の右）。離れで手が少し下がって回り、親指がやや下へ
  function makeYundeSample(noise = 1, seed = 5) {
    const rnd = mulberry(seed);
    const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const ease = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    let P0 = [[300, 520], [352, 498], [405, 470], [455, 462], [500, 462], [440, 500], [488, 520], [514, 545], [524, 570], [440, 540], [476, 574], [472, 604], [452, 616], [430, 575], [460, 604], [452, 630], [432, 636], [415, 605], [441, 628], [434, 650], [417, 656]];
    const rot = (p, o, a) => { const c = Math.cos(a), s = Math.sin(a); return [o[0] + (p[0] - o[0]) * c - (p[1] - o[1]) * s, o[1] + (p[0] - o[0]) * s + (p[1] - o[1]) * c]; };
    let P1 = P0.map((p, j) => {
      let q = rot(p, P0[0], 7 / DEG);
      if (j >= 2 && j <= 4) q = rot(q, rot(P0[2], P0[0], 7 / DEG), 6 / DEG);
      if (j >= 6 && j <= 8) q = rot(q, rot(P0[5], P0[0], 7 / DEG), -12 / DEG);
      return [q[0] + 16, q[1] + 26];
    });
    const Z = 1.8, map = (q) => [360 + (q[0] - 420) * Z, 470 + (q[1] - 550) * Z];
    P0 = P0.map(map); P1 = P1.map(map);
    const stage = { bowX0: map([412, 0])[0], bowX1: map([446, 0])[0], gripY0: map([0, 470])[1], gripY1: map([0, 670])[1], arrowY: map([0, 446])[1], arrowH: 4 * Z };
    const tH = 3.6, dur = 6.2;
    const frames = sampleTimes(dur, tH, 1 / 240).map(t => {
      const u = ease((t - tH) / 0.09), over = t > tH ? Math.sin(clamp((t - tH) / 0.35, 0, 1) * Math.PI) * 0.08 : 0;
      const drift = (t < tH ? 3 * clamp(t / tH, 0, 1) : 3) * Z;
      const k = [];
      for (let j = 0; j < 21; j++) {
        const x = P0[j][0] + (P1[j][0] - P0[j][0]) * (u + over) + drift, y = P0[j][1] + (P1[j][1] - P0[j][1]) * (u + over);
        k.push(x + gauss() * 1.4 * noise, y + gauss() * 1.4 * noise, 0);
      }
      return { t, k, p: 0.94 };
    });
    return { kind: 'yunde', w: 720, h: 960, duration: dur, fps: 240, slow: 1, frames, sample: true, tH, stage };
  }
  // 馬手（後ろから。画面の右が外側）。会でわずかに捻りが戻り、離れで外へ 46° 回って外・下へ抜ける
  function meteGeom(t) {
    const ease = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
    const tH = 4.0;
    const draw = ease(t / 1.4); // 引分けで頬へ
    let th = 36 - 8 * draw - 2 * clamp((t - 1.5) / 2.5, 0, 1);
    let cx = 300 + 60 * draw, cy = 560 - 90 * draw;
    if (t > tH) {
      const u = ease((t - tH) / 0.075), m = ease((t - tH) / 0.22);
      th -= 46 * u; cx += 150 * m; cy += 55 * m;
    }
    return { th, cx, cy, tH };
  }
  function meteMarkers(t) {
    const { th, cx, cy } = meteGeom(t);
    const a = th / DEG, ux = Math.cos(a), uy = -Math.sin(a), half = 55; // 黄と青の間隔 110px ≒ 5cm
    const b = (th - 28) * 0.35 / DEG; // 手首は甲ほど回らない
    return [[cx - ux * half, cy - uy * half], [cx + ux * half, cy + uy * half], [cx + Math.sin(b) * 118, cy + Math.cos(b) * 118]];
  }
  function makeMeteSample(noise = 1, seed = 9) {
    const rnd = mulberry(seed);
    const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const tH = 4.0, dur = 6.0;
    const frames = sampleTimes(dur, tH, 1 / 240).map(t => {
      const mk = meteMarkers(t), m = [];
      for (const [x, y] of mk) m.push(x + gauss() * 0.8 * noise, y + gauss() * 0.8 * noise, 1);
      return { t, m };
    });
    return { kind: 'mete', w: 720, h: 960, duration: dur, fps: 240, slow: 1, frames, sample: true, tH };
  }

  // ---------- 音で時刻を合わせる ----------
  // 動画の音から「音の立ち上がり」の強さを、毎秒 rate 個の 0〜255 の値にする。
  // 弦音・的中音・物音のような短く鋭い音ほど大きくなる。chs: 各チャンネルの Float32Array
  function audioEnvelope(chs, sr, rate = 200) {
    const n = chs[0].length, hop = Math.max(1, Math.round(sr / rate)), F = Math.floor(n / hop);
    const e = new Float32Array(F);
    let prev = 0;
    for (let f = 0; f < F; f++) {
      let s = 0;
      for (let i = f * hop, end = i + hop; i < end; i++) {
        let x = 0; for (const c of chs) x += c[i]; x /= chs.length;
        const d = x - prev; prev = x; s += d * d; // 1 次の差分で高い音（鋭い音）を強める
      }
      e[f] = Math.log10(1e-10 + s / hop);
    }
    const on = new Float32Array(F);
    for (let f = 3; f < F; f++) on[f] = Math.max(0, e[f] - (e[f - 1] + e[f - 2] + e[f - 3]) / 3);
    const sorted = Array.from(on).filter(v => v > 0).sort((a, b) => a - b);
    const top = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.998))] : 0;
    const out = new Uint8Array(F);
    if (top > 0) for (let f = 0; f < F; f++) out[f] = Math.min(255, Math.round(on[f] / top * 255));
    return { rate, env: out };
  }
  // 2 本の音の立ち上がりを重ね合わせ、一番よく重なるずれを探す。
  // 戻り値 offset = (a の時刻) − (b の時刻)（同じ音について）。score: 重なりの強さ 0〜1、ratio: 2 番目の候補との差
  function audioSync(A, B, opt = {}) {
    if (!A || !B || A.rate !== B.rate) return null;
    const rate = A.rate, a = A.env, b = B.env;
    const pool = Math.max(1, Math.round(rate / 50)); // 粗く探す時は 50Hz に（鋭い音は最大値で残す）
    const down = (x) => { const m = Math.floor(x.length / pool), o = new Float32Array(m); for (let i = 0; i < m; i++) { let v = 0; for (let j = 0; j < pool; j++) v = Math.max(v, x[i * pool + j]); o[i] = v; } return o; };
    const ad = down(a), bd = down(b), r2 = rate / pool;
    const maxLag = Math.round((opt.maxLag || 20) * r2), minOv = Math.round((opt.minOverlap || 3) * r2);
    // 重なった所だけで割ると、重なりが短い時にたまたま 1 つ音がそろっただけで高く出るので、全体の大きさで割る
    const en = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s; };
    const E = new Map([[ad, en(ad)], [bd, en(bd)], [a, en(a)], [b, en(b)]]);
    const corr = (x, y, k) => { // x[i] と y[i - k]
      const i0 = Math.max(0, k), i1 = Math.min(x.length, y.length + k);
      if (i1 - i0 < minOv * (x === ad ? 1 : pool)) return -1;
      let s = 0; for (let i = i0; i < i1; i++) s += x[i] * y[i - k];
      const d = Math.sqrt(E.get(x) * E.get(y));
      return d > 0 ? s / d : -1;
    };
    const cs = [];
    for (let k = -maxLag; k <= maxLag; k++) cs.push([k, corr(ad, bd, k)]);
    cs.sort((p, q) => q[1] - p[1]);
    if (!cs.length || cs[0][1] <= 0) return null;
    // 候補（離れた山）を 3 つまで
    const peaks = [];
    for (const [k, c] of cs) { if (c <= 0) break; if (peaks.every(p => Math.abs(p[0] - k) > 0.25 * r2)) peaks.push([k, c]); if (peaks.length >= 3) break; }
    // 細かく（元の rate で）合わせ直す
    const fine = peaks.map(([k, c]) => {
      let best = [k * pool, -1];
      for (let kk = k * pool - 2 * pool; kk <= k * pool + 2 * pool; kk++) { const v = corr(a, b, kk); if (v > best[1]) best = [kk, v]; }
      return { offset: best[0] / rate, score: best[1] };
    });
    const ratio = fine.length > 1 ? fine[0].score / Math.max(1e-6, fine[1].score) : 9;
    return { offset: fine[0].offset, score: fine[0].score, ratio, cands: fine };
  }
  // 音と動きの結果から、使うずれを決める
  function chooseSync(motion, audio) {
    if (audio && audio.score >= 0.25 && audio.ratio >= 1.25) return { offset: audio.offset, method: '音（弦音など）', audio: true };
    if (audio && motion) {
      // 音の候補のうち、動きの推定に近いものがあればそれを使う
      const near = audio.cands.filter(c => Math.abs(c.offset - motion.offset) < 1.0 && c.score >= 0.2).sort((p, q) => q.score - p.score)[0];
      if (near) return { offset: near.offset, method: '音と動き', audio: true };
    }
    return motion ? { offset: motion.offset, method: motion.method, audio: false } : null;
  }

  // ---------- 矢所の写真: 的に輪を合わせる ----------
  // 中心付近のタップから放射状に明るさを読み、霞的の白黒の幅の比に一番合う大きさを方向ごとに探して、楕円を当てはめる。
  // lum: 輝度（0〜255）W×H。戻り値 {cx, cy, rx, ry, score, used} か null（見つからない）
  const KASUMI_EDGES = [3.6, 7.2, 10.2, 11.7, 14.7, 18.0].map(r => r / 18);
  function fitTarget(lum, W, H, tx, ty, opt = {}) {
    const at = (x, y) => {
      if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return NaN;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * W + x0;
      const dx = x0 < W - 1 ? 1 : 0, dy = y0 < H - 1 ? W : 0;
      return (lum[i] * (1 - fx) + lum[i + dx] * fx) * (1 - fy) + (lum[i + dy] * (1 - fx) + lum[i + dy + dx] * fx) * fy;
    };
    // 白 +1、黒 −1。外黒の外は的枠（明るい）
    const tpl = (u) => { if (u >= 1) return 1; let k = 0; while (u >= KASUMI_EDGES[k]) k++; return k % 2 === 0 ? 1 : -1; };
    const M = 64, U = [], T = [];
    for (let k = 0; k < M; k++) { const u = 0.06 + k * (1.05 - 0.06) / (M - 1); U.push(u); T.push(tpl(u)); }
    const tm = T.reduce((s, v) => s + v, 0) / M; for (let k = 0; k < M; k++) T[k] -= tm;
    const tn = Math.sqrt(T.reduce((s, v) => s + v * v, 0));
    const NR = opt.rays || 72, Rmin = opt.rMin || 12;
    const Rs = []; for (let R = Rmin; R < Math.hypot(W, H); R *= 1.012) Rs.push(R);
    function rayScores(cx, cy) {
      const out = [];
      for (let j = 0; j < NR; j++) {
        const th = j / NR * 2 * Math.PI, ux = Math.cos(th), uy = Math.sin(th);
        const sc = new Float32Array(Rs.length).fill(NaN);
        for (let q = 0; q < Rs.length; q++) {
          const R = Rs[q];
          if (!Number.isFinite(at(cx + ux * R * 1.05, cy + uy * R * 1.05))) break;
          let mean = 0; const P = new Float32Array(M);
          for (let k = 0; k < M; k++) { P[k] = at(cx + ux * U[k] * R, cy + uy * U[k] * R); mean += P[k]; }
          mean /= M;
          let s = 0, n2 = 0; for (let k = 0; k < M; k++) { const d = P[k] - mean; s += d * T[k]; n2 += d * d; }
          sc[q] = n2 > 1e-6 ? s / (Math.sqrt(n2) * tn) : 0;
        }
        out.push({ ux, uy, sc });
      }
      return out;
    }
    function fitEllipse(pts) {
      // A x² + C y² + D x + E y = 1 を最小二乗で
      const S = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
      for (const p of pts) { const v = [p.x * p.x, p.y * p.y, p.x, p.y]; for (let i = 0; i < 4; i++) { b[i] += v[i]; for (let k = 0; k < 4; k++) S[i][k] += v[i] * v[k]; } }
      // ガウスの消去
      for (let i = 0; i < 4; i++) {
        let piv = i; for (let r = i + 1; r < 4; r++) if (Math.abs(S[r][i]) > Math.abs(S[piv][i])) piv = r;
        [S[i], S[piv]] = [S[piv], S[i]]; [b[i], b[piv]] = [b[piv], b[i]];
        if (Math.abs(S[i][i]) < 1e-12) return null;
        for (let r = 0; r < 4; r++) if (r !== i) { const f = S[r][i] / S[i][i]; for (let k = i; k < 4; k++) S[r][k] -= f * S[i][k]; b[r] -= f * b[i]; }
      }
      const [Aq, Cq, Dq, Eq] = b.map((v, i) => v / S[i][i]);
      if (!(Aq > 0 && Cq > 0)) return null;
      const cx = -Dq / (2 * Aq), cy = -Eq / (2 * Cq), G = 1 + Aq * cx * cx + Cq * cy * cy;
      if (!(G > 0)) return null;
      return { cx, cy, rx: Math.sqrt(G / Aq), ry: Math.sqrt(G / Cq) };
    }
    let cx = tx, cy = ty, res = null;
    for (let it = 0; it < 3; it++) {
      const rays = rayScores(cx, cy);
      // 全方向で合う大きさの目安
      let bestQ = -1, bestS = -Infinity;
      for (let q = 0; q < Rs.length; q++) {
        let s = 0, n = 0; for (const r of rays) if (Number.isFinite(r.sc[q])) { s += r.sc[q]; n++; }
        if (n >= NR * 0.5 && s / n > bestS) { bestS = s / n; bestQ = q; }
      }
      if (bestQ < 0) return null;
      const R0 = Rs[bestQ];
      // 方向ごとに、目安の 0.55〜1.8 倍の範囲で一番合う所
      const pts = [];
      for (const r of rays) {
        let bq = -1, bs = -Infinity;
        for (let q = 0; q < Rs.length; q++) { const R = Rs[q]; if (R < 0.55 * R0 || R > 1.8 * R0 || !Number.isFinite(r.sc[q])) continue; if (r.sc[q] > bs) { bs = r.sc[q]; bq = q; } }
        if (bq >= 0 && bs >= 0.45) pts.push({ x: cx + r.ux * Rs[bq] - cx, y: cy + r.uy * Rs[bq] - cy, s: bs, R: Rs[bq] });
      }
      if (pts.length < NR * 0.35) return null;
      // 外れた点を除いて当てはめ（座標はいまの中心からの相対）
      let use = pts, e = fitEllipse(use);
      for (let pass = 0; pass < 2 && e; pass++) {
        const resid = use.map(p => Math.abs(Math.hypot((p.x - e.cx) / e.rx, (p.y - e.cy) / e.ry) - 1));
        const med = median(resid.slice()), mad = median(resid.map(v => Math.abs(v - med))) || 0.01;
        const keep = use.filter((p, i) => resid[i] <= Math.max(0.06, med + 3 * mad));
        if (keep.length < 8) break;
        use = keep; e = fitEllipse(use);
      }
      if (!e) return null;
      const ncx = cx + e.cx, ncy = cy + e.cy;
      res = { cx: ncx, cy: ncy, rx: e.rx, ry: e.ry, score: use.reduce((s, p) => s + p.s, 0) / use.length, used: use.length / NR };
      const moved = Math.hypot(ncx - cx, ncy - cy);
      cx = ncx; cy = ncy;
      if (moved < 0.5) break;
    }
    if (!res || !(res.rx > 5 && res.ry > 5) || res.rx / res.ry > 3 || res.ry / res.rx > 3) return null;
    if (res.score < 0.5 || res.used < 0.4) return null;
    return res;
  }

  return { KP, NK, EDGES, PHASES, KASUMI, DT, prepareTrack, kpAt, kpAtGrid, gIndex, detectPhases, syncOffset, evenPhases, phaseAt, computeMetrics, fuseSetup, pose3dAt, targetStats, zoneOf, dirWords, makeSample, median, clamp, tilt, HAND_EDGES, TPH, prepareClose, closeAt, closeGrid, cIndex, detectClosePhases, closePhaseAt, yundeMetrics, meteMetrics, makeYundeSample, makeMeteSample, meteMarkers, meteGeom, audioEnvelope, audioSync, chooseSync, fitTarget, fuseSingle };
})();
if (typeof module !== 'undefined') module.exports = Kyu;
