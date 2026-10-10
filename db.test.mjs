import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../web/js/db.js';
import { validateMacro, MACRO_SCHEMA } from '../web/js/macro.js';

const mk = (id, name) => validateMacro({
  schema: MACRO_SCHEMA, id, name,
  actions: [{ type: 'tap', x: 1, y: 2, delayMs: 100, durationMs: 50 }],
}).macro;

test('db: บันทึก/อ่าน/ลบ/ตั้งค่า', async () => {
  db._resetForTests();
  await db.saveMacro(mk('a', 'A'));
  await db.saveMacro(mk('b', 'B'));
  assert.equal((await db.listMacros()).length, 2);
  assert.equal((await db.getMacro('a')).name, 'A');
  await db.deleteMacro('a');
  assert.equal(await db.getMacro('a'), undefined);
  await db.setSetting('token', 'xyz');
  assert.equal(await db.getSetting('token'), 'xyz');
  assert.equal(await db.getSetting('missing', 7), 7);
});

test('db: นำเข้าที่ id ซ้ำต้องไม่ทับของเดิม', async () => {
  db._resetForTests();
  await db.saveMacro(mk('same', 'เดิม'));
  const saved = await db.importMacros([mk('same', 'ใหม่')]);
  assert.notEqual(saved[0].id, 'same');
  const all = await db.listMacros();
  assert.equal(all.length, 2);
  assert.ok(all.some((m) => m.id === 'same' && m.name === 'เดิม'));
});

test('db: recordRun สะสมสถิติ รอบ เวลา และผลล่าสุด', async () => {
  db._resetForTests();
  await db.saveMacro(mk('r', 'R'));
  await db.recordRun({ macroId: 'r', loops: 5, timeMs: 10_000, result: 'completed', endedAt: '2026-01-01T00:00:00Z' });
  const m = await db.recordRun({ macroId: 'r', loops: 3, timeMs: 4_000, result: 'stopped' });
  assert.equal(m.stats.runs, 2);
  assert.equal(m.stats.loops, 8);
  assert.equal(m.stats.timeMs, 14_000);
  assert.equal(m.stats.lastResult, 'stopped');
  assert.equal(await db.recordRun({ macroId: 'nope', loops: 1, timeMs: 1, result: 'completed' }), null);
});
