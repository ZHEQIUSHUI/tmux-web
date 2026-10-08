package com.zheqiushui.tmuxweb

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/**
 * The window: tmux-web's page through the forward (127.0.0.1:<port>), a thin bar with the state,
 * 刷新 and 设置, and a card over the page while it isn't connected.
 */
class MainActivity : Activity() {
  private lateinit var web: WebView
  private lateinit var dot: View
  private lateinit var title: TextView
  private lateinit var card: LinearLayout
  private lateinit var cardSpinner: ProgressBar
  private lateinit var cardText: TextView
  private lateinit var cardButtons: LinearLayout
  private var loadedPort = -1
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private var pendingSession: Int? = null
  private val dark get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
  private val onState: (TunnelState) -> Unit = { show(it) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildViews()
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    pendingSession = intent.getIntExtra("sessionId", -1).takeIf { it >= 0 }
    // debug builds only, for automated tests: a profile handed in as base64 JSON
    if (BuildConfig.DEBUG) intent.getStringExtra("testProfile")?.let {
      ProfileStore(this).upsert(Profile.fromJson(org.json.JSONObject(String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)))))
    }
    Hub.listen(onState)
    Hub.onQuestion = { askDialog(it) }
    val p = ProfileStore(this).current
    if (p == null || !p.isComplete) {
      startActivity(Intent(this, SettingsActivity::class.java))
    } else {
      TunnelService.ensure(this)
    }
  }

  override fun onDestroy() {
    Hub.unlisten(onState)
    Hub.onQuestion = null
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    Hub.foreground = true
    Hub.question?.let { askDialog(it) }
    // settings were saved: (re)connect with them
    if (Hub.state is TunnelState.Idle) ProfileStore(this).current?.takeIf { it.isComplete }?.let { TunnelService.ensure(this) }
  }

  override fun onPause() {
    Hub.foreground = false
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val sid = intent.getIntExtra("sessionId", -1)
    if (sid >= 0) openSession(sid)
  }

  private fun openSession(id: Int) {
    if (loadedPort > 0) web.evaluateJavascript("location.hash = '#/s/$id'", null) else pendingSession = id
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (web.canGoBack()) web.goBack() else moveTaskToBack(true) // keep the forward and the alerts
  }

  // ---- state ----

  private fun show(s: TunnelState) {
    val color = when (s) {
      is TunnelState.Ready -> Color.parseColor("#2f9e5b")
      is TunnelState.Failed -> Color.parseColor("#e0503a")
      else -> Color.parseColor("#d99a17")
    }
    (dot.background as GradientDrawable).setColor(color)
    title.text = Hub.profileTitle.ifBlank { "tmux-web" }
    when (s) {
      is TunnelState.Ready -> {
        card.visibility = View.GONE
        if (loadedPort != s.port || web.url == null) {
          loadedPort = s.port
          web.loadUrl("http://127.0.0.1:${s.port}/" + (pendingSession?.let { "#/s/$it" } ?: ""))
          pendingSession = null
          Updater.checkSoon(this, s.port)
        }
      }
      is TunnelState.Reconnecting -> {
        // the page stays; it reconnects its own streams once the forward is back
        card.visibility = if (loadedPort > 0) View.GONE else View.VISIBLE
        title.text = s.message
        cardState(true, s.message, false)
      }
      is TunnelState.Connecting, TunnelState.Idle -> {
        card.visibility = View.VISIBLE
        cardState(true, "正在连接 ${Hub.profileTitle}…\n需要验证码或密码时会弹框", false)
      }
      is TunnelState.Failed -> {
        card.visibility = View.VISIBLE
        loadedPort = -1
        cardState(false, "连不上 ${Hub.profileTitle}\n\n${s.message}", true)
      }
    }
  }

  private fun cardState(spinning: Boolean, text: String, buttons: Boolean) {
    cardSpinner.visibility = if (spinning) View.VISIBLE else View.GONE
    cardText.text = text
    cardButtons.visibility = if (buttons) View.VISIBLE else View.GONE
  }

  private fun askDialog(q: Hub.Question) {
    if (isFinishing) return
    val input = EditText(this).apply {
      inputType = if (q.secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT
      setSingleLine()
    }
    val box = FrameLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(input) }
    AlertDialog.Builder(this)
      .setTitle("SSH 验证")
      .setMessage(q.prompt)
      .setView(box)
      .setCancelable(false)
      .setPositiveButton("确定") { _, _ -> Hub.answer(q, input.text.toString()) }
      .setNegativeButton("取消") { _, _ -> Hub.answer(q, null) }
      .show()
    input.requestFocus()
  }

  // ---- views ----

  @SuppressLint("SetJavaScriptEnabled")
  private fun buildViews() {
    val bg = if (dark) Color.parseColor("#16181d") else Color.WHITE
    val fg = if (dark) Color.parseColor("#d8dce3") else Color.parseColor("#1f2328")
    window.statusBarColor = bg
    window.navigationBarColor = bg
    if (!dark) window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR

    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }

    // thin bar: ● name … ⟳ ⚙
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(12), 0, dp(4), 0)
      setBackgroundColor(bg)
    }
    dot = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.GRAY) } }
    bar.addView(dot, LinearLayout.LayoutParams(dp(8), dp(8)))
    title = TextView(this).apply { textSize = 13f; setTextColor(fg); setPadding(dp(8), 0, 0, 0); isSingleLine = true }
    bar.addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    bar.addView(barButton("⟳", fg) { web.clearCache(false); web.reload() })
    bar.addView(barButton("⚙", fg) { startActivity(Intent(this, SettingsActivity::class.java)) })
    root.addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, dp(38)))

    val stack = FrameLayout(this)
    web = WebView(this)
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      textZoom = 100
    }
    CookieManager.getInstance().setAcceptCookie(true)
    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
        val u = req.url
        // other sites open in the browser
        if (u.host != "127.0.0.1" && (u.scheme == "http" || u.scheme == "https")) {
          startActivity(Intent(Intent.ACTION_VIEW, u))
          return true
        }
        return false
      }
      override fun onPageFinished(view: WebView, url: String?) {
        CookieManager.getInstance().flush()
      }
    }
    web.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = cb
        return try {
          startActivityForResult(params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE), 7)
          true
        } catch (e: Exception) {
          fileCallback = null
          false
        }
      }
    }
    web.setDownloadListener { url, ua, disposition, mime, _ ->
      val name = URLUtil.guessFileName(url, disposition, mime)
      val req = DownloadManager.Request(Uri.parse(url))
        .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
        .addRequestHeader("User-Agent", ua)
        .setTitle(name)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
      getSystemService(DownloadManager::class.java).enqueue(req)
      Toast.makeText(this, "开始下载 $name", Toast.LENGTH_SHORT).show()
    }
    stack.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

    // the card over the page: connecting… / can't connect (retry, settings)
    card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(bg)
      setPadding(dp(32), dp(32), dp(32), dp(32))
    }
    cardSpinner = ProgressBar(this)
    card.addView(cardSpinner)
    cardText = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(16)) }
    card.addView(cardText)
    cardButtons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    cardButtons.addView(Button(this).apply { text = "设置"; setOnClickListener { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) } })
    cardButtons.addView(Button(this).apply { text = "重试"; setOnClickListener { TunnelService.start(this@MainActivity) } })
    card.addView(cardButtons)
    stack.addView(card, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

    root.addView(stack, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    setContentView(root)
  }

  private fun barButton(label: String, color: Int, onClick: () -> Unit) = TextView(this).apply {
    text = label
    textSize = 18f
    setTextColor(color)
    gravity = Gravity.CENTER
    layoutParams = LinearLayout.LayoutParams(dp(40), MATCH_PARENT)
    setOnClickListener { onClick() }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == 7) {
      fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data) ?: data?.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } })
      fileCallback = null
    }
  }

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
