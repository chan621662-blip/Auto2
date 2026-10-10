package app.autofarm.companion

import android.content.Context
import android.os.SystemClock
import android.view.WindowManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * โหมดเล่นซ้ำ: สั่งแตะจริงด้วย AccessibilityService.dispatchGesture ตามลำดับที่บันทึกไว้
 * ทำงานบน main thread (coroutine) — ทุกเมธอดสาธารณะต้องเรียกบน main thread
 */
class Replayer(private val service: AutoFarmService) {
    enum class State { IDLE, RUNNING, PAUSED }

    @Volatile
    var state = State.IDLE
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var job: Job? = null
    private var bar: ControlBar? = null

    var macro: Macro? = null
        private set
    var loops = 1
        private set
    var speed = 1.0
        private set
    var currentLoop = 0
        private set
    var actionIndex = 0
        private set
    private var loopsDone = 0
    private var startedUptime = 0L
    private var startedIso = ""
    private var pausedTotal = 0L
    private var pauseStart = 0L
    var lastRun: JSONObject? = null
        private set

    fun elapsedMs(): Long {
        if (state == State.IDLE) return 0L
        val pausedNow = if (state == State.PAUSED) SystemClock.uptimeMillis() - pauseStart else 0L
        return SystemClock.uptimeMillis() - startedUptime - pausedTotal - pausedNow
    }

    fun start(m: Macro, loops: Int, speed: Double, startDelayMs: Long, loopDelayMs: Long) {
        if (state != State.IDLE) throw ApiException(409, "busy", "กำลังเล่นซ้ำอยู่แล้ว")
        if (loops < 0 || loops > 100_000) throw ApiException(400, "bad_params", "จำนวนรอบต้องอยู่ระหว่าง 0–100000 (0 = ไม่จำกัด)")
        if (speed < 0.25 || speed > 4.0) throw ApiException(400, "bad_params", "ความเร็วต้องอยู่ระหว่าง 0.25–4")
        if (startDelayMs < 0 || startDelayMs > Macro.MAX_DELAY || loopDelayMs < 0 || loopDelayMs > Macro.MAX_DELAY) {
            throw ApiException(400, "bad_params", "ค่าหน่วงเวลาไม่ถูกต้อง")
        }
        val (cw, ch) = Util.realScreen(service)
        if (m.screenW > 0 && m.screenH > 0 && ((m.screenW > m.screenH) != (cw > ch))) {
            throw ApiException(409, "orientation_mismatch", "ทิศทางหน้าจอไม่ตรงกับตอนบันทึก (แนวตั้ง/แนวนอน) — หมุนจอให้ตรงกันก่อน")
        }
        val sx = if (m.screenW > 0) cw.toDouble() / m.screenW else 1.0
        val sy = if (m.screenH > 0) ch.toDouble() / m.screenH else 1.0

        macro = m
        this.loops = loops
        this.speed = speed
        currentLoop = 0
        actionIndex = 0
        loopsDone = 0
        pausedTotal = 0L
        startedUptime = SystemClock.uptimeMillis()
        startedIso = Util.isoNow()
        state = State.RUNNING
        showBar()
        job = scope.launch { runLoop(m, loops, speed, startDelayMs, loopDelayMs, sx, sy, cw, ch) }
    }

    fun pause() {
        if (state != State.RUNNING) return
        pauseStart = SystemClock.uptimeMillis()
        state = State.PAUSED
        bar?.setButtonText("pause", "⏵ ต่อ")
        updateBar()
    }

    fun resume() {
        if (state != State.PAUSED) return
        pausedTotal += SystemClock.uptimeMillis() - pauseStart
        state = State.RUNNING
        bar?.setButtonText("pause", "⏸ พัก")
        updateBar()
    }

    fun stop() {
        if (state == State.IDLE) return
        job?.cancel()
        finish("stopped", null)
    }

    fun shutdown() {
        stop()
        scope.cancel()
    }

    private suspend fun runLoop(m: Macro, loops: Int, speed: Double, startDelayMs: Long, loopDelayMs: Long, sx: Double, sy: Double, cw: Int, ch: Int) {
        var reason = "completed"
        var error: String? = null
        var failures = 0
        try {
            sleepActive(startDelayMs)
            var loop = 1
            while (loops == 0 || loop <= loops) {
                currentLoop = loop
                updateBar()
                for ((i, a) in m.actions.withIndex()) {
                    actionIndex = i
                    updateBar()
                    sleepActive((a.delayMs / speed).toLong())
                    val x1 = (a.x * sx).roundToInt().coerceIn(0, cw - 1)
                    val y1 = (a.y * sy).roundToInt().coerceIn(0, ch - 1)
                    val x2 = (a.x2 * sx).roundToInt().coerceIn(0, cw - 1)
                    val y2 = (a.y2 * sy).roundToInt().coerceIn(0, ch - 1)
                    val dur = if (a.type == "swipe") max(50L, (a.durationMs / speed).toLong()) else a.durationMs
                    val ok = gesture(x1, y1, x2, y2, dur)
                    if (ok) {
                        failures = 0
                    } else if (++failures >= 5) {
                        throw IllegalStateException("ระบบปฏิเสธการแตะซ้ำหลายครั้ง — ตรวจสอบว่า Accessibility Service ยังเปิดอยู่")
                    }
                }
                loopsDone = loop
                if (loops == 0 || loop < loops) sleepActive(loopDelayMs)
                loop++
            }
        } catch (e: CancellationException) {
            reason = "stopped"
            throw e
        } catch (e: Exception) {
            reason = "error"
            error = e.message ?: e.javaClass.simpleName
        } finally {
            finish(reason, error)
        }
    }

    /** รอ ms โดยหยุดนับเมื่อพัก */
    private suspend fun sleepActive(ms: Long) {
        var remaining = ms
        while (remaining > 0) {
            if (state == State.PAUSED) { delay(100); continue }
            val step = minOf(remaining, 50L)
            delay(step)
            remaining -= step
        }
        while (state == State.PAUSED) delay(100)
    }

    private suspend fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, dur: Long): Boolean =
        suspendCancellableCoroutine { cont ->
            service.dispatchStroke(x1, y1, x2, y2, dur) { ok -> if (cont.isActive) cont.resume(ok) }
        }

    private fun finish(reason: String, error: String?) {
        if (state == State.IDLE) return
        val run = JSONObject()
            .put("runId", Util.newId())
            .put("macroId", macro?.id ?: "")
            .put("macroName", macro?.name ?: "")
            .put("startedAt", startedIso)
            .put("endedAt", Util.isoNow())
            .put("loopsDone", loopsDone)
            .put("elapsedMs", elapsedMs())
            .put("result", reason)
        if (error != null) run.put("error", error)
        lastRun = run
        state = State.IDLE
        bar?.hide()
        bar = null
    }

    private fun showBar() {
        bar = ControlBar(service, wm).also { b ->
            b.addButton("pause", "⏸ พัก", 0xFFFFB020.toInt()) { if (state == State.RUNNING) pause() else resume() }
            b.addButton("stop", "■ หยุด", 0xFFFF2D55.toInt()) { stop() }
            b.show()
        }
        updateBar()
    }

    private fun updateBar() {
        val total = if (loops == 0) "∞" else loops.toString()
        val n = macro?.actions?.size ?: 0
        val prefix = if (state == State.PAUSED) "⏸" else "▶"
        bar?.setLabel("$prefix รอบ $currentLoop/$total • ${actionIndex + 1}/$n")
    }
}
