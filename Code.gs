/**
 * 射形分析帳 — サーバー（Google Apps Script）
 *
 * 使い方（くわしくは README.md）
 *   1. 下の SETTINGS に合言葉などを書く
 *   2. 関数「setup」を一度だけ実行する（スプレッドシートとドライブのフォルダができる）
 *   3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分 ／ アクセスできるユーザー: 全員
 *   4. 表示された URL（…/exec）を、アプリの config.js に書く
 *
 * setup を実行したあとは、SETTINGS の合言葉と API キーを消して保存しても動きます
 * （値はスクリプト プロパティに保存されています）。
 */
const SETTINGS = {
  VIEW_KEY: '',          // 閲覧の合言葉（結果を見るだけの人）
  EDIT_KEY: '',          // 登録の合言葉（動画・写真を登録する人。見ることもできる）
  ADMIN_KEY: '',         // 管理の合言葉（記録を消せる人）
  CLUB_NAME: '',         // 画面に出す名前（例: 〇〇高校弓道部）。空でもよい
  ANTHROPIC_API_KEY: '', // AI 講評を使う時だけ。空なら講評のボタンは出ない
  AI_MODEL: 'claude-sonnet-5-5',
  AI_DAILY_LIMIT: 30     // AI 講評を 1 日に作れる回数（全員の合計）
};

const APP_NAME = '射形分析帳データ';
const ROLE_RANK = { view: 1, edit: 2, admin: 3 };
const MAX_JSON = 48000;          // スプレッドシートの 1 セルに収める上限（文字）
const MAX_BLOB_B64 = 3000000;    // 画像 1 枚の上限（Base64 の文字数、約 2.2MB）
const MAX_PART_CHARS = 1500000;  // 骨格データ 1 本の上限

// ---------- 初期設定 ----------
function setup() {
  const props = PropertiesService.getScriptProperties();
  const s = SETTINGS;
  const keys = [s.VIEW_KEY, s.EDIT_KEY, s.ADMIN_KEY].map(function (k) { return String(k || '').trim(); });
  const stored = props.getProperties();
  // 空欄の項目は、すでに保存されている値をそのまま使う
  const view = keys[0] || stored.VIEW_KEY, edit = keys[1] || stored.EDIT_KEY, admin = keys[2] || stored.ADMIN_KEY;
  if (!view || !edit || !admin) throw new Error('SETTINGS の VIEW_KEY・EDIT_KEY・ADMIN_KEY をすべて書いてから実行してください。');
  if (view === edit || edit === admin || view === admin) throw new Error('3 つの合言葉は、それぞれ違うものにしてください。');
  if (Math.min(view.length, edit.length, admin.length) < 6) throw new Error('合言葉は 6 文字以上にしてください。');
  const out = { VIEW_KEY: view, EDIT_KEY: edit, ADMIN_KEY: admin };
  if (s.CLUB_NAME) out.CLUB_NAME = String(s.CLUB_NAME);
  if (s.ANTHROPIC_API_KEY) out.ANTHROPIC_API_KEY = String(s.ANTHROPIC_API_KEY).trim();
  if (s.AI_MODEL) out.AI_MODEL = String(s.AI_MODEL);
  if (s.AI_DAILY_LIMIT) out.AI_DAILY_LIMIT = String(Number(s.AI_DAILY_LIMIT) || 30);
  if (!stored.SHEET_ID) {
    const ss = SpreadsheetApp.create(APP_NAME);
    const sh = ss.getSheets()[0];
    sh.setName('shots');
    sh.getRange(1, 1, 1, 5).setValues([['id', 'createdAt', 'updatedAt', 'title', 'json']]);
    out.SHEET_ID = ss.getId();
  }
  if (!stored.FOLDER_ID) out.FOLDER_ID = DriveApp.createFolder(APP_NAME).getId();
  props.setProperties(out);
  Logger.log('設定しました。スプレッドシート: ' + (out.SHEET_ID || stored.SHEET_ID) + ' ／ フォルダ: ' + (out.FOLDER_ID || stored.FOLDER_ID));
  Logger.log('AI 講評: ' + ((out.ANTHROPIC_API_KEY || stored.ANTHROPIC_API_KEY) ? '使える' : '使わない（API キーなし）'));
}

// ---------- 入口 ----------
function doGet() {
  return json_({ ok: true, app: 'shakei', message: '射形分析帳のサーバーは動いています。' });
}
function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'bad_request', message: '送られた内容を読めませんでした。' }); }
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    if (!props.SHEET_ID || !props.FOLDER_ID) return json_({ ok: false, error: 'not_setup', message: 'サーバーの初期設定（setup）がまだです。' });
    const role = auth_(props, req.key);
    if (!role) return json_({ ok: false, error: 'bad_key', message: '合言葉が違います。' });
    const ctx = { props: props, role: role, req: req };
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'bad_action', message: '知らない操作です。' });
    return json_(fn(ctx));
  } catch (err) {
    const msg = String(err && err.message || err);
    if (msg.indexOf('E:') === 0) { const p = msg.slice(2).split('|'); return json_({ ok: false, error: p[0], message: p[1] || '' }); }
    console.error(err);
    return json_({ ok: false, error: 'server', message: 'サーバーで問題が起きました。' });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, message) { throw new Error('E:' + code + '|' + message); }

// 合言葉。間違いが続いたら、しばらく受け付けない
function auth_(props, key) {
  const cache = CacheService.getScriptCache();
  const bad = Number(cache.get('badKeys') || 0);
  if (bad > 60) fail_('locked', '合言葉の間違いが続いたため、10 分ほど受け付けません。');
  key = String(key || '');
  if (key && key === props.ADMIN_KEY) return 'admin';
  if (key && key === props.EDIT_KEY) return 'edit';
  if (key && key === props.VIEW_KEY) return 'view';
  cache.put('badKeys', String(bad + 1), 600);
  Utilities.sleep(700);
  return null;
}
function need_(ctx, role) { if (ROLE_RANK[ctx.role] < ROLE_RANK[role]) fail_('forbidden', role === 'admin' ? '管理の合言葉が必要です。' : '登録の合言葉が必要です。'); }

// ---------- 保存先 ----------
function sheet_(props) { return SpreadsheetApp.openById(props.SHEET_ID).getSheetByName('shots'); }
function findRow_(sh, id) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id || ''))) fail_('bad_request', '射の記録が指定されていません。');
  const r = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!r || r.getRow() < 2) fail_('not_found', 'この射の記録は見つかりません（消された可能性があります）。');
  return r.getRow();
}
function readShot_(sh, row) { return JSON.parse(sh.getRange(row, 5).getValue()); }
function writeShot_(sh, row, shot) {
  shot.updatedAt = Math.max(Date.now(), (shot.updatedAt || 0) + 1);
  const text = JSON.stringify(shot);
  if (text.length > MAX_JSON) fail_('too_large', '記録が大きくなりすぎました（矢所の印が多すぎる可能性があります）。');
  sh.getRange(row, 1, 1, 5).setValues([[shot.id, shot.createdAt, shot.updatedAt, shot.title, text]]);
  return shot.updatedAt;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail_('busy', 'ほかの人が書き込み中です。少し待ってもう一度お試しください。');
  try { return fn(); } finally { lock.releaseLock(); }
}
function inFolder_(fileId, folderId) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(String(fileId || ''))) return false;
  let f;
  try { f = DriveApp.getFileById(fileId); } catch (err) { return false; }
  const it = f.getParents();
  while (it.hasNext()) if (it.next().getId() === folderId) return true;
  return false;
}
function trash_(fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { /* すでにない */ } }
function publicShot_(shot) { const o = JSON.parse(JSON.stringify(shot)); delete o.folder; return o; }
function cleanName_(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || '名無し'; }
function cleanDev_(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); }
function num_(v, lo, hi) { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; }

// ---------- 操作 ----------
const ACTIONS = {
  hello: function (ctx) {
    const p = ctx.props;
    return { ok: true, role: ctx.role, club: p.CLUB_NAME || '', ai: !!p.ANTHROPIC_API_KEY, aiLeft: aiLeft_(p) };
  },

  list: function (ctx) {
    const sh = sheet_(ctx.props), n = sh.getLastRow() - 1;
    if (n < 1) return { ok: true, shots: [] };
    const from = Math.max(2, sh.getLastRow() - 199);
    const rows = sh.getRange(from, 1, sh.getLastRow() - from + 1, 5).getValues();
    const shots = rows.map(function (r) {
      let j = {};
      try { j = JSON.parse(r[4]); } catch (err) { /* 壊れた行は飛ばす */ }
      return { id: String(r[0]), type: j.type === 'hand' ? 'hand' : 'shot', createdAt: Number(r[1]), updatedAt: Number(r[2]), title: String(r[3]), memo: j.memo || '', createdBy: (j.createdBy && j.createdBy.dev) || '', parts: Object.keys(j.parts || {}).concat(j.target ? ['target'] : []) };
    }).filter(function (s) { return s.id; });
    shots.sort(function (a, b) { return b.createdAt - a.createdAt; });
    // 射の記録と手の記録を、それぞれ新しい順に 50 件まで
    const hands = shots.filter(function (s) { return s.type === 'hand'; }).slice(0, 50);
    return { ok: true, shots: shots.filter(function (s) { return s.type !== 'hand'; }).slice(0, 50).concat(hands) };
  },

  get: function (ctx) {
    const sh = sheet_(ctx.props), row = findRow_(sh, ctx.req.id);
    const upd = Number(sh.getRange(row, 3).getValue());
    if (ctx.req.since && Number(ctx.req.since) === upd) return { ok: true, unchanged: true, updatedAt: upd };
    return { ok: true, shot: publicShot_(readShot_(sh, row)) };
  },

  create: function (ctx) {
    need_(ctx, 'edit');
    const r = ctx.req, now = new Date();
    const id = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '-' + Math.random().toString(36).slice(2, 6);
    const folder = DriveApp.getFolderById(ctx.props.FOLDER_ID).createFolder(id);
    const shot = r.type === 'hand' ? {
      // 手の内・ひねり（弓手と馬手の接写）の記録
      id: id, type: 'hand', title: Utilities.formatDate(now, 'Asia/Tokyo', 'M月d日 HH:mm'), memo: '', createdAt: now.getTime(), updatedAt: 0,
      createdBy: { name: cleanName_(r.name), dev: cleanDev_(r.dev) }, rel: { yunde: null, mete: null }, parts: {}, folder: folder.getId()
    } : {
      id: id, title: Utilities.formatDate(now, 'Asia/Tokyo', 'M月d日 HH:mm'), memo: '', createdAt: now.getTime(), updatedAt: 0,
      createdBy: { name: cleanName_(r.name), dev: cleanDev_(r.dev) }, heightCm: num_(r.heightCm, 120, 210) || 165,
      offset: null, bounds: null, boundsMaster: null, target: null, parts: {}, coach: null, folder: folder.getId()
    };
    return withLock_(function () {
      const sh = sheet_(ctx.props);
      sh.appendRow([id, shot.createdAt, 0, shot.title, '{}']);
      writeShot_(sh, sh.getLastRow(), shot);
      return { ok: true, shot: publicShot_(shot) };
    });
  },

  updateShot: function (ctx) {
    need_(ctx, 'edit');
    const p = ctx.req.patch || {};
    return withLock_(function () {
      const sh = sheet_(ctx.props), row = findRow_(sh, ctx.req.id), shot = readShot_(sh, row);
      if ('memo' in p) shot.memo = String(p.memo || '').replace(/[\u0000-\u001f]/g, '').slice(0, 60);
      if ('heightCm' in p && num_(p.heightCm, 120, 210)) shot.heightCm = num_(p.heightCm, 120, 210);
      if ('offset' in p) shot.offset = p.offset === null ? null : num_(p.offset, -60, 60);
      if ('bounds' in p) shot.bounds = Array.isArray(p.bounds) && p.bounds.length === 9 && p.bounds.every(function (x) { return num_(x, -1, 3600) !== null; }) ? p.bounds.map(Number) : null;
      if ('boundsMaster' in p) shot.boundsMaster = p.boundsMaster === 'side' ? 'side' : 'front';
      // 手の記録: 弓手・馬手それぞれの離れの時刻（手で直した時だけ。null は自動）
      if ('rel' in p && shot.type === 'hand') {
        const rl = p.rel || {}, cur = shot.rel || {};
        ['yunde', 'mete'].forEach(function (k) { if (k in rl) cur[k] = rl[k] === null ? null : num_(rl[k], 0, 3600); });
        shot.rel = cur;
      }
      if ('target' in p && p.target) {
        const t = p.target, cur = shot.target || {};
        if ('photo' in t) {
          if (t.photo && !inFolder_(t.photo, shot.folder)) fail_('bad_request', '写真が見つかりません。');
          if (cur.photo && cur.photo !== t.photo) trash_(cur.photo);
          cur.photo = t.photo || null;
        }
        if ('w' in t) cur.w = num_(t.w, 1, 20000);
        if ('h' in t) cur.h = num_(t.h, 1, 20000);
        if ('calib' in t) cur.calib = t.calib && ['cx', 'cy', 'rx', 'ry'].every(function (k) { return num_(t.calib[k], -1e5, 1e5) !== null; }) ? { cx: +t.calib.cx, cy: +t.calib.cy, rx: +t.calib.rx, ry: +t.calib.ry } : null;
        if ('marks' in t) cur.marks = (Array.isArray(t.marks) ? t.marks : []).slice(0, 60).map(function (m) { return { x: Math.round(Number(m.x) * 10) / 10 || 0, y: Math.round(Number(m.y) * 10) / 10 || 0 }; });
        if ('rightIsMae' in t) cur.rightIsMae = t.rightIsMae !== false;
        if ('shot' in t) cur.shot = Math.max(0, Math.min(60, Math.round(Number(t.shot) || 0)));
        if ('name' in t || !cur.by) { cur.by = cleanName_(t.name); cur.dev = cleanDev_(t.dev); }
        cur.at = Date.now();
        shot.target = cur;
      }
      return { ok: true, updatedAt: writeShot_(sh, row, shot), target: shot.target ? { at: shot.target.at } : null };
    });
  },

  putBlob: function (ctx) {
    need_(ctx, 'edit');
    const r = ctx.req;
    const mime = r.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    if (typeof r.b64 !== 'string' || !r.b64 || r.b64.length > MAX_BLOB_B64) fail_('too_large', '画像が大きすぎます。');
    const sh = sheet_(ctx.props), shot = readShot_(sh, findRow_(sh, r.id));
    const bytes = Utilities.base64Decode(r.b64);
    const file = DriveApp.getFolderById(shot.folder).createFile(Utilities.newBlob(bytes, mime, (r.name || 'image') + (mime === 'image/png' ? '.png' : '.jpg')));
    return { ok: true, fileId: file.getId() };
  },

  putPart: function (ctx) {
    need_(ctx, 'edit');
    const r = ctx.req, kind = r.kind;
    if (['front', 'side', 'yunde', 'mete'].indexOf(kind) < 0) fail_('bad_request', '動画の種類が違います。');
    const f = r.frames || {}, m = r.meta || {};
    if (typeof f.t !== 'string' || typeof f.k !== 'string') fail_('bad_request', '骨格データがありません。');
    const body = JSON.stringify({ t: f.t, k: f.k, ti: typeof f.ti === 'string' ? f.ti : '', p: typeof f.p === 'string' ? f.p : '' });
    if (body.length > MAX_PART_CHARS) fail_('too_large', '骨格データが大きすぎます。');
    return withLock_(function () {
      const sh = sheet_(ctx.props), row = findRow_(sh, r.id), shot = readShot_(sh, row);
      const handKind = kind === 'yunde' || kind === 'mete';
      if (handKind !== (shot.type === 'hand')) fail_('bad_request', handKind ? 'この記録は射の記録です。手の内・ひねりの画面で登録してください。' : 'この記録は手の記録です。射形の画面で登録してください。');
      const sheets = (Array.isArray(m.sheets) ? m.sheets : []).slice(0, 40).filter(function (id) { return inFolder_(id, shot.folder); });
      const file = DriveApp.getFolderById(shot.folder).createFile(kind + '-' + Date.now() + '.json', body, 'application/json');
      const old = shot.parts[kind];
      if (old) { trash_(old.file); (old.sheets || []).forEach(function (id) { if (sheets.indexOf(id) < 0) trash_(id); }); }
      const tile = m.tile && ['w', 'h', 'cols', 'per'].every(function (k) { return num_(m.tile[k], 1, 5000) !== null; }) ? { w: +m.tile.w, h: +m.tile.h, cols: +m.tile.cols, per: +m.tile.per } : null;
      shot.parts[kind] = {
        at: Date.now(), by: cleanName_(r.name), dev: cleanDev_(r.dev), file: file.getId(),
        w: num_(m.w, 1, 20000) || 1, h: num_(m.h, 1, 20000) || 1, duration: num_(m.duration, 0, 3600) || 0, n: num_(m.n, 0, 100000) || 0,
        sheets: tile ? sheets : [], tile: tile
      };
      if (handKind) { shot.parts[kind].fps = num_(m.fps, 1, 1000) || 30; shot.parts[kind].slow = num_(m.slow, 1, 32) || 1; }
      const upd = writeShot_(sh, row, shot);
      return { ok: true, at: shot.parts[kind].at, updatedAt: upd };
    });
  },

  getPart: function (ctx) {
    const sh = sheet_(ctx.props), shot = readShot_(sh, findRow_(sh, ctx.req.id));
    const p = shot.parts[ctx.req.kind];
    if (!p) fail_('not_found', 'この動画の結果はまだありません。');
    const data = JSON.parse(DriveApp.getFileById(p.file).getBlob().getDataAsString());
    return { ok: true, at: p.at, frames: data };
  },

  getBlob: function (ctx) {
    const sh = sheet_(ctx.props), shot = readShot_(sh, findRow_(sh, ctx.req.id));
    if (!inFolder_(ctx.req.fileId, shot.folder)) fail_('not_found', '画像が見つかりません。');
    const b = DriveApp.getFileById(ctx.req.fileId).getBlob();
    return { ok: true, mime: b.getContentType(), b64: Utilities.base64Encode(b.getBytes()) };
  },

  deleteShot: function (ctx) {
    need_(ctx, 'admin');
    return withLock_(function () {
      const sh = sheet_(ctx.props), row = findRow_(sh, ctx.req.id), shot = readShot_(sh, row);
      try { DriveApp.getFolderById(shot.folder).setTrashed(true); } catch (err) { /* すでにない */ }
      sh.deleteRow(row);
      return { ok: true };
    });
  },

  coach: function (ctx) {
    need_(ctx, 'edit');
    const p = ctx.props;
    if (!p.ANTHROPIC_API_KEY) fail_('no_ai', 'AI 講評は設定されていません。');
    const text = String(ctx.req.text || '').slice(0, 6000);
    if (text.length < 20) fail_('bad_request', '計測の結果がありません。');
    const sh = sheet_(p), row = findRow_(sh, ctx.req.id);
    // 1 日の上限（全員の合計）
    const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    withLock_(function () {
      const props = PropertiesService.getScriptProperties();
      const used = Number(props.getProperty('AI_COUNT_' + day) || 0);
      if (used >= Number(p.AI_DAILY_LIMIT || 30)) fail_('ai_limit', '今日の AI 講評の回数を使い切りました。明日また使えます。');
      props.setProperty('AI_COUNT_' + day, String(used + 1));
    });
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': p.ANTHROPIC_API_KEY, 'anthropic-version': '2026-10-21' },
      payload: JSON.stringify({
        model: p.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 1500,
        system: COACH_SYSTEM,
        messages: [{ role: 'user', content: '次は、ある射を動画から自動で計測した結果です。この内容だけをもとに講評してください。\n\n<計測結果>\n' + text + '\n</計測結果>' }]
      })
    });
    if (res.getResponseCode() !== 200) { console.error(res.getContentText()); fail_('ai_error', 'AI 講評を作れませんでした（' + res.getResponseCode() + '）。'); }
    const out = JSON.parse(res.getContentText());
    const answer = (out.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    if (!answer) fail_('ai_error', 'AI 講評が空でした。');
    return withLock_(function () {
      const sh2 = sheet_(p), row2 = findRow_(sh2, ctx.req.id), shot = readShot_(sh2, row2);
      shot.coach = { text: answer.slice(0, 4000), at: Date.now(), by: cleanName_(ctx.req.name), model: out.model || p.AI_MODEL };
      writeShot_(sh2, row2, shot);
      return { ok: true, coach: shot.coach, aiLeft: aiLeft_(p) };
    });
  }
};

function aiLeft_(p) {
  if (!p.ANTHROPIC_API_KEY) return 0;
  const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const used = Number(PropertiesService.getScriptProperties().getProperty('AI_COUNT_' + day) || 0);
  return Math.max(0, Number(p.AI_DAILY_LIMIT || 30) - used);
}

const COACH_SYSTEM = [
  'あなたは弓道の射形を見る、経験のある指導者の補助役です。',
  '渡されるのは、スマートフォンの動画から骨格を自動推定して測った数値です。カメラ 1 台ずつの平面の推定なので、角度は数度、長さは数 cm の誤差があり、弓・矢・手の内は検出していません。',
  '次の形で、日本語で 400 字程度にまとめてください。',
  '1. よくできている点（1〜2 点）',
  '2. 優先して見直したい点（多くても 3 点）。どの数値からそう言えるかを短く添える',
  '3. 次の稽古で意識すること（具体的に 1〜2 点）',
  '注意: 数値にないことは推測しない。断定しすぎず、誤差がありうる項目は「〜の可能性」と書く。流派や指導者の方針を優先するよう一言添える。体の痛みや故障の診断はしない。'
].join('\n');
