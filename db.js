// ชั้นเก็บข้อมูล: IndexedDB เป็นหลัก, ถ้าใช้ไม่ได้จะตกไปใช้ localStorage / หน่วยความจำ
import { emptyStats, newId, computeDuration } from './macro.js';

const DB_NAME = 'autofarm-recorder';
const DB_VERSION = 1;
let backendPromise = null;
export let backendName = 'none';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('macros')) d.createObjectStore('macros', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function idbBackend(db) {
  const run = (store, mode, fn) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let result;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  return {
    name: 'indexeddb',
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, key, value) =>
      run(store, 'readwrite', (s) => (store === 'macros' ? s.put(value) : s.put(value, key))),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  };
}

function memoryBackend() {
  const LS_KEY = 'afr:data';
  const hasLs = (() => {
    try { return typeof localStorage !== 'undefined' && !!localStorage.setItem; } catch { return false; }
  })();
  let data = { macros: {}, meta: {} };
  if (hasLs) {
    try { data = { macros: {}, meta: {}, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch { /* ignore */ }
  }
  const save = () => { if (hasLs) { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* quota */ } } };
  return {
    name: hasLs ? 'localstorage' : 'memory',
    all: async (store) => Object.values(data[store]).map((v) => JSON.parse(JSON.stringify(v))),
    get: async (store, key) => (data[store][key] === undefined ? undefined : JSON.parse(JSON.stringify(data[store][key]))),
    put: async (store, key, value) => { data[store][store === 'macros' ? value.id : key] = JSON.parse(JSON.stringify(value)); save(); },
    del: async (store, key) => { delete data[store][key]; save(); },
  };
}

function backend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      let b;
      if (typeof indexedDB !== 'undefined') {
        try { b = idbBackend(await openIdb()); } catch { b = null; }
      }
      b = b || memoryBackend();
      backendName = b.name;
      return b;
    })();
  }
  return backendPromise;
}

/** สำหรับเทสต์: บังคับให้เริ่มใหม่ด้วยหน่วยความจำ */
export function _resetForTests() {
  backendPromise = Promise.resolve(memoryBackend());
}

export async function listMacros() {
  const b = await backend();
  const all = await b.all('macros');
  return all.sort((a, c) => String(c.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getMacro(id) {
  return (await backend()).get('macros', id);
}

export async function saveMacro(macro) {
  const m = { ...macro, updatedAt: new Date().toISOString(), durationMs: computeDuration(macro.actions) };
  await (await backend()).put('macros', m.id, m);
  return m;
}

export async function deleteMacro(id) {
  await (await backend()).del('macros', id);
}

/** นำเข้า: ถ้า id ซ้ำกับที่มีอยู่ จะสร้าง id ใหม่เพื่อไม่ทับของเดิม */
export async function importMacros(macros) {
  const existing = new Set((await listMacros()).map((m) => m.id));
  const saved = [];
  for (const m of macros) {
    const copy = { ...m };
    if (existing.has(copy.id)) copy.id = newId();
    existing.add(copy.id);
    saved.push(await saveMacro(copy));
  }
  return saved;
}

export async function getSetting(key, def) {
  const v = await (await backend()).get('meta', key);
  return v === undefined ? def : v;
}

export async function setSetting(key, value) {
  await (await backend()).put('meta', key, value);
}

/** บันทึกผลการเล่นซ้ำ 1 ครั้งลงสถิติของ Macro */
export async function recordRun({ macroId, loops, timeMs, result, endedAt }) {
  const m = await getMacro(macroId);
  if (!m) return null;
  const s = { ...emptyStats(), ...(m.stats || {}) };
  s.runs += 1;
  s.loops += Math.max(0, loops | 0);
  s.timeMs += Math.max(0, timeMs | 0);
  s.lastRunAt = endedAt || new Date().toISOString();
  s.lastResult = result;
  return saveMacro({ ...m, stats: s, updatedAt: m.updatedAt });
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
