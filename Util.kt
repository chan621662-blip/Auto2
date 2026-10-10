package app.autofarm.companion

import android.content.Context
import android.util.DisplayMetrics
import android.view.WindowManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** ข้อผิดพลาดที่แปลงเป็น HTTP response ให้ Dashboard (message เป็นภาษาไทย) */
class ApiException(val http: Int, val code: String, message: String) : Exception(message)

object Util {
    fun dp(ctx: Context, v: Int): Int = (v * ctx.resources.displayMetrics.density + 0.5f).toInt()

    /** ขนาดหน้าจอจริง (พิกเซล) รวมแถบสถานะ/นำทาง — ตรงกับพิกัดที่ dispatchGesture ใช้ */
    @Suppress("DEPRECATION")
    fun realScreen(ctx: Context): Pair<Int, Int> {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val m = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    fun isoNow(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

    fun newId(): String = UUID.randomUUID().toString()
}
