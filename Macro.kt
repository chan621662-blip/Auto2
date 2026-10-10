package app.autofarm.companion

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** type: "tap" | "hold" | "swipe" — delayMs = เวลารอหลังการกระทำก่อนหน้าจบ */
data class Action(
    val type: String,
    val x: Int,
    val y: Int,
    val x2: Int,
    val y2: Int,
    val delayMs: Long,
    val durationMs: Long,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("type", type)
        put("x", x)
        put("y", y)
        if (type == "swipe") {
            put("x2", x2)
            put("y2", y2)
        }
        put("delayMs", delayMs)
        put("durationMs", durationMs)
    }
}

data class Macro(
    val id: String,
    val name: String,
    val screenW: Int,
    val screenH: Int,
    val actions: List<Action>,
    val createdAt: String,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("schema", SCHEMA)
        put("id", id)
        put("name", name)
        put("createdAt", createdAt)
        put("updatedAt", createdAt)
        if (screenW > 0 && screenH > 0) {
            put("screen", JSONObject().put("width", screenW).put("height", screenH))
        }
        put("durationMs", actions.sumOf { it.delayMs + it.durationMs })
        put("actions", JSONArray().also { arr -> actions.forEach { arr.put(it.toJson()) } })
    }

    companion object {
        const val SCHEMA = "autofarm.macro/1"
        const val MAX_ACTIONS = 5000
        const val MAX_COORD = 20000
        const val MAX_DELAY = 3_600_000L
        const val MAX_DURATION = 60_000L

        private fun bad(msg: String): Nothing = throw ApiException(400, "bad_macro", msg)

        /** ตรวจสอบกฎเดียวกับ web/js/macro.js */
        fun fromJson(o: JSONObject): Macro {
            val schema = o.optString("schema", SCHEMA)
            if (schema != SCHEMA) bad("schema \"$schema\" ไม่รองรับ")
            val arr = o.optJSONArray("actions") ?: bad("ไม่พบรายการ actions")
            if (arr.length() == 0) bad("Macro ไม่มีการกระทำ")
            if (arr.length() > MAX_ACTIONS) bad("มีการกระทำมากเกิน $MAX_ACTIONS รายการ")

            val actions = ArrayList<Action>(arr.length())
            for (i in 0 until arr.length()) {
                val a = try { arr.getJSONObject(i) } catch (e: JSONException) { bad("การกระทำที่ ${i + 1}: รูปแบบไม่ถูกต้อง") }
                val label = "การกระทำที่ ${i + 1}"
                val type = a.optString("type", "")
                if (type != "tap" && type != "hold" && type != "swipe") bad("$label: ชนิด \"$type\" ไม่รองรับ")
                fun coord(k: String): Int {
                    val v = a.optDouble(k, Double.NaN)
                    if (v.isNaN() || v < 0 || v > MAX_COORD) bad("$label: ค่า $k ไม่ถูกต้อง")
                    return Math.round(v).toInt()
                }
                val x = coord("x")
                val y = coord("y")
                val x2 = if (type == "swipe") coord("x2") else x
                val y2 = if (type == "swipe") coord("y2") else y
                val delay = a.optDouble("delayMs", 0.0)
                val defDur = when (type) { "tap" -> 50.0; "hold" -> 600.0; else -> 300.0 }
                val dur = a.optDouble("durationMs", defDur)
                if (delay.isNaN() || delay < 0 || delay > MAX_DELAY) bad("$label: เวลารอไม่ถูกต้อง")
                if (dur.isNaN() || dur < 1 || dur > MAX_DURATION) bad("$label: ระยะเวลาไม่ถูกต้อง")
                actions.add(Action(type, x, y, x2, y2, Math.round(delay), Math.round(dur)))
            }

            var sw = 0
            var sh = 0
            o.optJSONObject("screen")?.let {
                sw = it.optInt("width", 0)
                sh = it.optInt("height", 0)
                if (sw < 0 || sh < 0 || sw > MAX_COORD || sh > MAX_COORD) bad("ค่า screen ไม่ถูกต้อง")
            }
            val id = o.optString("id", "").ifEmpty { Util.newId() }
            val name = o.optString("name", "").trim().take(60).ifEmpty { "Macro" }
            return Macro(id, name, sw, sh, actions, o.optString("createdAt", Util.isoNow()))
        }
    }
}
