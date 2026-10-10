package app.autofarm.companion

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import androidx.activity.ComponentActivity
import kotlin.math.hypot

/**
 * หน้าทดสอบการแตะ: แสดงจุดที่ได้รับการแตะ/กดค้าง/ปัด พร้อมพิกัดและตัวนับ
 * ใช้พิสูจน์ว่า "บันทึก → เล่นซ้ำ" ควบคุมหน้าจอจริง โดยไม่ต้องพึ่งเกม
 */
class TestPadActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(PadView(this))
    }

    private class Dot(val x: Float, val y: Float, val x2: Float, val y2: Float, val kind: Int, val t: Long)

    @SuppressLint("ViewConstructor")
    private class PadView(ctx: Context) : View(ctx) {
        private val dots = ArrayList<Dot>()
        private var taps = 0
        private var holds = 0
        private var swipes = 0
        private var last = "—"
        private var downT = 0L
        private var sx = 0f
        private var sy = 0f
        private val slop = Util.dp(ctx, 24)
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)

        init { setBackgroundColor(0xFF070A12.toInt()) }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (e.x > width - Util.dp(context, 110) && e.y < Util.dp(context, 120)) {
                        taps = 0; holds = 0; swipes = 0; last = "รีเซ็ตแล้ว"; dots.clear(); invalidate()
                        return true
                    }
                    downT = e.eventTime; sx = e.rawX; sy = e.rawY
                    dots.add(Dot(e.x, e.y, e.x, e.y, 0, SystemClock.uptimeMillis()))
                    invalidate()
                }
                MotionEvent.ACTION_UP -> {
                    val dur = e.eventTime - downT
                    val moved = hypot((e.rawX - sx).toDouble(), (e.rawY - sy).toDouble())
                    val kind = when {
                        moved > slop -> { swipes++; 2 }
                        dur >= 500 -> { holds++; 1 }
                        else -> { taps++; 0 }
                    }
                    last = "${listOf("แตะ", "กดค้าง", "ปัด")[kind]} (${sx.toInt()},${sy.toInt()})→(${e.rawX.toInt()},${e.rawY.toInt()}) ${dur}ms"
                    dots.add(Dot(sx - (rawOffsetX()), sy - rawOffsetY(), e.x, e.y, kind + 1, SystemClock.uptimeMillis()))
                    invalidate()
                }
            }
            return true
        }

        private fun rawOffsetX(): Float { val l = IntArray(2); getLocationOnScreen(l); return l[0].toFloat() }
        private fun rawOffsetY(): Float { val l = IntArray(2); getLocationOnScreen(l); return l[1].toFloat() }

        override fun onDraw(c: Canvas) {
            val now = SystemClock.uptimeMillis()
            dots.removeAll { now - it.t > 4000 }
            val colors = intArrayOf(0xFF00F5A0.toInt(), 0xFFFFB020.toInt(), 0xFF8B5CF6.toInt())
            for (d in dots) {
                val a = (255 * (1 - (now - d.t) / 4000f)).toInt().coerceIn(0, 255)
                if (d.kind == 0) {
                    p.style = Paint.Style.STROKE; p.strokeWidth = 4f; p.color = Color.argb(a, 255, 255, 255)
                    c.drawCircle(d.x, d.y, 18f, p)
                } else {
                    val col = colors[d.kind - 1]
                    p.color = Color.argb(a, Color.red(col), Color.green(col), Color.blue(col))
                    p.style = Paint.Style.FILL
                    c.drawCircle(d.x, d.y, 26f, p)
                    if (d.kind == 3) { p.style = Paint.Style.STROKE; p.strokeWidth = 8f; c.drawLine(d.x, d.y, d.x2, d.y2, p) }
                }
            }
            p.style = Paint.Style.FILL
            p.color = 0xFFE8ECFF.toInt(); p.textSize = Util.dp(context, 16).toFloat()
            val top = Util.dp(context, 70).toFloat()
            c.drawText("Test Pad — แตะ: $taps  กดค้าง: $holds  ปัด: $swipes", Util.dp(context, 16).toFloat(), top, p)
            p.color = 0xFF8F9BC7.toInt(); p.textSize = Util.dp(context, 13).toFloat()
            c.drawText("ล่าสุด: $last", Util.dp(context, 16).toFloat(), top + Util.dp(context, 24), p)
            c.drawText("บันทึกบนหน้านี้ แล้วเล่นซ้ำ — ตัวเลขต้องเพิ่มตามที่บันทึก", Util.dp(context, 16).toFloat(), top + Util.dp(context, 46), p)
            p.color = 0xFFFF2D55.toInt()
            c.drawText("[รีเซ็ต]", (width - Util.dp(context, 100)).toFloat(), Util.dp(context, 40).toFloat(), p)
            if (dots.isNotEmpty()) postInvalidateOnAnimation()
        }
    }
}
