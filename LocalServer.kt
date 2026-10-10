package app.autofarm.companion

import fi.iki.elonen.NanoHTTPD
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

/**
 * เซิร์ฟเวอร์ HTTP ที่ bind เฉพาะ 127.0.0.1 (เข้าถึงจากเครื่องนี้เท่านั้น)
 * ความปลอดภัย:
 *  - ตรวจ Host (กัน DNS rebinding) และ Origin (กันเว็บอื่นยิงข้ามไซต์) — ไม่ส่ง CORS header เลย
 *  - /api/* ต้องมีโทเค็นสุ่มใน header X-AFR-Token (เทียบแบบ constant-time)
 *  - ไฟล์เว็บ (assets) เสิร์ฟพร้อม CSP แบบเข้มงวด
 */
class LocalServer(
    private val service: AutoFarmService,
    private val token: String,
) : NanoHTTPD("127.0.0.1", AutoFarmService.PORT) {

    private val port = AutoFarmService.PORT
    private val allowedHosts = setOf("127.0.0.1:$port", "localhost:$port")
    private val allowedOrigins = setOf("http://127.0.0.1:$port", "http://localhost:$port")

    private val mime = mapOf(
        "html" to "text/html; charset=utf-8",
        "js" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8",
        "json" to "application/json; charset=utf-8",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "ico" to "image/x-icon",
    )

    override fun serve(session: IHTTPSession): Response {
        return try {
            val host = session.headers["host"]
            if (host == null || host !in allowedHosts) {
                return jsonError(403, "bad_host", "Host ไม่ได้รับอนุญาต")
            }
            val uri = session.uri
            if (uri.startsWith("/api/")) api(session, uri) else asset(session, uri)
        } catch (e: ApiException) {
            jsonError(e.http, e.code, e.message ?: "")
        } catch (e: JSONException) {
            jsonError(400, "bad_json", "ข้อมูล JSON ไม่ถูกต้อง")
        } catch (e: Exception) {
            jsonError(500, "internal", "ข้อผิดพลาดภายใน: ${e.message}")
        }
    }

    /* ---------- static ---------- */

    private fun asset(session: IHTTPSession, uriRaw: String): Response {
        if (session.method != Method.GET && session.method != Method.HEAD) {
            return jsonError(405, "method_not_allowed", "ไม่รองรับเมธอดนี้")
        }
        var path = uriRaw.trimStart('/')
        if (path.isEmpty()) path = "index.html"
        if (path.contains("..") || path.contains('\\') || path.contains("//")) return notFound()
        val type = mime[path.substringAfterLast('.', "")] ?: return notFound()
        return try {
            val stream = service.assets.open(path)
            secure(newChunkedResponse(Response.Status.OK, type, stream))
        } catch (e: IOException) {
            notFound()
        }
    }

    private fun notFound(): Response = secure(newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain; charset=utf-8", "ไม่พบไฟล์"))

    private fun secure(r: Response): Response {
        r.addHeader("Cache-Control", "no-cache")
        r.addHeader("X-Content-Type-Options", "nosniff")
        r.addHeader("Referrer-Policy", "no-referrer")
        r.addHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
                "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        )
        return r
    }

    /* ---------- API ---------- */

    private fun api(session: IHTTPSession, uri: String): Response {
        val origin = session.headers["origin"]
        if (origin != null && origin !in allowedOrigins) {
            return jsonError(403, "forbidden_origin", "Origin ไม่ได้รับอนุญาต")
        }
        val sent = session.headers["x-afr-token"] ?: ""
        if (!MessageDigest.isEqual(sent.toByteArray(Charsets.UTF_8), token.toByteArray(Charsets.UTF_8))) {
            return jsonError(401, "bad_token", "โทเค็นไม่ถูกต้อง")
        }
        val m = session.method
        val body = if (m == Method.POST) readJson(session) else JSONObject()
        val s = service

        return when {
            m == Method.GET && uri == "/api/status" -> ok(s.runOnMain { s.statusJson() })

            m == Method.POST && uri == "/api/record/start" -> {
                val name = body.optString("name", "")
                s.runOnMain { s.startRecording(name) }
                ok()
            }
            m == Method.POST && uri == "/api/record/pause" -> { s.runOnMain { s.pauseRecording() }; ok() }
            m == Method.POST && uri == "/api/record/resume" -> { s.runOnMain { s.resumeRecording() }; ok() }
            m == Method.POST && uri == "/api/record/stop" -> {
                val macro = s.runOnMain { s.stopRecording() }
                ok(JSONObject().put("recording", macro.toJson()))
            }

            m == Method.GET && uri == "/api/recordings" -> ok(JSONObject().put("recordings", s.store.list()))
            m == Method.DELETE && uri.startsWith("/api/recordings/") -> {
                val id = uri.removePrefix("/api/recordings/")
                if (!s.store.delete(id)) throw ApiException(404, "not_found", "ไม่พบการบันทึกนี้")
                ok()
            }

            m == Method.POST && uri == "/api/replay/start" -> {
                val macro = Macro.fromJson(body.optJSONObject("macro") ?: throw ApiException(400, "bad_macro", "ไม่พบ macro"))
                val loops = body.optInt("loops", 1)
                val speed = body.optDouble("speed", 1.0)
                val startDelay = body.optLong("startDelayMs", 0L)
                val loopDelay = body.optLong("loopDelayMs", 0L)
                s.runOnMain { s.startReplay(macro, loops, speed, startDelay, loopDelay) }
                ok()
            }
            m == Method.POST && uri == "/api/replay/pause" -> { s.runOnMain { s.replayer.pause() }; ok() }
            m == Method.POST && uri == "/api/replay/resume" -> { s.runOnMain { s.replayer.resume() }; ok() }
            m == Method.POST && uri == "/api/replay/stop" -> { s.runOnMain { s.replayer.stop() }; ok() }

            else -> jsonError(404, "not_found", "ไม่พบ API นี้")
        }
    }

    private fun readJson(session: IHTTPSession): JSONObject {
        val len = session.headers["content-length"]?.toLongOrNull() ?: 0L
        if (len > 2_000_000L) throw ApiException(400, "too_large", "ข้อมูลใหญ่เกินไป")
        if (len == 0L) return JSONObject()
        val files = HashMap<String, String>()
        try {
            session.parseBody(files)
        } catch (e: IOException) {
            throw ApiException(400, "bad_body", "อ่านข้อมูลไม่สำเร็จ")
        } catch (e: ResponseException) {
            throw ApiException(400, "bad_body", "อ่านข้อมูลไม่สำเร็จ")
        }
        val text = files["postData"] ?: return JSONObject()
        return JSONObject(text)
    }

    private fun ok(extra: JSONObject = JSONObject()): Response {
        extra.put("ok", true)
        return json(Response.Status.OK, extra)
    }

    private fun jsonError(http: Int, code: String, message: String): Response {
        val status = when (http) {
            400 -> Response.Status.BAD_REQUEST
            401 -> Response.Status.UNAUTHORIZED
            403 -> Response.Status.FORBIDDEN
            404 -> Response.Status.NOT_FOUND
            405 -> Response.Status.METHOD_NOT_ALLOWED
            409 -> Response.Status.CONFLICT
            else -> Response.Status.INTERNAL_ERROR
        }
        return json(status, JSONObject().put("ok", false).put("error", code).put("message", message))
    }

    private fun json(status: Response.Status, o: JSONObject): Response =
        secure(newFixedLengthResponse(status, "application/json; charset=utf-8", o.toString()))
}
