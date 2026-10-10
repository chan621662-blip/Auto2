// ไคลเอนต์สื่อสารกับแอป Companion (HTTP บน 127.0.0.1 + โทเค็น)
import { exportMacro } from './macro.js';

export class ApiError extends Error {
  constructor(message, { code = 'unknown', status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const STATUS_TH = {
  401: 'โทเค็นไม่ถูกต้อง — เปิดแดชบอร์ดจากแอป Companion หรือวางโทเค็นใหม่ในหน้าตั้งค่า',
  403: 'Companion ปฏิเสธคำขอ (origin/host ไม่ได้รับอนุญาต)',
  404: 'ไม่พบ API ที่เรียก (เวอร์ชันแอปไม่ตรงกัน?)',
  409: 'ไม่สามารถทำได้ในสถานะปัจจุบัน',
  500: 'แอป Companion เกิดข้อผิดพลาดภายใน',
};

export class CompanionClient {
  constructor({ baseUrl = '', token = '', timeoutMs = 5000, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
  }

  async request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const headers = { 'X-AFR-Token': this.token };
    const init = { method, headers, signal: ctrl.signal, cache: 'no-store' };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (e) {
      throw new ApiError(
        e && e.name === 'AbortError'
          ? 'แอป Companion ไม่ตอบสนอง'
          : 'เชื่อมต่อแอป Companion ไม่ได้ — ตรวจสอบว่าเปิด Accessibility Service ของแอปแล้ว',
        { code: 'network' },
      );
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok || !data || data.ok === false) {
      throw new ApiError((data && data.message) || STATUS_TH[res.status] || `ข้อผิดพลาด HTTP ${res.status}`, {
        code: (data && data.error) || `http_${res.status}`,
        status: res.status,
      });
    }
    return data;
  }

  status() { return this.request('GET', '/api/status'); }

  recordStart(name) { return this.request('POST', '/api/record/start', { name }); }
  recordPause() { return this.request('POST', '/api/record/pause'); }
  recordResume() { return this.request('POST', '/api/record/resume'); }
  recordStop() { return this.request('POST', '/api/record/stop'); }

  async listRecordings() { return (await this.request('GET', '/api/recordings')).recordings || []; }
  deleteRecording(id) { return this.request('DELETE', `/api/recordings/${encodeURIComponent(id)}`); }

  replayStart(macro, { loops = 1, speed = 1, startDelayMs = 0, loopDelayMs = 0 } = {}) {
    return this.request('POST', '/api/replay/start', {
      macro: exportMacro(macro),
      loops,
      speed,
      startDelayMs,
      loopDelayMs,
    });
  }
  replayPause() { return this.request('POST', '/api/replay/pause'); }
  replayResume() { return this.request('POST', '/api/replay/resume'); }
  replayStop() { return this.request('POST', '/api/replay/stop'); }
}
