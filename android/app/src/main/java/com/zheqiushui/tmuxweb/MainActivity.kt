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
 * The window: the server list first; then the server's page (through the forward, or directly)
 * under a thin bar with the state, 刷新 and 设置, and a card over it while it isn't connected.
 */
class MainActivity : Activity(), ServerList.Actions {
  private lateinit var web: WebView
  private lateinit var dot: View
  private lateinit var title: TextView
  private lateinit var card: LinearLayout
  private lateinit var cardSpinner: ProgressBar
  private lateinit var cardText: TextView
  private lateinit var cardButtons: LinearLayout
  private lateinit var page: LinearLayout
  private lateinit var list: ServerList
  private lateinit var store: ProfileStore
  private var listShown = true
  /** a new server's page: its history starts there (back never goes to the one before) */
  private var freshPage = false
  private var loadedBase: String? = null
  private val pageBg get() = if (dark) Color.parseColor("#16181d") else Color.WHITE
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private var pendingSession: Int? = null
  private val dark get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
  private val onState: (TunnelState) -> Unit = { show(it); if (listShown) renderList() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    store = ProfileStore(this)
    buildViews()
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    pendingSession = intent.getIntExtra("sessionId", -1).takeIf { it >= 0 }
    // debug builds only, for automated tests: a profile handed in as base64 JSON
    if (BuildConfig.DEBUG) intent.getStringExtra("testProfile")?.let {
      store.upsert(Profile.fromJson(org.json.JSONObject(String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)))))
    }
    // the list first, unless a server is still connected (the app came back) or an alert was tapped
    val live = Hub.activeId != null && Hub.state !is TunnelState.Idle
    showList(!live)
    Hub.listen(onState)
    Hub.onQuestion = { askDialog(it) }
    if (store.profiles.isEmpty()) edit(null)
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
    // the page is up but the forward went away (the system stopped the service): bring it back
    if (!listShown && Hub.activeId != null && Hub.state is TunnelState.Idle) TunnelService.ensure(this)
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
    if (Hub.activeId != null) showList(false)
    if (loadedBase != null) web.evaluateJavascript("location.hash = '#/s/$id'", null) else pendingSession = id
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    when {
      listShown -> moveTaskToBack(true) // keep the forward and the alerts
      web.canGoBack() -> web.goBack()
      else -> showList(true)
    }
  }

  override fun onConfigurationChanged(c: Configuration) {
    super.onConfigurationChanged(c)
    if (listShown) renderList() // columns follow the width
  }

  // ---- servers ----

  private fun showList(on: Boolean) {
    listShown = on
    list.view.visibility = if (on) View.VISIBLE else View.GONE
    page.visibility = if (on) View.GONE else View.VISIBLE
    window.statusBarColor = if (on) list.bg else pageBg
    window.navigationBarColor = window.statusBarColor
    if (on) renderList()
  }

  private fun renderList() {
    store = ProfileStore(this)
    list.render(store.profiles, Hub.activeId, Hub.state)
  }

  /** Its page: the one already up is just shown again; another one replaces it. */
  override fun connect(p: Profile) = connect(p, false)

  private fun connect(p: Profile, again: Boolean) {
    if (!p.isComplete) return edit(p)
    val s = Hub.state
    if (!again && Hub.activeId == p.id && (s is TunnelState.Ready || s is TunnelState.Connecting || s is TunnelState.Reconnecting)) return showList(false)
    if (Hub.activeId != p.id || again) resetPage()
    store.select(p.id)
    Hub.activeId = p.id
    Hub.profileTitle = p.title
    showList(false)
    TunnelService.start(this)
  }

  override fun edit(p: Profile?) {
    startActivityForResult(Intent(this, SettingsActivity::class.java).apply { p?.let { putExtra("id", it.id) } }, EDIT)
  }

  override fun duplicate(p: Profile) {
    startActivityForResult(Intent(this, SettingsActivity::class.java).putExtra("copy", p.id), EDIT)
  }

  override fun remove(p: Profile) {
    AlertDialog.Builder(this)
      .setTitle("删除「${p.title}」？")
      .setMessage("它的设置和保存的密码、私钥都会删掉。")
      .setPositiveButton("删除") { _, _ ->
        if (Hub.activeId == p.id) disconnect()
        store.remove(p.id)
        renderList()
      }
      .setNegativeButton("取消", null)
      .show()
  }

  override fun disconnect() {
    TunnelService.stop(this)
    Hub.activeId = null
    resetPage()
    showList(true)
  }

  /** the old server's page goes, so it never shows under another one's name */
  private fun resetPage() {
    loadedBase = null
    web.loadUrl("about:blank")
  }

  /** back from the settings: connect, or reconnect the one in use when it changed */
  private fun edited(data: Intent) {
    store = ProfileStore(this)
    val p = store.profiles.firstOrNull { it.id == data.getStringExtra("id") } ?: return renderList()
    val changed = data.getBooleanExtra("changed", false)
    when {
      data.getBooleanExtra("connect", false) -> connect(p, changed && Hub.activeId == p.id)
      changed && Hub.activeId == p.id -> {
        resetPage()
        Hub.profileTitle = p.title
        TunnelService.start(this)
        renderList()
      }
      else -> renderList()
    }
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
        if (loadedBase != s.base || web.url == null) {
          loadedBase = s.base
          freshPage = true
          web.loadUrl("${s.base}/" + (pendingSession?.let { "#/s/$it" } ?: ""))
          pendingSession = null
          Updater.checkSoon(this, s.base)
        }
      }
      is TunnelState.Reconnecting -> {
        // the page stays; it reconnects its own streams once the forward is back
        card.visibility = if (loadedBase != null) View.GONE else View.VISIBLE
        title.text = s.message
        cardState(true, s.message, listOf("取消" to { disconnect() }))
      }
      is TunnelState.Connecting, TunnelState.Idle -> {
        card.visibility = View.VISIBLE
        cardState(true, "正在连接 ${Hub.profileTitle}…\n需要验证码或密码时会弹框", listOf("取消" to { disconnect() }))
      }
      is TunnelState.Failed -> {
        card.visibility = View.VISIBLE
        loadedBase = null
        cardState(false, "连不上 ${Hub.profileTitle}\n\n${s.message}", listOf(
          "服务器列表" to { disconnect() },
          "设置" to { activeProfile()?.let { edit(it) } },
          "重试" to { TunnelService.start(this) },
        ))
      }
    }
  }

  private fun cardState(spinning: Boolean, text: String, buttons: List<Pair<String, () -> Unit>>) {
    cardSpinner.visibility = if (spinning) View.VISIBLE else View.GONE
    cardText.text = text
    cardButtons.removeAllViews()
    buttons.forEach { (label, action) -> cardButtons.addView(Button(this).apply { this.text = label; setOnClickListener { action() } }) }
  }

  private fun activeProfile() = store.profiles.firstOrNull { it.id == Hub.activeId }

  private fun askDialog(q: Hub.Question) {
    if (isFinishing) return
    val input = EditText(this).apply {
      inputType = if (q.secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT
      setSingleLine()
    }
    val box = FrameLayout(this).apply { setPadding(dp(20), dp(8), dp(20), 0); addView(if (q.secret) withEye(this@MainActivity, input) else input) }
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

    page = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
    val root = page

    // thin bar: ‹ ● name … ⟳ ⚙ (‹: the server list)
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, 0, dp(4), 0)
      setBackgroundColor(bg)
    }
    bar.addView(barButton("‹", fg) { showList(true) }.apply { textSize = 24f; contentDescription = "服务器列表" })
    dot = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.GRAY) } }
    bar.addView(dot, LinearLayout.LayoutParams(dp(8), dp(8)))
    title = TextView(this).apply { textSize = 13f; setTextColor(fg); setPadding(dp(8), 0, 0, 0); isSingleLine = true }
    bar.addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    bar.addView(barButton("⟳", fg) { web.clearCache(false); web.reload() })
    bar.addView(barButton("⚙", fg) { activeProfile()?.let { edit(it) } })
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
        if (u.host != "127.0.0.1" && u.host != loadedBase?.let { Uri.parse(it).host } && (u.scheme == "http" || u.scheme == "https")) {
          startActivity(Intent(Intent.ACTION_VIEW, u))
          return true
        }
        return false
      }
      override fun onPageFinished(view: WebView, url: String?) {
        if (freshPage && url != null && url.startsWith(loadedBase ?: "-")) {
          freshPage = false
          view.clearHistory()
        }
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
    card.addView(cardButtons)
    stack.addView(card, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

    root.addView(stack, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    list = ServerList(this, dark, this)
    setContentView(FrameLayout(this).apply {
      setBackgroundColor(bg)
      addView(page, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
      addView(list.view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    })
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
    if (requestCode == EDIT && resultCode == RESULT_OK && data != null) edited(data)
    if (requestCode == 7) {
      fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data) ?: data?.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } })
      fileCallback = null
    }
  }

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

  companion object {
    private const val EDIT = 9
  }
}
