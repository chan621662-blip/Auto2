// ทดสอบ CompanionClient กับเซิร์ฟเวอร์จำลอง "เฉพาะการทดสอบโปรโตคอล"
// (ไม่ใช่ส่วนหนึ่งของผลิตภัณฑ์ — ของจริงคือ android/.../LocalServer.kt ที่แตะหน้าจอจริงผ่าน Accessibility Service)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CompanionClient, ApiError } from '../web/js/api.js';
import { validateMacro, MACRO_SCHEMA } from '../web/js/macro.js';

const TOKEN = 'test-token-1234567890';

function startMock() {
  const sim = { state: 'idle', recordings: [], replay: null, lastRun: null };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const port = server.address().port;
    const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
    if (!hostOk) return send(403, { ok: false, error: 'bad_host', message: 'host' });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(403, { ok: false, error: 'forbidden_origin', message: 'origin' });
    if (req.headers['x-afr-token'] !== TOKEN) return send(401, { ok: false, error: 'bad_token', message: 'โทเค็นไม่ถูกต้อง' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      const { method, url } = req;
      if (method === 'GET' && url === '/api/status') {
        return send(200, { ok: true, version: 'mock', state: sim.state, screen: { width: 1080, height: 2400 }, recordingsPending: sim.recordings.length, replay: sim.replay, lastRun: sim.lastRun });
      }
      if (method === 'POST' && url === '/api/record/start') {
        if (sim.state !== 'idle') return send(409, { ok: false, error: 'busy', message: 'busy' });
        sim.state = 'recording'; sim.recName = j.name; return send(200, { ok: true });
      }
      if (method === 'POST' && url === '/api/record/stop') {
        if (!sim.state.startsWith('recording')) return send(409, { ok: false, error: 'not_recording', message: 'ยังไม่ได้เริ่มบันทึก' });
        sim.state = 'idle';
        const rec = { schema: MACRO_SCHEMA, id: 'rec-1', name: sim.recName, screen: { width: 1080, height: 2400 }, actions: [{ type: 'tap', x: 5, y: 6, delayMs: 10, durationMs: 50 }] };
        sim.recordings.push(rec);
        return send(200, { ok: true, recording: rec });
      }
      if (method === 'GET' && url === '/api/recordings') return send(200, { ok: true, recordings: sim.recordings });
      if (method === 'DELETE' && url.startsWith('/api/recordings/')) {
        sim.recordings = sim.recordings.filter((r) => r.id !== decodeURIComponent(url.split('/').pop()));
        return send(200, { ok: true });
      }
      if (method === 'POST' && url === '/api/replay/start') {
        const v = validateMacro(j.macro);
        if (!v.ok) return send(400, { ok: false, error: 'bad_macro', message: v.errors.join(';') });
        sim.state = 'replaying'; sim.replay = { macroId: v.macro.id, loops: j.loops, speed: j.speed, startDelayMs: j.startDelayMs };
        return send(200, { ok: true });
      }
      if (method === 'POST' && url === '/api/replay/pause') { sim.state = 'replay_paused'; return send(200, { ok: true }); }
      if (method === 'POST' && url === '/api/replay/resume') { sim.state = 'replaying'; return send(200, { ok: true }); }
      if (method === 'POST' && url === '/api/replay/stop') { sim.state = 'idle'; sim.replay = null; return send(200, { ok: true }); }
      return send(404, { ok: false, error: 'not_found', message: 'nf' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sim, base: `http://127.0.0.1:${server.address().port}` })));
}

test('CompanionClient: flow บันทึก → ดึงรายการ → ลบ', async () => {
  const { server, base } = await startMock();
  try {
    const c = new CompanionClient({ baseUrl: base, token: TOKEN });
    assert.equal((await c.status()).state, 'idle');
    await c.recordStart('ทดสอบ');
    assert.equal((await c.status()).state, 'recording');
    const r = await c.recordStop();
    assert.equal(validateMacro(r.recording).ok, true);
    assert.equal((await c.listRecordings()).length, 1);
    await c.deleteRecording('rec-1');
    assert.equal((await c.listRecordings()).length, 0);
  } finally { server.close(); }
});

test('CompanionClient: flow เล่นซ้ำ ส่ง macro (ไม่มี stats) + พัก/ต่อ/หยุด', async () => {
  const { server, base, sim } = await startMock();
  try {
    const c = new CompanionClient({ baseUrl: base, token: TOKEN });
    const macro = validateMacro({ schema: MACRO_SCHEMA, name: 'x', actions: [{ type: 'tap', x: 1, y: 1, delayMs: 0, durationMs: 50 }] }).macro;
    await c.replayStart(macro, { loops: 0, speed: 2, startDelayMs: 1000 });
    assert.equal(sim.replay.loops, 0);
    assert.equal(sim.replay.speed, 2);
    await c.replayPause();
    assert.equal((await c.status()).state, 'replay_paused');
    await c.replayResume();
    assert.equal((await c.status()).state, 'replaying');
    await c.replayStop();
    assert.equal((await c.status()).state, 'idle');
  } finally { server.close(); }
});

test('CompanionClient: โทเค็นผิด → ApiError 401, ข้อผิดพลาดจากเซิร์ฟเวอร์ส่งต่อเป็นไทย', async () => {
  const { server, base } = await startMock();
  try {
    await assert.rejects(new CompanionClient({ baseUrl: base, token: 'bad' }).status(), (e) => e instanceof ApiError && e.status === 401);
    const c = new CompanionClient({ baseUrl: base, token: TOKEN });
    await assert.rejects(c.recordStop(), (e) => e.code === 'not_recording' && /ยังไม่ได้เริ่ม/.test(e.message));
  } finally { server.close(); }
});

test('CompanionClient: เชื่อมต่อไม่ได้ → ApiError network', async () => {
  const c = new CompanionClient({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 1500 });
  await assert.rejects(c.status(), (e) => e instanceof ApiError && e.code === 'network');
});
