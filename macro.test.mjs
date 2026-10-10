import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMacro, parseImport, serializeBundle, serializeMacro, exportMacro, duplicateMacro,
  formatDuration, sanitizeAction, computeDuration, MACRO_SCHEMA, LIMITS, blankAction,
} from '../web/js/macro.js';

const sample = () => ({
  schema: MACRO_SCHEMA,
  id: 'abc',
  name: '  ฟาร์มด่าน 1  ',
  screen: { width: 1080, height: 2400 },
  actions: [
    { type: 'tap', x: 540, y: 1200, delayMs: 800, durationMs: 60 },
    { type: 'hold', x: 100, y: 200, delayMs: 100, durationMs: 1500 },
    { type: 'swipe', x: 100, y: 1000, x2: 100, y2: 400, delayMs: 300, durationMs: 400 },
  ],
});

test('validateMacro: ยอมรับ Macro ที่ถูกต้องและ normalize ค่า', () => {
  const r = validateMacro(sample());
  assert.equal(r.ok, true);
  assert.equal(r.macro.name, 'ฟาร์มด่าน 1');
  assert.equal(r.macro.durationMs, 800 + 60 + 100 + 1500 + 300 + 400);
  assert.equal(r.macro.actions.length, 3);
});

test('validateMacro: ปฏิเสธ schema อื่น, actions ว่าง, พิกัดผิด, ชนิดผิด', () => {
  assert.equal(validateMacro({ ...sample(), schema: 'other/9' }).ok, false);
  assert.equal(validateMacro({ ...sample(), actions: [] }).ok, false);
  assert.equal(validateMacro({ ...sample(), actions: [{ type: 'tap', x: -1, y: 0 }] }).ok, false);
  assert.equal(validateMacro({ ...sample(), actions: [{ type: 'pinch', x: 1, y: 1 }] }).ok, false);
  assert.equal(validateMacro({ ...sample(), actions: [{ type: 'swipe', x: 1, y: 1 }] }).ok, false);
  assert.equal(validateMacro(null).ok, false);
  assert.equal(validateMacro({ ...sample(), screen: { width: 0, height: 5 } }).ok, false);
});

test('validateMacro: จำกัดจำนวน action', () => {
  const many = Array.from({ length: LIMITS.maxActions + 1 }, () => ({ type: 'tap', x: 1, y: 1 }));
  assert.equal(validateMacro({ ...sample(), actions: many }).ok, false);
});

test('sanitizeAction: ใส่ค่าเริ่มต้นให้ delay/duration และปัดเศษ', () => {
  const { action, errors } = sanitizeAction({ type: 'tap', x: 10.6, y: 20.2 });
  assert.deepEqual(errors, []);
  assert.deepEqual(action, { type: 'tap', x: 11, y: 20, delayMs: 0, durationMs: 50 });
});

test('export/import: round-trip ไม่เก็บ stats และได้ข้อมูลเท่าเดิม', () => {
  const m = validateMacro(sample()).macro;
  m.stats.runs = 9;
  assert.equal('stats' in exportMacro(m), false);
  const one = parseImport(serializeMacro(m));
  assert.equal(one.errors.length, 0);
  assert.deepEqual(one.macros[0].actions, m.actions);
  assert.equal(one.macros[0].stats.runs, 0);
  const bundle = parseImport(serializeBundle([m, duplicateMacro(m)]));
  assert.equal(bundle.macros.length, 2);
});

test('parseImport: รับ array, ข้ามรายการเสีย, แจ้งเมื่อ JSON พัง', () => {
  const r = parseImport(JSON.stringify([sample(), { nope: true }]));
  assert.equal(r.macros.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(parseImport('{{{').errors[0], /JSON/);
});

test('duplicateMacro: id ใหม่, ชื่อมี (สำเนา), ไม่แชร์อ็อบเจ็กต์', () => {
  const m = validateMacro(sample()).macro;
  const d = duplicateMacro(m);
  assert.notEqual(d.id, m.id);
  assert.match(d.name, /สำเนา/);
  d.actions[0].x = 1;
  assert.equal(m.actions[0].x, 540);
});

test('formatDuration และ computeDuration', () => {
  assert.equal(formatDuration(0), '0 วินาที');
  assert.equal(formatDuration(65_000), '1 นาที 5 วินาที');
  assert.equal(formatDuration(3_725_000), '1 ชม. 2 นาที 5 วินาที');
  assert.equal(computeDuration([{ delayMs: 5, durationMs: 7 }]), 12);
});

test('blankAction: swipe มีพิกัดปลายทาง', () => {
  const a = blankAction('swipe', { width: 1080, height: 2400 });
  assert.equal(a.x, 540);
  assert.ok('x2' in a && 'y2' in a);
});
