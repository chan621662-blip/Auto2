package app.autofarm.companion

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject

/**
 * หน้าหลักของแอป: ถ้าเปิด Accessibility Service แล้ว → แสดงเว็บ Dashboard (WebView ชี้ไป 127.0.0.1)
 * ถ้ายัง → แสดงหน้าอธิบายสิทธิ์ (prominent disclosure) พร้อมปุ่มไปเปิดบริการ
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var setup: View
    private lateinit var setupStatus: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var loaded = false
    private var pendingExport: String? = null

    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val text = pendingExport
        pendingExport = null
        if (uri != null && text != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                Toast.makeText(this, "บันทึกไฟล์แล้ว", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "บันทึกไฟล์ไม่สำเร็จ: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) readAndSend(uri)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        setup = findViewById(R.id.setup)
        setupStatus = findViewById(R.id.setupStatus)

        findViewById<Button>(R.id.btnAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.btnAppInfo).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
        findViewById<Button>(R.id.btnRefresh).setOnClickListener { refresh() }

        web.setBackgroundColor(0xFF070A12.toInt())
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // จำเป็นสำหรับ IndexedDB
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString AFRCompanion/1.0"
        }
        web.addJavascriptInterface(Bridge(), "AFRBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "afr" && u.host == "testpad") {
                    startActivity(Intent(this@MainActivity, TestPadActivity::class.java))
                    return true
                }
                val internal = u.scheme == "http" && u.host == "127.0.0.1" && u.port == AutoFarmService.PORT
                return !internal // บล็อกการนำทางออกนอกแดชบอร์ดทั้งหมด
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    loaded = false
                    refresh()
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.visibility == View.VISIBLE && web.canGoBack()) web.goBack() else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun isServiceEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, AutoFarmService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun refresh() {
        handler.removeCallbacksAndMessages(null)
        val enabled = isServiceEnabled()
        val running = AutoFarmService.instance != null
        val err = AutoFarmService.serverError
        val ready = enabled && running && err == null

        setup.visibility = if (ready) View.GONE else View.VISIBLE
        web.visibility = if (ready) View.VISIBLE else View.GONE

        if (ready) {
            if (!loaded) {
                web.loadUrl("http://127.0.0.1:${AutoFarmService.PORT}/#token=${AutoFarmService.token(this)}")
                loaded = true
            }
            return
        }
        loaded = false
        setupStatus.text = when {
            err != null -> "⚠ $err\nปิดแอปอื่นที่ใช้พอร์ตนี้ แล้วปิด/เปิดบริการ Accessibility ใหม่"
            enabled -> "บริการเปิดอยู่แล้ว กำลังเริ่มทำงาน…"
            else -> "ยังไม่ได้เปิดบริการ Accessibility"
        }
        if (enabled && err == null) handler.postDelayed({ refresh() }, 1000)
    }

    private fun readAndSend(uri: Uri) {
        val text = try {
            contentResolver.openInputStream(uri)?.use { s ->
                val bytes = s.readBytes()
                if (bytes.size > 5_000_000) null else String(bytes, Charsets.UTF_8)
            }
        } catch (e: Exception) {
            null
        }
        if (text == null) {
            Toast.makeText(this, "อ่านไฟล์ไม่ได้หรือไฟล์ใหญ่เกิน 5 MB", Toast.LENGTH_LONG).show()
            return
        }
        web.evaluateJavascript("window.__afrImportText(" + JSONObject.quote(text) + ")", null)
    }

    /** สะพาน JS → Android สำหรับส่งออก/นำเข้าไฟล์ (WebView ไม่รองรับ download/file chooser ตรงๆ) */
    private inner class Bridge {
        @JavascriptInterface
        fun exportFile(name: String, content: String) {
            runOnUiThread {
                pendingExport = content
                createDoc.launch(name.take(80))
            }
        }

        @JavascriptInterface
        fun importFile() {
            runOnUiThread { openDoc.launch(arrayOf("application/json", "text/plain", "*/*")) }
        }
    }
}
