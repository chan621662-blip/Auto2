package app.autofarm.companion

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * หัวใจของ Companion: Accessibility Service ที่
 *  - บันทึกการแตะข้ามแอป (Recorder: เลเยอร์โปร่งใส + ส่งต่อ)
 *  - เล่นซ้ำการแตะจริง (Replayer: dispatchGesture)
 *  - เปิดเซิร์ฟเวอร์ HTTP บน 127.0.0.1 ให้เว็บ Dashboard ควบคุม (LocalServer)
 * ไม่อ่านเนื้อหาหน้าจอ ไม่ใช้ event ของแอปอื่น
 */
class AutoFarmService : AccessibilityService() {
    companion object {
        const val PORT = 8765
        const val VERSION = "1.0.0"
        private const val TAG = "AutoFarmService"

        @Volatile
        var instance: AutoFarmService? = null
            private set

        @Volatile
        var serverError: String? = null
            private set

        /** โทเค็นสุ่มของเครื่องนี้ — สร้างครั้งแรกแล้วเก็บไว้ในที่เก็บส่วนตัวของแอป */
        @Synchronized
        fun token(ctx: Context): String {
            val prefs = ctx.applicationContext.getSharedPreferences("afr", Context.MODE_PRIVATE)
            prefs.getString("token", null)?.let { return it }
            val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
            val t = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            prefs.edit().putString("token", t).apply()
            return t
        }
    }

    private val main = Handler(Looper.getMainLooper())
    lateinit var recorder: Recorder
        private set
    lateinit var replayer: Replayer
        private set
    lateinit var store: RecordingStore
        private set
    private var server: LocalServer? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        store = RecordingStore(this)
        recorder = Recorder(this)
        replayer = Replayer(this)
        try {
            server = LocalServer(this, token(this)).also { it.start(5000, false) }
            serverError = null
        } catch (e: Exception) {
            Log.e(TAG, "เปิดเซิร์ฟเวอร์ไม่สำเร็จ", e)
            serverError = "เปิดพอร์ต $PORT ไม่สำเร็จ: ${e.message}"
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* ไม่ใช้ event ใดๆ */ }

    override fun onInterrupt() { /* ไม่มี feedback ที่ต้องหยุด */ }

    override fun onUnbind(intent: Intent?): Boolean {
        shutdown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        if (instance !== this) return
        try { replayer.shutdown() } catch (_: Exception) {}
        try { recorder.stop() } catch (_: Exception) {}
        try { server?.stop() } catch (_: Exception) {}
        server = null
        instance = null
    }

    /** รันบน main thread แล้วรอผล (เรียกจากเธรดของเซิร์ฟเวอร์) */
    fun <T> runOnMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask { block() }
        main.post(task)
        try {
            return task.get(5, TimeUnit.SECONDS)
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        } catch (e: java.util.concurrent.TimeoutException) {
            throw ApiException(500, "timeout", "แอป Companion ตอบสนองช้าเกินไป")
        }
    }

    /** ส่งการแตะ/ปัด 1 ครั้งผ่าน dispatchGesture — done(true) เมื่อระบบทำเสร็จ */
    fun dispatchStroke(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long, done: (Boolean) -> Unit) {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            if (x1 != x2 || y1 != y2) lineTo(x2.toFloat(), y2.toFloat())
        }
        val dur = durationMs.coerceIn(1L, GestureDescription.getMaxGestureDuration())
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, dur))
            .build()
        val accepted = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { done(true) }
            override fun onCancelled(gestureDescription: GestureDescription?) { done(false) }
        }, null)
        if (!accepted) done(false)
    }

    /* ---------- สั่งงานจาก API / แถบลอย (main thread) ---------- */

    fun startRecording(name: String) {
        if (replayer.state != Replayer.State.IDLE) throw ApiException(409, "busy", "กำลังเล่นซ้ำอยู่ ต้องหยุดก่อน")
        if (recorder.state != Recorder.State.IDLE) throw ApiException(409, "busy", "กำลังบันทึกอยู่แล้ว")
        recorder.start(name)
    }

    fun pauseRecording() {
        if (recorder.state != Recorder.State.RECORDING) throw ApiException(409, "not_recording", "ไม่ได้กำลังบันทึกอยู่")
        recorder.pause()
    }

    fun resumeRecording() {
        if (recorder.state != Recorder.State.PAUSED) throw ApiException(409, "not_paused", "การบันทึกไม่ได้พักอยู่")
        recorder.resume()
    }

    fun stopRecording(): Macro {
        val m = recorder.stop() ?: throw ApiException(409, "not_recording", "ยังไม่ได้เริ่มบันทึก")
        if (m.actions.isEmpty()) throw ApiException(409, "empty_recording", "ไม่มีการแตะที่ถูกบันทึกเลย")
        store.save(m)
        return m
    }

    /** ใช้กับปุ่มบนแถบลอยในเกม: บันทึกลงที่เก็บชั่วคราว Dashboard จะดึงไปเองเมื่อเปิดอีกครั้ง */
    fun stopRecordingFromBar() {
        try {
            val m = stopRecording()
            Toast.makeText(this, "บันทึกแล้ว ${m.actions.size} การกระทำ — เปิดแอป Auto Farm เพื่อดู", Toast.LENGTH_LONG).show()
        } catch (e: ApiException) {
            Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
        }
    }

    fun startReplay(m: Macro, loops: Int, speed: Double, startDelayMs: Long, loopDelayMs: Long) {
        if (recorder.state != Recorder.State.IDLE) throw ApiException(409, "busy", "กำลังบันทึกอยู่ ต้องหยุดก่อน")
        replayer.start(m, loops, speed, startDelayMs, loopDelayMs)
    }

    fun statusJson(): JSONObject {
        val (w, h) = Util.realScreen(this)
        val state = when {
            recorder.state == Recorder.State.RECORDING -> "recording"
            recorder.state == Recorder.State.PAUSED -> "recording_paused"
            replayer.state == Replayer.State.RUNNING -> "replaying"
            replayer.state == Replayer.State.PAUSED -> "replay_paused"
            else -> "idle"
        }
        val o = JSONObject()
            .put("ok", true)
            .put("app", "autofarm-companion")
            .put("version", VERSION)
            .put("apiVersion", 1)
            .put("accessibilityEnabled", true)
            .put("state", state)
            .put("screen", JSONObject().put("width", w).put("height", h))
            .put("recordingsPending", store.count())
        if (state.startsWith("recording")) {
            o.put("recording", JSONObject().put("actions", recorder.actionCount).put("elapsedMs", recorder.elapsedMs()))
        }
        val m = replayer.macro
        if (state.startsWith("replay") && m != null) {
            o.put(
                "replay",
                JSONObject()
                    .put("macroId", m.id)
                    .put("macroName", m.name)
                    .put("loop", replayer.currentLoop)
                    .put("loops", replayer.loops)
                    .put("actionIndex", replayer.actionIndex)
                    .put("actionCount", m.actions.size)
                    .put("elapsedMs", replayer.elapsedMs())
                    .put("speed", replayer.speed),
            )
        }
        replayer.lastRun?.let { o.put("lastRun", it) }
        return o
    }
}
