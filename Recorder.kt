package app.autofarm.companion

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import kotlin.math.hypot

/**
 * โหมดบันทึก: วางเลเยอร์โปร่งใสเต็มจอ (TYPE_ACCESSIBILITY_OVERLAY) เพื่อรับการแตะของผู้ใช้
 * เมื่อยกนิ้ว → บันทึก action แล้ว "ส่งต่อ" ให้เกมด้วย dispatchGesture ทันที (ชั่วคราวทำให้เลเยอร์ไม่รับสัมผัสระหว่างส่งต่อ)
 * ข้อจำกัด: นิ้วเดียวเท่านั้น และเกมจะได้รับการแตะหลังยกนิ้ว (ล่าช้าเท่าระยะเวลาที่แตะ)
 * ทุกเมธอดต้องเรียกบน main thread
 */
class Recorder(private val service: AutoFarmService) {
    enum class State { IDLE, RECORDING, PAUSED }

    var state = State.IDLE
        private set

    private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val handler = Handler(Looper.getMainLooper())
    private var capture: View? = null
    private var captureParams: WindowManager.LayoutParams? = null
    private var bar: ControlBar? = null

    private val actions = ArrayList<Action>()
    private var name = ""
    private var screenW = 0
    private var screenH = 0
    private var lastEnd = 0L
    private var elapsedBefore = 0L
    private var segmentStart = 0L

    val actionCount: Int get() = actions.size

    fun elapsedMs(): Long =
        if (state == State.RECORDING) elapsedBefore + (SystemClock.uptimeMillis() - segmentStart) else elapsedBefore

    fun start(name: String) {
        if (state != State.IDLE) return
        this.name = name.trim().take(60).ifEmpty { "บันทึกใหม่" }
        actions.clear()
        val (w, h) = Util.realScreen(service)
        screenW = w
        screenH = h
        elapsedBefore = 0L
        segmentStart = SystemClock.uptimeMillis()
        lastEnd = segmentStart

        val view = CaptureView(service)
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        wm.addView(view, p)
        capture = view
        captureParams = p

        // แถบควบคุมเพิ่มทีหลัง → อยู่ชั้นบนสุด รับสัมผัสก่อนเลเยอร์บันทึก
        bar = ControlBar(service, wm).also { b ->
            b.addButton("pause", "⏸ พัก", 0xFFFFB020.toInt()) { togglePause() }
            b.addButton("stop", "■ บันทึก", 0xFF00F5A0.toInt()) { service.stopRecordingFromBar() }
            b.show()
        }
        state = State.RECORDING
        updateLabel()
    }

    fun pause() {
        if (state != State.RECORDING) return
        elapsedBefore += SystemClock.uptimeMillis() - segmentStart
        state = State.PAUSED
        setTouchable(false) // ปล่อยให้สัมผัสทะลุไปที่เกมโดยตรง และไม่บันทึก
        bar?.setButtonText("pause", "⏵ ต่อ")
        updateLabel()
    }

    fun resume() {
        if (state != State.PAUSED) return
        segmentStart = SystemClock.uptimeMillis()
        lastEnd = segmentStart // เวลาที่พักไม่นับเป็นเวลารอ
        state = State.RECORDING
        setTouchable(true)
        bar?.setButtonText("pause", "⏸ พัก")
        updateLabel()
    }

    private fun togglePause() { if (state == State.RECORDING) pause() else resume() }

    /** จบการบันทึก คืน Macro (ว่างได้ถ้าไม่ได้บันทึกอยู่) */
    fun stop(): Macro? {
        if (state == State.IDLE) return null
        if (state == State.RECORDING) elapsedBefore += SystemClock.uptimeMillis() - segmentStart
        teardown()
        state = State.IDLE
        return Macro(Util.newId(), name, screenW, screenH, ArrayList(actions), Util.isoNow())
    }

    private fun teardown() {
        bar?.hide()
        bar = null
        capture?.let { try { wm.removeView(it) } catch (_: Exception) {} }
        capture = null
        captureParams = null
    }

    private fun updateLabel() {
        bar?.setLabel(if (state == State.RECORDING) "● REC ${actions.size}" else "⏸ พัก ${actions.size}")
    }

    private fun setTouchable(on: Boolean) {
        val v = capture ?: return
        val p = captureParams ?: return
        p.flags = if (on) p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        else p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        try { wm.updateViewLayout(v, p) } catch (_: Exception) {}
    }

    private fun onGestureFinished(downTime: Long, upTime: Long, sx: Float, sy: Float, ex: Float, ey: Float) {
        if (state != State.RECORDING) return
        val dur = (upTime - downTime).coerceAtLeast(1L)
        val moved = hypot((ex - sx).toDouble(), (ey - sy).toDouble())
        val slop = Util.dp(service, 24)
        val delay = (downTime - lastEnd).coerceIn(0L, Macro.MAX_DELAY)
        lastEnd = upTime
        val a = when {
            moved > slop -> Action("swipe", sx.toInt(), sy.toInt(), ex.toInt(), ey.toInt(), delay, dur.coerceIn(50L, 10_000L))
            dur >= 500L -> Action("hold", sx.toInt(), sy.toInt(), sx.toInt(), sy.toInt(), delay, dur.coerceAtMost(Macro.MAX_DURATION))
            else -> Action("tap", sx.toInt(), sy.toInt(), sx.toInt(), sy.toInt(), delay, dur.coerceIn(30L, 499L))
        }
        actions.add(a)
        updateLabel()
        forward(a)
        if (actions.size >= Macro.MAX_ACTIONS) service.stopRecordingFromBar()
    }

    /** ส่งต่อการแตะที่เพิ่งบันทึกให้เกม โดยทำให้เลเยอร์ไม่รับสัมผัสระหว่างนั้นเพื่อกันการแตะซ้อน */
    private fun forward(a: Action) {
        setTouchable(false)
        val restore = Runnable { setTouchable(state == State.RECORDING) }
        handler.postDelayed(restore, a.durationMs + 1500L) // กันเหนียวถ้า callback ไม่กลับมา
        service.dispatchStroke(a.x, a.y, a.x2, a.y2, a.durationMs) {
            handler.removeCallbacks(restore)
            restore.run()
        }
    }

    @SuppressLint("ViewConstructor")
    private inner class CaptureView(ctx: Context) : View(ctx) {
        private var tracking = false
        private var pointerId = -1
        private var downTime = 0L
        private var sx = 0f
        private var sy = 0f

        init {
            // กรอบแดงบางๆ รอบจอ เพื่อให้ผู้ใช้รู้ว่ากำลังบันทึกอยู่
            background = GradientDrawable().apply {
                setColor(Color.TRANSPARENT)
                setStroke(Util.dp(ctx, 2), 0xFFFF2D55.toInt())
            }
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    tracking = true
                    pointerId = e.getPointerId(0)
                    downTime = e.eventTime
                    sx = e.rawX
                    sy = e.rawY
                }
                MotionEvent.ACTION_UP -> {
                    if (tracking) onGestureFinished(downTime, e.eventTime, sx, sy, e.rawX, e.rawY)
                    tracking = false
                }
                MotionEvent.ACTION_POINTER_UP -> {
                    // นิ้วแรกยกก่อน: ปิดการแตะนี้ (รองรับนิ้วเดียวเท่านั้น)
                    if (tracking && e.getPointerId(e.actionIndex) == pointerId) {
                        onGestureFinished(downTime, e.eventTime, sx, sy, e.rawX, e.rawY)
                        tracking = false
                    }
                }
                MotionEvent.ACTION_CANCEL -> tracking = false
            }
            return true
        }
    }
}
