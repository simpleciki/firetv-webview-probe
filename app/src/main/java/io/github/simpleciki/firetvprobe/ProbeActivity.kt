package io.github.simpleciki.firetvprobe

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.util.DisplayMetrics
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONObject

// The probe's native shell. It does not interpret anything: it reports what each layer
// receives (activity key events, media-session callbacks, media-button intents) to the page,
// and lets the remote's keys continue to the WebView untouched, so the page can also record
// which of them arrive as DOM keydown events. The page decides what each step means.
class ProbeActivity : Activity() {

    private lateinit var webView: WebView
    private var session: MediaSession? = null

    // One channel to the page: a 'probe-native' CustomEvent whose detail is a JSON object.
    private fun report(kind: String, fill: JSONObject.() -> Unit) {
        val o = JSONObject().put("kind", kind)
        o.fill()
        runOnUiThread {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('probe-native',{detail:$o}))", null)
        }
    }

    // Every key the activity sees, before the WebView does. `eventTime` is the device's uptime
    // clock (ms since boot): it orders native events among themselves only; the page stamps
    // its own arrival time separately and never compares the two clocks.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) report("key") {
            put("code", event.keyCode)
            put("name", KeyEvent.keyCodeToString(event.keyCode))
            put("deviceId", event.deviceId)
            put("source", event.source)
            put("eventTime", event.eventTime)
        }
        // Back would close the activity; the page owns it instead (it exits from its start screen).
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) report("back") {}
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // A media session that accepts every transport action Amazon lists for Alexa, including
    // seek: Amazon delivers "Alexa, rewind / fast forward" as onSeekTo(current ± 10 s). The
    // reported position is a fixed anchor (one hour) so a seek's direction is readable and
    // "restart" (a seek to 0) stays distinguishable.
    private fun publishState(playing: Boolean) {
        session?.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_FAST_FORWARD or
                PlaybackState.ACTION_REWIND or PlaybackState.ACTION_SKIP_TO_NEXT or
                PlaybackState.ACTION_SKIP_TO_PREVIOUS)
            .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, ANCHOR_MS, 0f)
            .build())
        report("state") { put("playing", playing) }
    }

    private fun startSession() {
        session = MediaSession(this, "FireTvWebViewProbe").apply {
            setCallback(object : MediaSession.Callback() {
                private fun cb(name: String, arg: Long? = null) = report("session") {
                    put("callback", name)
                    if (arg != null) put("pos", arg).put("anchor", ANCHOR_MS)
                }
                override fun onPlay() = cb("onPlay")
                override fun onPause() = cb("onPause")
                override fun onStop() = cb("onStop")
                override fun onFastForward() = cb("onFastForward")
                override fun onRewind() = cb("onRewind")
                override fun onSkipToNext() = cb("onSkipToNext")
                override fun onSkipToPrevious() = cb("onSkipToPrevious")
                override fun onSeekTo(pos: Long) = cb("onSeekTo", pos)
                override fun onMediaButtonEvent(intent: Intent): Boolean {
                    @Suppress("DEPRECATION")
                    val k = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                    if (k != null && k.action == KeyEvent.ACTION_DOWN) report("mediaButton") {
                        put("code", k.keyCode)
                        put("name", KeyEvent.keyCodeToString(k.keyCode))
                        put("deviceId", k.deviceId)
                    }
                    return super.onMediaButtonEvent(intent)
                }
            })
            isActive = true
        }
        publishState(false)
    }

    // What this device is, read from the installed package and the system — not from build flags.
    private fun info(): JSONObject {
        val pkg = packageManager.getPackageInfo(packageName, PackageManager.GET_PERMISSIONS)
        val wv = WebViewCompat.getCurrentWebViewPackage(this)
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay.getRealMetrics(dm)
        return JSONObject()
            .put("appId", packageName)
            .put("appVersion", pkg.versionName)
            .put("voicePermission", pkg.requestedPermissions?.contains(VOICE_PERMISSION) == true)
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("device", Build.DEVICE)
            .put("android", Build.VERSION.RELEASE)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("fireOs", sysProp("ro.build.version.name"))
            .put("webview", if (wv == null) "" else wv.packageName + " " + wv.versionName)
            .put("displayPx", "${dm.widthPixels}x${dm.heightPixels}")
            .put("density", dm.density.toDouble())
    }

    private fun sysProp(key: String): String = try {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java)
            .invoke(null, key) as String
    } catch (e: Exception) { "" }

    // window.ProbeNative in the page. Only the bundled pages are ever loaded in this WebView.
    private inner class Bridge {
        @JavascriptInterface fun info(): String = this@ProbeActivity.info().toString()
        @JavascriptInterface fun setPlaying(on: Boolean) = runOnUiThread { publishState(on) }
        @JavascriptInterface fun exit() = runOnUiThread { finish() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Pages come from https://appassets.androidplatform.net/assets/, a real origin, rather
        // than file:// (whose origin is "null"); the probe reports which one it got.
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // A TV has no touch to start media with.
            settings.mediaPlaybackRequiresUserGesture = false
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            addJavascriptInterface(Bridge(), "ProbeNative")
        }
        setContentView(webView)
        startSession()
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        webView.requestFocus()
    }

    // The session stays active while the app is open. If the voice overlay pauses this activity,
    // a session that deactivates in onPause would miss the very command being spoken — so the
    // probe never does that, and reports the lifecycle so you can see whether the overlay pauses it.
    override fun onResume() { super.onResume(); if (::webView.isInitialized) report("lifecycle") { put("event", "onResume") } }
    override fun onPause() { super.onPause(); report("lifecycle") { put("event", "onPause") } }
    override fun onDestroy() { session?.release(); session = null; webView.destroy(); super.onDestroy() }

    companion object {
        private const val ANCHOR_MS = 3_600_000L
        private const val VOICE_PERMISSION = "com.amazon.permission.media.session.voicecommandcontrol"
    }
}
