// โมดูลล้วน (pure) สำหรับตรวจสอบ/แปลงข้อมูล Macro — ใช้ได้ทั้งในเบราว์เซอร์และ Node (เทสต์)

export const MACRO_SCHEMA = 'autofarm.macro/1';
export const BUNDLE_SCHEMA = 'autofarm.bundle/1';
export const LIMITS = Object.freeze({
  maxActions: 5000,
  maxCoord: 20000,
  maxDelayMs: 3_600_000,
  maxDurationMs: 60_000,
  maxName: 60,
});
export const ACTION_TYPES = Object.freeze(['tap', 'hold', 'swipe']);
export const TYPE_LABEL = Object.freeze({ tap: 'แตะ', hold: 'กดค้าง', swipe: 'ปัด' });
const DEFAULT_DURATION = { tap: 50, hold: 600, swipe: 300 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function emptyStats() {
  return { runs: 0, loops: 0, timeMs: 0, lastRunAt: null, lastResult: null };
}

export function sanitizeAction(raw, index = 0) {
  const where = `การกระทำที่ ${index + 1}`;
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { action: null, errors: [`${where}: รูปแบบไม่ถูกต้อง`] };
  }
  const type = raw.type;
  if (!ACTION_TYPES.includes(type)) errors.push(`${where}: ชนิด "${String(type)}" ไม่รองรับ`);
  const num = (key, min, max, label, def) => {
    let v = raw[key];
    if (v === undefined && def !== undefined) v = def;
    if (!isNum(v) || v < min || v > max) {
      errors.push(`${where}: ${label} ต้องเป็นตัวเลข ${min}–${max}`);
      return min;
    }
    return Math.round(v);
  };
  const a = { type };
  a.x = num('x', 0, LIMITS.maxCoord, 'พิกัด X');
  a.y = num('y', 0, LIMITS.maxCoord, 'พิกัด Y');
  if (type === 'swipe') {
    a.x2 = num('x2', 0, LIMITS.maxCoord, 'พิกัด X ปลายทาง');
    a.y2 = num('y2', 0, LIMITS.maxCoord, 'พิกัด Y ปลายทาง');
  }
  a.delayMs = num('delayMs', 0, LIMITS.maxDelayMs, 'เวลารอก่อนทำ (ms)', 0);
  a.durationMs = num('durationMs', 1, LIMITS.maxDurationMs, 'ระยะเวลา (ms)', DEFAULT_DURATION[type]);
  return { action: errors.length ? null : a, errors };
}

export function computeDuration(actions) {
  return actions.reduce((s, a) => s + a.delayMs + a.durationMs, 0);
}

export function validateMacro(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['ข้อมูลไม่ใช่ Macro ที่ถูกต้อง'], macro: null };
  }
  if (raw.schema !== undefined && raw.schema !== MACRO_SCHEMA) {
    errors.push(`schema "${String(raw.schema)}" ไม่รองรับ (ต้องเป็น ${MACRO_SCHEMA})`);
  }
  const actions = [];
  if (!Array.isArray(raw.actions)) errors.push('ไม่พบรายการ actions');
  else if (raw.actions.length === 0) errors.push('Macro นี้ไม่มีการกระทำเลย');
  else if (raw.actions.length > LIMITS.maxActions) errors.push(`มีการกระทำมากเกิน ${LIMITS.maxActions} รายการ`);
  else {
    raw.actions.forEach((r, i) => {
      const res = sanitizeAction(r, i);
      if (res.action) actions.push(res.action);
      else if (errors.length < 10) errors.push(...res.errors);
    });
  }
  let screen = null;
  if (raw.screen !== undefined && raw.screen !== null) {
    const { width, height } = raw.screen;
    if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
        width <= LIMITS.maxCoord && height <= LIMITS.maxCoord) {
      screen = { width, height };
    } else errors.push('ค่า screen (width/height) ไม่ถูกต้อง');
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 10), macro: null };

  const now = new Date().toISOString();
  let name = typeof raw.name === 'string' ? raw.name.trim().slice(0, LIMITS.maxName) : '';
  if (!name) name = 'Macro ไม่มีชื่อ';
  const stats = raw.stats && typeof raw.stats === 'object' ? { ...emptyStats(), ...raw.stats } : emptyStats();
  const macro = {
    schema: MACRO_SCHEMA,
    id: typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 80 ? raw.id : newId(),
    name,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    screen,
    actions,
    durationMs: computeDuration(actions),
    stats,
  };
  return { ok: true, errors: [], macro };
}

/** ตัดข้อมูลสถิติออก — ใช้ตอนส่งออกไฟล์ / ส่งให้ Companion */
export function exportMacro(macro) {
  const { stats, ...rest } = macro; // eslint-disable-line no-unused-vars
  return { ...rest, schema: MACRO_SCHEMA };
}

export function serializeMacro(macro) {
  return JSON.stringify(exportMacro(macro), null, 2);
}

export function serializeBundle(macros) {
  return JSON.stringify(
    { schema: BUNDLE_SCHEMA, exportedAt: new Date().toISOString(), macros: macros.map(exportMacro) },
    null,
    2,
  );
}

/** แปลงข้อความ JSON ที่นำเข้า → { macros: [...], errors: [...] } (รองรับ Macro เดี่ยว / bundle / array) */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { macros: [], errors: ['ไฟล์ไม่ใช่ JSON ที่ถูกต้อง'] };
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && data.schema === BUNDLE_SCHEMA && Array.isArray(data.macros)) list = data.macros;
  else list = [data];
  const macros = [];
  const errors = [];
  list.forEach((raw, i) => {
    const r = validateMacro(raw);
    if (r.ok) {
      r.macro.stats = emptyStats();
      macros.push(r.macro);
    } else errors.push(`Macro ลำดับที่ ${i + 1}: ${r.errors.join('; ')}`);
  });
  return { macros, errors };
}

export function duplicateMacro(macro) {
  const now = new Date().toISOString();
  return {
    ...structuredCloneSafe(macro),
    id: newId(),
    name: `${macro.name} (สำเนา)`.slice(0, LIMITS.maxName),
    createdAt: now,
    updatedAt: now,
    stats: emptyStats(),
  };
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

export function blankAction(type = 'tap', screen = null) {
  const cx = screen ? Math.round(screen.width / 2) : 540;
  const cy = screen ? Math.round(screen.height / 2) : 1200;
  const a = { type, x: cx, y: cy, delayMs: 500, durationMs: DEFAULT_DURATION[type] };
  if (type === 'swipe') {
    a.x2 = cx;
    a.y2 = Math.max(0, cy - 400);
  }
  return a;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} ชม.`);
  if (m) parts.push(`${m} นาที`);
  if (s || parts.length === 0) parts.push(`${s} วินาที`);
  return parts.join(' ');
}
