# โปรโตคอล Dashboard ↔ Companion

- เซิร์ฟเวอร์: `http://127.0.0.1:8765` (bind เฉพาะ loopback) ทำงานภายใน Accessibility Service
- `GET /` และไฟล์เว็บอื่น ๆ: เสิร์ฟ Dashboard (ไม่ต้องใช้โทเค็น)
- `/api/*`: ต้องมี header `X-AFR-Token: <โทเค็น>` และถ้ามี `Origin` ต้องเป็น `http://127.0.0.1:8765` หรือ `http://localhost:8765`
- ไม่ส่ง CORS header → เว็บไซต์อื่นเรียกข้ามไซต์ไม่ได้
- ทุกคำตอบเป็น JSON: สำเร็จ `{"ok":true,...}` / ผิดพลาด `{"ok":false,"error":"code","message":"ข้อความไทย"}`

| Method | Path | Body | ผล |
|---|---|---|---|
| GET | `/api/status` | – | สถานะ (ดูด้านล่าง) |
| POST | `/api/record/start` | `{"name":"..."}` | เริ่มบันทึก (เลเยอร์โปร่งใส + แถบลอย) |
| POST | `/api/record/pause` / `resume` | – | พัก/ต่อ |
| POST | `/api/record/stop` | – | จบ → `{"recording": <macro>}` และเก็บสำเนาไว้ใน `/api/recordings` |
| GET | `/api/recordings` | – | การบันทึกที่ Dashboard ยังไม่ได้ดึง |
| DELETE | `/api/recordings/{id}` | – | ลบหลังดึงไปแล้ว |
| POST | `/api/replay/start` | `{"macro":<macro>,"loops":N,"speed":1,"startDelayMs":0,"loopDelayMs":0}` | `loops=0` = ไม่จำกัด, `speed` 0.25–4 |
| POST | `/api/replay/pause` / `resume` / `stop` | – | ควบคุมการเล่นซ้ำ |

รหัสผิดพลาดที่พบบ่อย: `bad_token`(401) `forbidden_origin`/`bad_host`(403) `busy`/`not_recording`/`orientation_mismatch`(409) `bad_macro`/`bad_params`(400)

## `/api/status`

```json
{
  "ok": true, "version": "1.0.0", "apiVersion": 1,
  "state": "idle | recording | recording_paused | replaying | replay_paused",
  "screen": {"width": 1080, "height": 2400},
  "recordingsPending": 0,
  "recording": {"actions": 3, "elapsedMs": 4500},
  "replay": {"macroId": "...", "macroName": "...", "loop": 2, "loops": 10, "actionIndex": 3, "actionCount": 20, "elapsedMs": 9000, "speed": 1.0},
  "lastRun": {"runId": "...", "macroId": "...", "macroName": "...", "startedAt": "ISO", "endedAt": "ISO", "loopsDone": 10, "elapsedMs": 90000, "result": "completed | stopped | error", "error": "..."}
}
```

`recording` / `replay` / `lastRun` มีเฉพาะเมื่อเกี่ยวข้อง Dashboard ใช้ `lastRun.runId` เพื่อบันทึกสถิติครั้งละหนึ่งรอบการทำงาน

## รูปแบบไฟล์ Macro (`autofarm.macro/1`)

```json
{
  "schema": "autofarm.macro/1",
  "id": "uuid",
  "name": "ฟาร์มด่าน 1",
  "createdAt": "2026-10-10T12:00:00.000Z",
  "updatedAt": "2026-10-10T12:00:00.000Z",
  "screen": {"width": 1080, "height": 2400},
  "durationMs": 2760,
  "actions": [
    {"type": "tap",   "x": 540, "y": 1200, "delayMs": 800, "durationMs": 60},
    {"type": "hold",  "x": 100, "y": 200,  "delayMs": 100, "durationMs": 1500},
    {"type": "swipe", "x": 100, "y": 1000, "x2": 100, "y2": 400, "delayMs": 300, "durationMs": 400}
  ]
}
```

- `delayMs` = เวลารอหลังการกระทำก่อนหน้าจบ (ก่อนทำอันนี้) · `durationMs` = ระยะเวลาที่นิ้วแตะ/ปัด
- `screen` ใช้สเกลพิกัดเมื่อเล่นบนจอขนาดต่างกัน (ต้องเป็นแนวตั้ง/แนวนอนเดียวกัน)
- ไฟล์ส่งออกหลาย Macro: `{"schema":"autofarm.bundle/1","macros":[...]}`
- ขีดจำกัด: 5000 การกระทำ, พิกัด 0–20000, delay ≤ 1 ชม., duration ≤ 60 วินาที
