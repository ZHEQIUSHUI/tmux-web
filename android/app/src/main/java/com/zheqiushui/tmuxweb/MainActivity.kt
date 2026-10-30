package com.zheqiushui.tmuxweb

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Where the window is. The page stays loaded behind the others while its server is connected. */
sealed interface Screen {
  object Home : Screen
  object Page : Screen
  /** the private keys, kept once for any number of servers */
  object Keys : Screen
  /** send selected servers/keys over the LAN, or import them from another device */
  object Share : Screen
  /** a server's settings: `id` an existing one, `copyOf` a copy, else a new one (in `mode`) */
  data class Editor(val id: String? = null, val copyOf: String? = null, val mode: String? = null) : Screen
}

/** the server's page in the web view */
sealed interface PageLoad {
  object None : PageLoad
  object Loading : PageLoad
  object Loaded : PageLoad
  data class Failed(val message: String) : PageLoad
}

/** What the screens show; changed only on the main thread. */
class AppModel {
  var screen by mutableStateOf<Screen>(Screen.Home)
  /** the screen an editor goes back to */
  var beforeEditor: Screen = Screen.Home
  var profiles by mutableStateOf(emptyList<Profile>())
  var keys by mutableStateOf(emptyList<SshKey>())
  var activeId by mutableStateOf<String?>(null)
  var tunnel by mutableStateOf<TunnelState>(TunnelState.Idle)
  /** the furthest step reached on the way up: where it stopped, if it fails */
  var step by mutableIntStateOf(0)
  var page by mutableStateOf<PageLoad>(PageLoad.None)
  var startedAt by mutableLongStateOf(0L)
  var question by mutableStateOf<Hub.Question?>(null)
  val probes = mutableStateMapOf<String, Probe.Result>()
  var probing by mutableIntStateOf(0)
  var resumed by mutableStateOf(false)
  /** a share link opened from outside the app, for the share screen to fill in */
  var incomingShare by mutableStateOf<ShareLink?>(null)
  val active: Profile? get() = profiles.firstOrNull { it.id == activeId }
}

/** What the screens can ask for. */
interface Actions {
  fun connect(p: Profile)
  fun edit(e: Screen.Editor)
  fun closeEditor()
  fun save(p: Profile, connect: Boolean, original: Profile?)
  fun remove(p: Profile)
  fun forgetHostKey(p: Profile)
  /** the key list */
  fun keys()
  fun saveKey(k: SshKey)
  fun removeKey(k: SshKey)
  /** the LAN configuration sharing screen */
  fun share()
  /** merge a received bundle, then show the new servers */
  fun importShared(payload: SharedPayload): ShareImportSummary
  /** back to the servers; the connection stays */
  fun home()
  fun disconnect()
  fun retry()
  fun reload()
  fun checkUpdates()
  fun probeAll()
  fun answer(q: Hub.Question, text: String?)
  fun openUrl(url: String)
}

/**
 * The window: the servers first; then a server's page (through the forward, or directly) under
 * a compact bar, with a connecting screen over it until the page is there.
 */
class MainActivity : ComponentActivity(), Actions {
  val model = AppModel()
  private lateinit var store: ProfileStore
  /** one web view for the window's whole life: switching screens never reloads the page */
  lateinit var web: WebView
  /** a new server's page: its history starts there (back never goes to the one before) */
  private var freshPage = false
  private var loadedBase: String? = null
  /** a load went out while the connection may have been dead: do it again once it's back */
  private var reloadWhenBack = false
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private var pendingSession: Int? = null
  private val onState: (TunnelState) -> Unit = { show(it) }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    store = ProfileStore(this)
    web = buildWeb()
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    pendingSession = intent.getIntExtra("sessionId", -1).takeIf { it >= 0 }
    // debug builds only, for automated tests: a login cookie for the page, a profile as base64 JSON
    if (BuildConfig.DEBUG) intent.getStringExtra("testCookie")?.let { CookieManager.getInstance().setCookie(intent.getStringExtra("testCookieUrl"), it) }
    if (BuildConfig.DEBUG) intent.getStringExtra("testProfile")?.let {
      store.upsert(Profile.fromJson(org.json.JSONObject(String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)))))
    }
    reloadProfiles()
    openShareLink(intent)
    // always the servers first; one still connected (the app came back) shows as such on its card
    model.activeId = Hub.activeId.takeIf { Hub.state !is TunnelState.Idle }
    Hub.listen(onState)
    Hub.onQuestion = { model.question = it }
    // an alert tapped while connected: straight to its session
    if (pendingSession != null && model.activeId != null) model.screen = Screen.Page
    setContent { TmuxTheme { AppScreen(model, this, web) } }
  }

  override fun onDestroy() {
    Hub.unlisten(onState)
    Hub.onQuestion = null
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    Hub.foreground = true
    model.resumed = true
    model.question = Hub.question
    // the page is up but the forward went away (the system stopped the service): bring it back
    if (model.screen == Screen.Page && Hub.activeId != null && Hub.state is TunnelState.Idle) TunnelService.ensure(this)
    // back after a while: the connection may have died meanwhile (sleep, another network)
    else if (Hub.activeId != null && Hub.state !is TunnelState.Idle && Hub.state !is TunnelState.Failed && model.active?.isDirect == false) TunnelService.check(this)
  }

  override fun onPause() {
    Hub.foreground = false
    model.resumed = false
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val sid = intent.getIntExtra("sessionId", -1)
    if (sid >= 0) openSession(sid)
    openShareLink(intent)
  }

  /** tmuxweb://share?… (the camera app scanned a share code): to the receiving side, filled in */
  private fun openShareLink(intent: Intent) {
    val link = intent.data?.toString()?.let(ShareLink::parse) ?: return
    model.incomingShare = link
    model.screen = Screen.Share
  }

  private fun openSession(id: Int) {
    if (model.activeId != null) model.screen = Screen.Page
    if (loadedBase != null) web.evaluateJavascript("location.hash = '#/s/$id'", null) else pendingSession = id
  }

  private fun reloadProfiles() {
    store = ProfileStore(this)
    model.profiles = store.profiles
    model.keys = store.keys
  }

  // ---- connection ----

  private fun show(s: TunnelState) {
    // a state of a connection given up on (disconnected meanwhile)
    if (model.activeId == null && s !is TunnelState.Idle) return
    model.tunnel = s
    when (s) {
      is TunnelState.Connecting -> model.step = s.step
      is TunnelState.Ready -> {
        model.step = if (model.active?.isDirect == true) 1 else 2
        // a new address, or the page failed while the connection was down: load it (again)
        if (loadedBase != s.base || web.url == null || web.url == "about:blank" || model.page is PageLoad.Failed) {
          loadedBase = s.base
          freshPage = true
          model.page = PageLoad.Loading
          web.loadUrl("${s.base}/" + (pendingSession?.let { "#/s/$it" } ?: ""))
          pendingSession = null
          Updater.checkSoon(this, s.base)
        } else if (reloadWhenBack) {
          reloadWhenBack = false
          web.reload()
        } else {
          // the same page, after a reconnect: its terminal and live updates reconnect now, not after their wait
          web.evaluateJavascript("dispatchEvent(new Event('online'))", null)
        }
      }
      is TunnelState.Failed -> {
        loadedBase = null
        model.page = PageLoad.None
      }
      else -> {}
    }
  }

  /** Its page: the one already up is just shown again; another one replaces it. */
  override fun connect(p: Profile) = connect(p, false)

  private fun connect(p: Profile, again: Boolean) {
    if (!p.isComplete) return edit(Screen.Editor(id = p.id))
    val s = Hub.state
    if (!again && model.activeId == p.id && (s is TunnelState.Ready || s is TunnelState.Connecting || s is TunnelState.Reconnecting)) {
      model.screen = Screen.Page
      return
    }
    resetPage()
    store.select(p.id)
    reloadProfiles()
    Hub.activeId = p.id
    Hub.profileTitle = p.title
    model.activeId = p.id
    model.step = 0
    model.startedAt = System.currentTimeMillis()
    model.tunnel = TunnelState.Connecting(0)
    model.screen = Screen.Page
    // this server's own login, not the last one's
    Logins.use(this, p, model.profiles) { if (model.activeId == p.id) TunnelService.start(this) }
  }

  override fun retry() {
    val p = model.active ?: return home()
    // the forward is up, only the page failed: just the page again
    val s = Hub.state
    if (s is TunnelState.Ready && model.page is PageLoad.Failed) {
      model.page = PageLoad.Loading
      model.startedAt = System.currentTimeMillis()
      freshPage = true
      web.loadUrl("${s.base}/")
    } else connect(p, true)
  }

  override fun disconnect() {
    TunnelService.stop(this)
    Hub.activeId = null
    model.activeId = null
    model.tunnel = TunnelState.Idle
    resetPage()
    model.screen = Screen.Home
  }

  override fun home() {
    model.screen = Screen.Home
  }

  /** the old server's page goes, so it never shows under another one's name */
  private fun resetPage() {
    loadedBase = null
    reloadWhenBack = false
    model.page = PageLoad.None
    web.loadUrl("about:blank")
  }

  override fun reload() {
    if (model.active?.isDirect == false) {
      reloadWhenBack = true
      TunnelService.check(this)
    }
    web.clearCache(false)
    web.reload()
  }

  // ---- servers ----

  override fun edit(e: Screen.Editor) {
    if (model.screen !is Screen.Editor) model.beforeEditor = model.screen
    model.screen = e
  }

  override fun closeEditor() {
    model.screen = model.beforeEditor
  }

  override fun save(p: Profile, connect: Boolean, original: Profile?) {
    store.upsert(p)
    reloadProfiles()
    val changed = original != p
    val inUse = model.activeId == p.id
    when {
      connect -> connect(p, changed && inUse)
      // the one in use, changed: connected again with the new settings, back where you were
      changed && inUse -> {
        val back = model.beforeEditor
        connect(p, true)
        model.screen = back
      }
      else -> closeEditor()
    }
  }

  override fun remove(p: Profile) {
    if (model.activeId == p.id) disconnect()
    store.remove(p.id)
    Logins.forget(this, p.id)
    reloadProfiles()
    model.probes.remove(p.id)
    model.screen = Screen.Home
  }

  override fun keys() {
    model.screen = Screen.Keys
  }

  override fun saveKey(k: SshKey) {
    store.upsertKey(k)
    reloadProfiles()
  }

  override fun removeKey(k: SshKey) {
    store.removeKey(k.id)
    reloadProfiles()
  }

  override fun share() {
    model.screen = Screen.Share
  }

  override fun importShared(payload: SharedPayload): ShareImportSummary {
    val summary = store.importShared(payload)
    reloadProfiles()
    return summary
  }

  override fun forgetHostKey(p: Profile) {
    KnownHosts(this).forget(p.host, p.sshPort)
    Toast.makeText(this, "已忘记 ${p.host} 的主机密钥，下次连接时重新记录", Toast.LENGTH_SHORT).show()
  }

  /** every server's reachability, for the cards (the results come in one by one) */
  override fun probeAll() {
    val list = model.profiles
    if (list.isEmpty() || model.probing > 0) return
    model.probing = list.size
    for (p in list) {
      if (model.probes[p.id] == null) model.probes[p.id] = Probe.Result.Checking
      Probe.check(p) { r ->
        runOnUiThread {
          model.probes[p.id] = r
          model.probing = (model.probing - 1).coerceAtLeast(0)
        }
      }
    }
  }

  /** through our server while connected, else the mirrors */
  override fun checkUpdates() = Updater.checkSoon(this, loadedBase.takeIf { Hub.state is TunnelState.Ready }, asked = true)

  override fun answer(q: Hub.Question, text: String?) {
    Hub.answer(q, text)
    model.question = null
  }

  override fun openUrl(url: String) {
    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
  }

  // ---- the web view ----

  @SuppressLint("SetJavaScriptEnabled")
  private fun buildWeb(): WebView {
    // debug builds: chrome://inspect works (automated tests read the page through it)
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    val w = WebView(this)
    w.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      mediaPlaybackRequiresUserGesture = false
      textZoom = 100
      // the page's viewport width counts (WebView ignores it unless told): 页面布局 → 手机版 / 电脑版
      // lays the page out 480 / 1180 wide and scales it to the screen, as in Chrome
      useWideViewPort = true
      loadWithOverviewMode = true
    }
    CookieManager.getInstance().setAcceptCookie(true)
    w.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
        val u = req.url
        // other sites open in the browser
        if (u.host != "127.0.0.1" && u.host != loadedBase?.let { Uri.parse(it).host } && (u.scheme == "http" || u.scheme == "https")) {
          startActivity(Intent(Intent.ACTION_VIEW, u))
          return true
        }
        return false
      }
      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (url != null && loadedBase != null && url.startsWith(loadedBase!!) && model.page !is PageLoad.Loaded) model.page = PageLoad.Loading
      }
      override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
        // the forward is up but tmux-web doesn't answer behind it (or the address is wrong)
        if (req.isForMainFrame && loadedBase != null && req.url.toString().startsWith(loadedBase!!)) {
          model.page = PageLoad.Failed("${err.description}（${err.errorCode}）")
          // maybe it's the connection: check it (replaced if dead; the page loads again once it's back)
          if (model.active?.isDirect == false) {
            reloadWhenBack = true
            TunnelService.check(this@MainActivity)
          }
        }
      }
      override fun onPageFinished(view: WebView, url: String?) {
        if (url != null && loadedBase != null && url.startsWith(loadedBase!!)) {
          if (model.page !is PageLoad.Failed) {
            model.page = PageLoad.Loaded
            reloadWhenBack = false
          }
          if (freshPage) {
            freshPage = false
            view.clearHistory()
          }
        }
        CookieManager.getInstance().flush()
      }
    }
    w.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = cb
        return try {
          @Suppress("DEPRECATION")
          startActivityForResult(params.createIntent().putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE), FILES)
          true
        } catch (e: Exception) {
          fileCallback = null
          false
        }
      }
    }
    w.setDownloadListener { url, ua, disposition, mime, _ ->
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
    return w
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == FILES) {
      fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data) ?: data?.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } })
      fileCallback = null
    }
  }

  companion object {
    private const val FILES = 7
  }
}
