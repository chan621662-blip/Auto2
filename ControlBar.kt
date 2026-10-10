package app.autofarm.companion

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/** แถบควบคุมลอยบนหน้าจอเกม (พัก/หยุด) — ลากที่ข้อความเพื่อย้ายตำแหน่ง */
class ControlBar(private val ctx: Context, private val wm: WindowManager) {
    private val root = LinearLayout(ctx)
    private val label = TextView(ctx)
    private val buttons = LinkedHashMap<String, TextView>()
    private var shown = false

    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.END
        x = Util.dp(ctx, 8)
        y = Util.dp(ctx, 56)
    }

    init {
        root.orientation = LinearLayout.HORIZONTAL
        root.gravity = Gravity.CENTER_VERTICAL
        root.setPadding(Util.dp(ctx, 8), Util.dp(ctx, 6), Util.dp(ctx, 8), Util.dp(ctx, 6))
        root.background = GradientDrawable().apply {
            setColor(0xEE0B0F1A.toInt())
            cornerRadius = Util.dp(ctx, 28).toFloat()
            setStroke(Util.dp(ctx, 2), 0xFF00F5A0.toInt())
        }
        label.setTextColor(Color.WHITE)
        label.textSize = 14f
        label.gravity = Gravity.CENTER_VERTICAL
        label.minHeight = Util.dp(ctx, 48)
        label.setPadding(Util.dp(ctx, 10), 0, Util.dp(ctx, 6), 0)
        root.addView(label)
        installDrag()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installDrag() {
        var lastX = 0f
        var lastY = 0f
        label.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { lastX = e.rawX; lastY = e.rawY }
                MotionEvent.ACTION_MOVE -> {
                    params.x -= (e.rawX - lastX).toInt() // gravity END: x คือระยะจากขวา
                    params.y += (e.rawY - lastY).toInt()
                    lastX = e.rawX
                    lastY = e.rawY
                    if (shown) try { wm.updateViewLayout(root, params) } catch (_: Exception) {}
                }
            }
            true
        }
    }

    fun addButton(key: String, text: String, color: Int, onClick: () -> Unit) {
        val b = TextView(ctx).apply {
            this.text = text
            setTextColor(Color.BLACK)
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            minHeight = Util.dp(ctx, 48)
            minWidth = Util.dp(ctx, 64)
            setPadding(Util.dp(ctx, 12), 0, Util.dp(ctx, 12), 0)
            background = GradientDrawable().apply {
                setColor(color)
                cornerRadius = Util.dp(ctx, 24).toFloat()
            }
            setOnClickListener { onClick() }
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { marginStart = Util.dp(ctx, 6) }
        root.addView(b, lp)
        buttons[key] = b
    }

    fun setLabel(t: String) { label.text = t }
    fun setButtonText(key: String, t: String) { buttons[key]?.text = t }

    fun show() {
        if (shown) return
        wm.addView(root, params)
        shown = true
    }

    fun hide() {
        if (!shown) return
        try { wm.removeView(root) } catch (_: Exception) {}
        shown = false
    }
}
