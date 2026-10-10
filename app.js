import {
  validateMacro, parseImport, serializeBundle, serializeMacro, duplicateMacro, blankAction,
  formatDuration, sanitizeAction, TYPE_LABEL, LIMITS, computeDuration,
} from './macro.js';
import * as db from './db.js';
import { CompanionClient } from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IN_APP = navigator.userAgent.includes('AFRCompanion');
const STATE_TH = {
  idle: 'ว่าง', recording: 'กำลังบันทึก', recording_paused: 'พักการบันทึก',
  replaying: 'กำลังเล่นซ้ำ', replay_paused: 'พักการเล่นซ้ำ',
};
const RESULT_TH = { completed: 'เสร็จสมบูรณ์', stopped: 'หยุดโดยผู้ใช้', error: 'ผิดพลาด' };
const DEFAULT_REPLAY = { macroId: '', loops: 1, infinite: false, speed: 1, startDelay: 3, loopDelay: 0 };

const S = {
  macros: [], status: null, connected: false, connError: '', client: null,
  route: 'home', polling: false, ingestChain: Promise.resolve(),
  settings: { baseUrl: '', token: '' }, replayOpts: { ...DEFAULT_REPLAY }, lastSeenRun: '',
};

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}
async function act(fn) {
  try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
}
function dialog(html) {
  const d = $('dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function closeDialog() { const d = $('dlg'); if (d.open) d.close(); }
function askText(title, value = '') {
  return new Promise((resolve) => {
    const d = dialog(`<h3>${esc(title)}</h3><input type="text" id="dlgInput" maxlength="${LIMITS.maxName}" value="${esc(value)}">
      <div class="row"><button class="btn ghost" id="dlgNo">ยกเลิก</button><button class="btn" id="dlgYes">ตกลง</button></div>`);
    d.querySelector('#dlgNo').onclick = () => { closeDialog(); resolve(null); };
    d.querySelector('#dlgYes').onclick = () => { const v = d.querySelector('#dlgInput').value.trim(); closeDialog(); resolve(v || null); };
    d.onclose = () => resolve(null);
  });
}
function confirmBox(msg, yes = 'ยืนยัน') {
  return new Promise((resolve) => {
    const d = dialog(`<p>${esc(msg)}</p><div class="row"><button class="btn ghost" id="dlgNo">ยกเลิก</button><button class="btn red" id="dlgYes">${esc(yes)}</button></div>`);
    d.querySelector('#dlgNo').onclick = () => { closeDialog(); resolve(false); };
    d.querySelector('#dlgYes').onclick = () => { closeDialog(); resolve(true); };
    d.onclose = () => resolve(false);
  });
}
function rebuildClient() {
  S.client = new CompanionClient({ baseUrl: S.settings.baseUrl, token: S.settings.token });
}
const st = () => S.status?.state || 'idle';

/* ---------- init ---------- */
async function init() {
  const m = /[#&]token=([A-Za-z0-9_-]{8,128})/.exec(location.hash);
  if (m) {
    await db.setSetting('token', m[1]);
    history.replaceState(null, '', location.pathname + '#/home');
  }
  S.settings.baseUrl = await db.getSetting('baseUrl', '');
  S.settings.token = await db.getSetting('token', '');
  S.replayOpts = { ...DEFAULT_REPLAY, ...(await db.getSetting('replayOpts', {})) };
  S.lastSeenRun = await db.getSetting('lastSeenRun', '');
  rebuildClient();
  S.macros = await db.listMacros();
  db.requestPersistence();

  window.__afrImportText = (text) => handleImportText(text);
  window.addEventListener('hashchange', route);
  $('view').addEventListener('click', onViewClick);
  $('view').addEventListener('input', onViewInput);
  $('view').addEventListener('change', onViewInput);
  $('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleImportText(await f.text());
  });
  route();
  poll();
  setInterval(poll, 1000);
}

function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  S.route = ['home', 'record', 'replay', 'library', 'settings'].includes(r) ? r : 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === S.route));
  renderView();
  updateLive();
  window.scrollTo(0, 0);
}

/* ---------- polling & ingest ---------- */
async function poll() {
  if (S.polling) return;
  S.polling = true;
  try {
    const s = await S.client.status();
    S.status = s;
    S.connected = true;
    S.connError = '';
    await handleLastRun(s);
    if (s.recordingsPending > 0) await pullRecordings();
  } catch (e) {
    S.status = null;
    S.connected = false;
    S.connError = e.message || String(e);
  } finally {
    S.polling = false;
  }
  updateLive();
}

async function handleLastRun(s) {
  const r = s.lastRun;
  if (!r || r.runId === S.lastSeenRun) return;
  S.lastSeenRun = r.runId;
  await db.setSetting('lastSeenRun', r.runId);
  await db.recordRun({ macroId: r.macroId, loops: r.loopsDone, timeMs: r.elapsedMs, result: r.result, endedAt: r.endedAt });
  S.macros = await db.listMacros();
  if (S.route === 'home' || S.route === 'library') renderView();
  if (r.result === 'error') toast(`การเล่นซ้ำล้มเหลว: ${r.error || 'ไม่ทราบสาเหตุ'}`, true);
}

function ingest(rec) {
  S.ingestChain = S.ingestChain.then(async () => {
    const v = validateMacro(rec);
    if (!v.ok) throw new Error('การบันทึกที่ได้รับไม่ถูกต้อง: ' + v.errors.join('; '));
    if (!(await db.getMacro(v.macro.id))) await db.saveMacro(v.macro);
    await S.client.deleteRecording(v.macro.id).catch(() => {});
    S.macros = await db.listMacros();
    return v.macro;
  });
  return S.ingestChain;
}

async function pullRecordings() {
  const list = await S.client.listRecordings();
  for (const rec of list) {
    try {
      const m = await ingest(rec);
      toast(`บันทึก Macro "${m.name}" แล้ว (${m.actions.length} การกระทำ)`);
    } catch (e) { toast(e.message, true); }
  }
  if (S.route === 'library' || S.route === 'home') renderView();
}

/* ---------- views ---------- */
function renderView() {
  const v = $('view');
  ({ home: viewHome, record: viewRecord, replay: viewReplay, library: viewLibrary, settings: viewSettings })[S.route](v);
}

function totals() {
  let loops = 0, time = 0, runs = 0;
  S.macros.forEach((m) => { loops += m.stats?.loops || 0; time += m.stats?.timeMs || 0; runs += m.stats?.runs || 0; });
  return { loops, time, runs };
}

function viewHome(v) {
  const t = totals();
  v.innerHTML = `
    <h2>แดชบอร์ด</h2>
    <div id="homeConn"></div>
    <div id="homeRun"></div>
    <div class="grid2">
      <div class="stat"><b>${S.macros.length}</b><span>Macro ทั้งหมด</span></div>
      <div class="stat"><b>${t.runs}</b><span>ครั้งที่เล่นซ้ำ</span></div>
      <div class="stat"><b>${t.loops}</b><span>จำนวนรอบรวม</span></div>
      <div class="stat"><b style="font-size:1.05rem">${esc(formatDuration(t.time))}</b><span>เวลาที่ใช้รวม</span></div>
    </div>
    <h2 style="margin-top:18px">รายการ Macro</h2>
    ${S.macros.length ? S.macros.map(macroCard).join('') : '<div class="card muted">ยังไม่มี Macro — ไปที่แท็บ "บันทึก" เพื่อบันทึกการเล่นรอบแรก หรือนำเข้าไฟล์ JSON ที่แท็บ "คลัง"</div>'}`;
}

function resultTag(m) {
  const r = m.stats?.lastResult;
  if (!r) return '<span class="tag">ยังไม่เคยเล่น</span>';
  const cls = r === 'completed' ? 'ok' : r === 'error' ? 'err' : 'stop';
  return `<span class="tag ${cls}">${esc(RESULT_TH[r] || r)}</span>`;
}

function macroCard(m) {
  return `<div class="card mcard">
    <div class="meta">
      <h3>${esc(m.name)}</h3>
      <div class="muted">${m.actions.length} การกระทำ • ${esc(formatDuration(m.durationMs))} • เล่นแล้ว ${m.stats?.runs || 0} ครั้ง (${m.stats?.loops || 0} รอบ)</div>
      <div>${resultTag(m)}</div>
    </div>
    <button class="btn sm" data-act="goplay" data-id="${esc(m.id)}">▶ เล่น</button>
  </div>`;
}

function viewRecord(v) {
  v.innerHTML = `
    <h2>บันทึกการเล่น</h2>
    <div class="card">
      <label class="f" for="recName">ชื่อ Macro</label>
      <input type="text" id="recName" maxlength="${LIMITS.maxName}" placeholder="เช่น ฟาร์มด่าน 1-3">
      <div class="status-big" id="recState">—</div>
      <div class="grid2">
        <div class="stat"><b id="recCount">0</b><span>การกระทำที่บันทึก</span></div>
        <div class="stat"><b id="recElapsed">0</b><span>เวลาที่บันทึก</span></div>
      </div>
      <button class="btn xl red" id="btnRecStart" data-act="recstart">● เริ่มบันทึก</button>
      <div class="row">
        <button class="btn amber" id="btnRecPause" data-act="recpause">⏸ พัก</button>
        <button class="btn" id="btnRecStop" data-act="recstop">■ หยุดและบันทึก</button>
      </div>
    </div>
    <div class="card">
      <h3>วิธีใช้</h3>
      <ol class="steps">
        <li>ตั้งชื่อ แล้วกด "เริ่มบันทึก" — จะมีกรอบสีแดงรอบจอและแถบควบคุมลอยปรากฏ</li>
        <li>สลับไปเปิดเกม แล้วเล่นเองให้ครบ 1 รอบ</li>
        <li>ใช้แถบลอย <b>⏸ พัก</b> / <b>■ บันทึก</b> เพื่อควบคุม (ลากแถบเพื่อย้ายตำแหน่งได้)</li>
        <li>กลับมาที่แอปนี้ Macro จะถูกนำเข้าคลังอัตโนมัติ</li>
      </ol>
    </div>
    <div class="card warn">
      <h3>ข้อจำกัดที่ควรรู้</h3>
      <p class="muted">ขณะบันทึก ระบบจะรับการแตะแล้วส่งต่อให้เกมทันทีที่ยกนิ้ว จึงมีหน่วงเท่าระยะเวลาที่แตะ รองรับ <b>นิ้วเดียว</b> (แตะ กดค้าง ปัด) เท่านั้น — เกมที่ต้องใช้หลายนิ้วหรือควบคุมต่อเนื่องแบบเรียลไทม์อาจใช้ไม่ได้ ใช้หน้าจอแนวเดียวกันตอนบันทึกและเล่นซ้ำ</p>
    </div>`;
}

function viewReplay(v) {
  const o = S.replayOpts;
  const opts = S.macros.map((m) => `<option value="${esc(m.id)}" ${m.id === o.macroId ? 'selected' : ''}>${esc(m.name)} (${m.actions.length})</option>`).join('');
  v.innerHTML = `
    <h2>เล่นซ้ำ</h2>
    <div class="card">
      <label class="f" for="rpMacro">เลือก Macro</label>
      <select id="rpMacro">${opts || '<option value="">— ยังไม่มี Macro —</option>'}</select>
      <label class="f" for="rpLoops">จำนวนรอบ</label>
      <input type="number" id="rpLoops" min="1" max="100000" inputmode="numeric" value="${o.loops}" ${o.infinite ? 'disabled' : ''}>
      <label class="check"><input type="checkbox" id="rpInf" ${o.infinite ? 'checked' : ''}> วนซ้ำไม่จำกัด (จนกว่าจะกดหยุด)</label>
      <label class="f" for="rpSpeed">ความเร็ว: <b id="rpSpeedLbl">${o.speed}x</b></label>
      <input type="range" id="rpSpeed" min="0.25" max="4" step="0.25" value="${o.speed}">
      <label class="f" for="rpDelay">หน่วงก่อนเริ่ม (วินาที) — เวลาสลับไปที่เกม</label>
      <input type="number" id="rpDelay" min="0" max="3600" step="1" inputmode="decimal" value="${o.startDelay}">
      <label class="f" for="rpLoopDelay">หน่วงระหว่างรอบ (วินาที)</label>
      <input type="number" id="rpLoopDelay" min="0" max="3600" step="1" inputmode="decimal" value="${o.loopDelay}">
    </div>
    <div class="card">
      <div class="status-big" id="rpState">—</div>
      <div class="bar"><div id="rpBar"></div></div>
      <p class="muted" id="rpProgress" style="text-align:center">—</p>
      <button class="btn xl" id="btnPlay" data-act="play">▶ เริ่มเล่นซ้ำ</button>
      <div class="row">
        <button class="btn amber" id="btnRpPause" data-act="rppause">⏸ พัก</button>
        <button class="btn purple" id="btnRpResume" data-act="rpresume">⏵ เล่นต่อ</button>
      </div>
      <button class="btn red" id="btnRpStop" data-act="rpstop">■ หยุด</button>
      <button class="btn xl red" id="btnEmergency" data-act="emergency">🛑 หยุดฉุกเฉิน</button>
      <p class="muted">เมื่อเล่นซ้ำ จะมีแถบลอย ⏸ / ■ บนจอเกมด้วย — หากแตะไม่ได้ ให้ปิดบริการ Accessibility ในตั้งค่าของ Android ได้ทันที</p>
    </div>`;
}

function viewLibrary(v) {
  v.innerHTML = `
    <h2>คลัง Macro</h2>
    <div class="row">
      <button class="btn purple" data-act="import">⇪ นำเข้า JSON</button>
      <button class="btn ghost" data-act="exportall" ${S.macros.length ? '' : 'disabled'}>⇩ ส่งออกทั้งหมด</button>
    </div>
    ${S.macros.length ? S.macros.map((m) => `
      <div class="card">
        <h3>${esc(m.name)}</h3>
        <div class="muted">${m.actions.length} การกระทำ • ${esc(formatDuration(m.durationMs))}${m.screen ? ` • จอ ${m.screen.width}×${m.screen.height}` : ''}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm" data-act="goplay" data-id="${esc(m.id)}">▶ เล่น</button>
          <button class="btn sm ghost" data-act="edit" data-id="${esc(m.id)}">✎ แก้ไข</button>
          <button class="btn sm ghost" data-act="rename" data-id="${esc(m.id)}">ตั้งชื่อ</button>
          <button class="btn sm ghost" data-act="dup" data-id="${esc(m.id)}">ทำสำเนา</button>
          <button class="btn sm ghost" data-act="export" data-id="${esc(m.id)}">ส่งออก</button>
          <button class="btn sm red" data-act="del" data-id="${esc(m.id)}">ลบ</button>
        </div>
      </div>`).join('') : '<div class="card muted">ยังไม่มี Macro</div>'}`;
}

function viewSettings(v) {
  v.innerHTML = `
    <h2>ตั้งค่า</h2>
    <div class="card" id="setStatus"></div>
    <div class="card">
      <h3>การเชื่อมต่อ Companion</h3>
      <label class="f" for="setUrl">ที่อยู่ Companion (เว้นว่าง = ที่เดียวกับหน้านี้)</label>
      <input type="text" id="setUrl" value="${esc(S.settings.baseUrl)}" placeholder="http://127.0.0.1:8765" autocapitalize="off" autocomplete="off">
      <label class="f" for="setToken">โทเค็น (เปิดจากแอป Companion แล้วจะตั้งให้อัตโนมัติ)</label>
      <input type="password" id="setToken" value="${esc(S.settings.token)}" autocomplete="off">
      <button class="btn" data-act="savesettings">บันทึกและทดสอบการเชื่อมต่อ</button>
    </div>
    <div class="card">
      <h3>ที่เก็บข้อมูลในเครื่อง</h3>
      <p class="muted">เก็บใน: <b>${esc(db.backendName)}</b> — Macro จะอยู่ต่อแม้ปิดเว็บหรือรีสตาร์ตเครื่อง (ถ้าล้างข้อมูลแอป/เบราว์เซอร์ข้อมูลจะหาย จึงควรส่งออก JSON สำรองไว้)</p>
      <button class="btn ghost" data-act="persist">ขอสิทธิ์เก็บข้อมูลถาวร</button>
      ${IN_APP ? '<a class="btn purple" style="display:block;text-align:center;text-decoration:none;line-height:32px" href="afr://testpad">เปิดหน้าทดสอบการแตะ (Test Pad)</a>' : ''}
    </div>`;
}

/* ---------- live updates ---------- */
function updateLive() {
  const pill = $('connPill');
  pill.textContent = S.connected ? 'เชื่อมต่อแล้ว' : 'ไม่ได้เชื่อมต่อ';
  pill.className = 'pill ' + (S.connected ? 'on' : 'off');
  const s = S.status;
  const state = st();

  const hc = $('homeConn');
  if (hc) {
    hc.innerHTML = S.connected
      ? `<div class="card good"><h3>Companion พร้อมใช้งาน</h3><p class="muted">สถานะ: ${esc(STATE_TH[state] || state)} • หน้าจอ ${s.screen?.width}×${s.screen?.height} • เวอร์ชัน ${esc(s.version)}</p></div>`
      : `<div class="card bad"><h3>ยังไม่ได้เชื่อมต่อ Companion</h3><p class="muted">${esc(S.connError || 'กำลังเชื่อมต่อ…')}</p><p class="muted">ติดตั้งแอป Companion → เปิด Accessibility Service → เปิดแดชบอร์ดจากแอป (ดูคู่มือ README)</p><a class="btn sm ghost" href="#/settings">ไปหน้าตั้งค่า</a></div>`;
  }
  const hr = $('homeRun');
  if (hr) hr.innerHTML = runCard(s);

  if ($('recState')) {
    const recording = state === 'recording' || state === 'recording_paused';
    $('recState').innerHTML = recording ? `${state === 'recording' ? '<span class="rec-dot">●</span> ' : ''}${STATE_TH[state]}` : (S.connected ? 'พร้อมบันทึก' : 'ยังไม่ได้เชื่อมต่อ');
    $('recCount').textContent = s?.recording?.actions ?? 0;
    $('recElapsed').textContent = formatDuration(s?.recording?.elapsedMs ?? 0);
    $('btnRecStart').disabled = !S.connected || state !== 'idle';
    $('btnRecPause').disabled = !recording;
    $('btnRecPause').textContent = state === 'recording_paused' ? '⏵ ต่อ' : '⏸ พัก';
    $('btnRecStop').disabled = !recording;
  }
  if ($('rpState')) {
    const rp = s?.replay;
    const running = state === 'replaying' || state === 'replay_paused';
    $('rpState').textContent = running ? STATE_TH[state] : (S.connected ? 'พร้อมเล่นซ้ำ' : 'ยังไม่ได้เชื่อมต่อ');
    if (rp) {
      const total = rp.loops === 0 ? '∞' : rp.loops;
      const frac = rp.actionCount ? (rp.actionIndex + 1) / rp.actionCount : 0;
      $('rpBar').style.width = `${Math.round(frac * 100)}%`;
      $('rpProgress').textContent = `${rp.macroName} • รอบ ${rp.loop}/${total} • ขั้นที่ ${rp.actionIndex + 1}/${rp.actionCount} • ${formatDuration(rp.elapsedMs)}`;
    } else {
      $('rpBar').style.width = '0';
      $('rpProgress').textContent = '—';
    }
    $('btnPlay').disabled = !S.connected || state !== 'idle' || !S.macros.length;
    $('btnRpPause').disabled = state !== 'replaying';
    $('btnRpResume').disabled = state !== 'replay_paused';
    $('btnRpStop').disabled = !running;
    $('btnEmergency').disabled = !S.connected;
  }
  const ss = $('setStatus');
  if (ss) {
    ss.className = 'card ' + (S.connected ? 'good' : 'bad');
    ss.innerHTML = S.connected
      ? `<h3>เชื่อมต่อแล้ว</h3><p class="muted">Companion v${esc(s.version)} • จอ ${s.screen?.width}×${s.screen?.height} • สถานะ ${esc(STATE_TH[state] || state)}</p>`
      : `<h3>ยังไม่ได้เชื่อมต่อ</h3><p class="muted">${esc(S.connError)}</p>`;
  }
}

function runCard(s) {
  if (!s) return '';
  const state = s.state;
  if (s.recording && state.startsWith('recording')) {
    return `<div class="card warn"><h3><span class="rec-dot">●</span> ${esc(STATE_TH[state])}</h3><p class="muted">${s.recording.actions} การกระทำ • ${esc(formatDuration(s.recording.elapsedMs))}</p></div>`;
  }
  if (s.replay && state.startsWith('replay')) {
    const r = s.replay;
    const frac = r.actionCount ? Math.round(((r.actionIndex + 1) / r.actionCount) * 100) : 0;
    return `<div class="card warn"><h3>▶ ${esc(STATE_TH[state])}: ${esc(r.macroName)}</h3>
      <div class="bar"><div style="width:${frac}%"></div></div>
      <p class="muted">รอบ ${r.loop}/${r.loops === 0 ? '∞' : r.loops} • ${esc(formatDuration(r.elapsedMs))}</p></div>`;
  }
  return '';
}

/* ---------- event handling ---------- */
function onViewInput(e) {
  const id = e.target.id;
  if (!id || !id.startsWith('rp')) return;
  const o = S.replayOpts;
  if (id === 'rpMacro') o.macroId = e.target.value;
  if (id === 'rpLoops') o.loops = Math.max(1, Math.min(100000, parseInt(e.target.value, 10) || 1));
  if (id === 'rpInf') { o.infinite = e.target.checked; $('rpLoops').disabled = o.infinite; }
  if (id === 'rpSpeed') { o.speed = parseFloat(e.target.value) || 1; $('rpSpeedLbl').textContent = `${o.speed}x`; }
  if (id === 'rpDelay') o.startDelay = Math.max(0, Math.min(3600, parseFloat(e.target.value) || 0));
  if (id === 'rpLoopDelay') o.loopDelay = Math.max(0, Math.min(3600, parseFloat(e.target.value) || 0));
  db.setSetting('replayOpts', o);
}

async function onViewClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.id;
  const m = id ? S.macros.find((x) => x.id === id) : null;
  await act(async () => {
    switch (btn.dataset.act) {
      case 'recstart': {
        const name = $('recName').value.trim() || `บันทึกใหม่ ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}`;
        await S.client.recordStart(name);
        toast('เริ่มบันทึกแล้ว — สลับไปที่เกมได้เลย ใช้แถบลอยเพื่อพัก/หยุด');
        break;
      }
      case 'recpause':
        if (st() === 'recording_paused') await S.client.recordResume(); else await S.client.recordPause();
        break;
      case 'recstop': {
        const r = await S.client.recordStop();
        const saved = await ingest(r.recording);
        toast(`บันทึก "${saved.name}" แล้ว (${saved.actions.length} การกระทำ)`);
        location.hash = '#/library';
        break;
      }
      case 'play': await startReplay(); break;
      case 'rppause': await S.client.replayPause(); break;
      case 'rpresume': await S.client.replayResume(); break;
      case 'rpstop': await S.client.replayStop(); break;
      case 'emergency':
        await S.client.replayStop().catch(() => {});
        await S.client.recordStop().catch(() => {});
        toast('ส่งคำสั่งหยุดฉุกเฉินแล้ว');
        break;
      case 'goplay':
        S.replayOpts.macroId = id;
        await db.setSetting('replayOpts', S.replayOpts);
        location.hash = '#/replay';
        break;
      case 'rename': {
        const n = await askText('ตั้งชื่อ Macro', m.name);
        if (n) { await db.saveMacro({ ...m, name: n.slice(0, LIMITS.maxName) }); S.macros = await db.listMacros(); renderView(); }
        break;
      }
      case 'dup': await db.saveMacro(duplicateMacro(m)); S.macros = await db.listMacros(); renderView(); toast('ทำสำเนาแล้ว'); break;
      case 'del':
        if (await confirmBox(`ลบ "${m.name}" ถาวร?`, 'ลบ')) { await db.deleteMacro(id); S.macros = await db.listMacros(); renderView(); }
        break;
      case 'export': downloadText(`${m.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'macro'}.json`, serializeMacro(m)); break;
      case 'exportall': downloadText('autofarm-macros.json', serializeBundle(S.macros)); break;
      case 'import':
        if (window.AFRBridge?.importFile) window.AFRBridge.importFile(); else $('fileInput').click();
        break;
      case 'edit': editMacro(m); break;
      case 'savesettings': {
        S.settings.baseUrl = $('setUrl').value.trim();
        S.settings.token = $('setToken').value.trim();
        await db.setSetting('baseUrl', S.settings.baseUrl);
        await db.setSetting('token', S.settings.token);
        rebuildClient();
        await S.client.status();
        toast('เชื่อมต่อสำเร็จ');
        await poll();
        break;
      }
      case 'persist': toast((await db.requestPersistence()) ? 'ที่เก็บข้อมูลเป็นแบบถาวรแล้ว' : 'เบราว์เซอร์ไม่ได้ให้สิทธิ์ถาวร (ข้อมูลยังบันทึกตามปกติ)'); break;
      default: break;
    }
    updateLive();
  });
}

async function startReplay() {
  const o = S.replayOpts;
  const macro = S.macros.find((m) => m.id === ($('rpMacro').value || o.macroId));
  if (!macro) throw new Error('กรุณาเลือก Macro');
  await S.client.replayStart(macro, {
    loops: o.infinite ? 0 : o.loops,
    speed: o.speed,
    startDelayMs: Math.round(o.startDelay * 1000),
    loopDelayMs: Math.round(o.loopDelay * 1000),
  });
  toast(o.startDelay > 0 ? `จะเริ่มใน ${o.startDelay} วินาที — สลับไปที่เกมได้เลย` : 'เริ่มเล่นซ้ำแล้ว');
}

/* ---------- import / export ---------- */
function downloadText(filename, text) {
  if (window.AFRBridge?.exportFile) { window.AFRBridge.exportFile(filename, text); return; }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function handleImportText(text) {
  const { macros, errors } = parseImport(String(text));
  if (!macros.length) { toast(errors[0] || 'ไม่พบ Macro ในไฟล์', true); return; }
  const saved = await db.importMacros(macros);
  S.macros = await db.listMacros();
  if (S.route === 'library' || S.route === 'home') renderView();
  toast(`นำเข้า ${saved.length} Macro` + (errors.length ? ` (ข้าม ${errors.length} รายการที่ไม่ถูกต้อง)` : ''), errors.length > 0);
}

/* ---------- editor ---------- */
function actionRow(a, i) {
  const sw = a.type === 'swipe';
  return `<div class="arow" data-i="${i}">
    <span class="idx">${i + 1}</span>
    <div><label>ชนิด</label><select data-f="type">${['tap', 'hold', 'swipe'].map((t) => `<option value="${t}" ${a.type === t ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select></div>
    <div><label>รอก่อนทำ (ms)</label><input type="number" data-f="delayMs" value="${a.delayMs}" inputmode="numeric"></div>
    <div class="full"><div><label>X</label><input type="number" data-f="x" value="${a.x}" inputmode="numeric"></div><div><label>Y</label><input type="number" data-f="y" value="${a.y}" inputmode="numeric"></div><div><label>นาน (ms)</label><input type="number" data-f="durationMs" value="${a.durationMs}" inputmode="numeric"></div></div>
    <div class="full swipe-only ${sw ? '' : 'hidden'}"><div><label>X ปลาย</label><input type="number" data-f="x2" value="${a.x2 ?? a.x}" inputmode="numeric"></div><div><label>Y ปลาย</label><input type="number" data-f="y2" value="${a.y2 ?? a.y}" inputmode="numeric"></div>
    <div><label>&nbsp;</label><button class="btn sm red" data-del="${i}">ลบ</button></div></div>
  </div>`;
}

function editMacro(macro) {
  const work = JSON.parse(JSON.stringify(macro.actions));
  const render = () => {
    const d = dialog(`<h3>แก้ไข Macro</h3>
      <label class="f" for="edName">ชื่อ</label><input type="text" id="edName" maxlength="${LIMITS.maxName}" value="${esc(macro.name)}">
      <p class="muted">${work.length} การกระทำ • ${esc(formatDuration(computeDuration(work)))}</p>
      <div id="edRows">${work.map(actionRow).join('')}</div>
      <button class="btn ghost" id="edAdd">+ เพิ่มการแตะ</button>
      <div class="errs" id="edErr"></div>
      <div class="row"><button class="btn ghost" id="edNo">ยกเลิก</button><button class="btn" id="edSave">บันทึก</button></div>`);
    const collect = () => {
      d.querySelectorAll('.arow').forEach((row) => {
        const i = +row.dataset.i;
        row.querySelectorAll('[data-f]').forEach((el) => {
          const f = el.dataset.f;
          work[i][f] = f === 'type' ? el.value : Number(el.value);
        });
        if (work[i].type !== 'swipe') { delete work[i].x2; delete work[i].y2; }
      });
    };
    d.querySelectorAll('[data-f="type"]').forEach((sel) => sel.addEventListener('change', () => { collect(); render(); }));
    d.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { collect(); work.splice(+b.dataset.del, 1); render(); }; });
    d.querySelector('#edAdd').onclick = () => { collect(); work.push(blankAction('tap', macro.screen)); render(); };
    d.querySelector('#edNo').onclick = closeDialog;
    d.querySelector('#edSave').onclick = async () => {
      collect();
      const errs = [];
      const cleaned = work.map((a, i) => { const r = sanitizeAction(a, i); errs.push(...r.errors); return r.action; });
      if (!work.length) errs.push('ต้องมีอย่างน้อย 1 การกระทำ');
      if (errs.length) { d.querySelector('#edErr').textContent = errs.slice(0, 6).join('\n'); return; }
      const name = d.querySelector('#edName').value.trim() || macro.name;
      await db.saveMacro({ ...macro, name: name.slice(0, LIMITS.maxName), actions: cleaned });
      S.macros = await db.listMacros();
      closeDialog();
      renderView();
      toast('บันทึกการแก้ไขแล้ว');
    };
  };
  render();
}

init().catch((e) => { console.error(e); toast('เริ่มต้นแอปไม่สำเร็จ: ' + e.message, true); });
