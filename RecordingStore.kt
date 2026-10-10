package app.autofarm.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** เก็บผลการบันทึกที่ Dashboard ยังไม่ได้ดึงไป (อยู่รอดแม้แอปถูกปิด/รีสตาร์ตเครื่อง) */
class RecordingStore(ctx: Context) {
    private val dir = File(ctx.filesDir, "recordings").apply { mkdirs() }
    private val idRegex = Regex("^[A-Za-z0-9_-]{1,64}$")

    @Synchronized
    fun save(m: Macro) {
        require(idRegex.matches(m.id)) { "bad id" }
        val tmp = File(dir, "${m.id}.json.tmp")
        tmp.writeText(m.toJson().toString(), Charsets.UTF_8)
        if (!tmp.renameTo(File(dir, "${m.id}.json"))) {
            tmp.delete()
            throw IllegalStateException("เขียนไฟล์ไม่สำเร็จ")
        }
    }

    @Synchronized
    fun list(): JSONArray {
        val out = JSONArray()
        val files = dir.listFiles { f -> f.name.endsWith(".json") }?.sortedBy { it.lastModified() } ?: emptyList()
        for (f in files) {
            try { out.put(JSONObject(f.readText(Charsets.UTF_8))) } catch (_: Exception) { /* ข้ามไฟล์เสีย */ }
        }
        return out
    }

    @Synchronized
    fun count(): Int = dir.listFiles { f -> f.name.endsWith(".json") }?.size ?: 0

    @Synchronized
    fun delete(id: String): Boolean {
        if (!idRegex.matches(id)) return false
        return File(dir, "$id.json").delete()
    }
}
