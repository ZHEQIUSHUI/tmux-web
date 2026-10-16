package com.zheqiushui.tmuxweb

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Updates: version.json of the latest release, preferably through our own server (the forward is
 * already there, and GitHub may be slow or unreachable from the phone), else from the mirrors.
 */
object Updater {
  private const val GITHUB = "https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/"
  private const val EVERY_MS = 6 * 3600 * 1000L
  // Besides our server: GitHub, GitHub's download proxies in mainland China, and the release in
  // GHCR (CI puts it there too) through Nanjing University's mirror. Whoever serves a file, it's
  // checked against version.json's SHA-256.
  private val PROXIES = listOf("https://ghfast.top/", "https://gh-proxy.com/", "https://gh.llkk.cc/", "https://ghproxy.net/")
  private const val IMAGE = "zheqiushui/tmux-web-app"

  /** A place the release can be had: its version.json, and how to ask it for a file (url, headers). */
  private class Mirror(val version: () -> JSONObject?, val file: (name: String, sha: String) -> Pair<String, Map<String, String>>?)

  private fun ghcr(host: String) = Mirror(
    version = {
      ghcrToken()?.let { t ->
        fetchJson("https://$host/v2/$IMAGE/manifests/latest", mapOf("Authorization" to "Bearer $t", "Accept" to "application/vnd.oci.image.manifest.v1+json"))
          ?.optJSONObject("annotations")?.optString("tw.version")?.takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
      }
    },
    // each file is a blob named by its SHA-256
    file = { _, sha -> if (sha.isEmpty()) null else ghcrToken()?.let { "https://$host/v2/$IMAGE/blobs/sha256:$sha" to mapOf("Authorization" to "Bearer $it") } },
  )

  private fun web(prefix: String) = Mirror(version = { fetchJson(prefix + GITHUB + "version.json") }, file = { name, _ -> prefix + GITHUB + name to emptyMap() })

  /** in the order they're tried for a file when none is known to be quicker */
  private val MIRRORS = listOf(ghcr("ghcr.nju.edu.cn")) + PROXIES.map { web(it) } + listOf(web(""), ghcr("ghcr.io"))

  private fun ghcrToken(): String? = fetchJson("https://ghcr.io/token?service=ghcr.io&scope=repository:$IMAGE:pull")?.optString("token")?.ifEmpty { null }

  /** version.json from every mirror at once: the first answer, and which mirror gave it */
  private fun raceVersion(): Pair<JSONObject, Int>? {
    val results = java.util.concurrent.LinkedBlockingQueue<Pair<Int, JSONObject?>>()
    MIRRORS.forEachIndexed { i, m -> Thread { results.put(i to runCatching { m.version() }.getOrNull()) }.apply { isDaemon = true }.start() }
    repeat(MIRRORS.size) {
      val (i, info) = results.poll(25, java.util.concurrent.TimeUnit.SECONDS) ?: return null
      if (info != null && info.optString("version").isNotEmpty()) return info to i
    }
    return null
  }

  /** What the update dialog shows; null: nothing. Changed on the main thread only. */
  sealed interface Ui {
    object Checking : Ui
    data class Latest(val version: String) : Ui
    data class Failed(val title: String, val text: String, val retry: Boolean) : Ui
    data class Offer(val version: String, val notes: String) : Ui
    /** `total` < 0: not known yet (still connecting, or the server is fetching it first) */
    data class Downloading(val version: String, val from: String, val done: Long, val total: Long, val speed: Long) : Ui
    data class Ready(val version: String) : Ui
  }

  var ui by mutableStateOf<Ui?>(null)
    private set
  /** the dialog was put away while the download goes on (it comes back when done, or on 检查更新) */
  var hidden by mutableStateOf(false)
    private set

  private val main = Handler(Looper.getMainLooper())

  // what the offer is about, for 更新 / 跳过
  private var base: String? = null
  private var info: JSONObject? = null
  private var quickest: Int? = null
  private var apk: File? = null
  /** the download going on; another number (取消, or a new one) stops it */
  @Volatile private var job = 0

  /**
   * At most every 6 hours on its own; `asked` (检查更新): now, saying what came of it, and a skipped
   * version is offered again. `base`: our server's address while connected (null: the mirrors only).
   */
  fun checkSoon(a: Activity, base: String?, asked: Boolean = false) {
    // already downloading or downloaded: bring that back instead
    if (ui is Ui.Downloading || ui is Ui.Ready) {
      if (asked) hidden = false
      return
    }
    val prefs = a.getSharedPreferences("updates", Context.MODE_PRIVATE)
    if (!asked && System.currentTimeMillis() - prefs.getLong("checked", 0) < EVERY_MS) return
    if (asked) {
      hidden = false
      ui = Ui.Checking
    }
    // what was asked for is answered while its dialog is still there (取消 closes it)
    val answer = { u: Ui -> if (asked) main.post { if (ui == Ui.Checking) ui = u } }
    val fail = { text: String -> answer(Ui.Failed("检查更新失败", text, retry = false)) }
    Thread {
      // the mirror that answered first is likely the quickest for the download too
      var quick: Int? = null
      val info = base?.let { fetchJson("$it/_tw/api/app/version.json") } ?: raceVersion()?.let { (j, i) -> quick = i; j }
      if (info == null) return@Thread fail("服务器、GitHub 和镜像都没取到版本信息，稍后再试。")
      prefs.edit().putLong("checked", System.currentTimeMillis()).apply()
      val android = info.optJSONObject("android") ?: return@Thread fail("版本信息里没有安卓的安装包。")
      val code = android.optInt("versionCode")
      if (code <= BuildConfig.VERSION_CODE) return@Thread answer(Ui.Latest(BuildConfig.VERSION_NAME))
      if (!asked && prefs.getInt("skipped", 0) == code) return@Thread
      main.post {
        // one asked for: only while its dialog is up; one on its own: not over another dialog
        if (if (asked) ui != Ui.Checking else ui != null) return@post
        this.base = base
        this.info = info
        quickest = quick
        hidden = false
        ui = Ui.Offer(info.optString("version"), info.optString("notes").ifBlank { "当前版本 ${BuildConfig.VERSION_NAME}" })
      }
    }.start()
  }

  fun dismiss() {
    ui = null
  }

  fun skip(a: Activity) {
    info?.optJSONObject("android")?.optInt("versionCode")?.let { a.getSharedPreferences("updates", Context.MODE_PRIVATE).edit().putInt("skipped", it).apply() }
    ui = null
  }

  /** put the dialog away; the download goes on */
  fun hide() {
    hidden = true
  }

  fun cancel() {
    job++
    ui = null
  }

  /** 更新: download (with progress), check it, then the system installer */
  fun download(a: Activity) {
    val info = info ?: return
    val android = info.optJSONObject("android") ?: return
    val version = info.optString("version")
    val name = android.optString("file", "tmux-web-android.apk")
    val sha = android.optString("sha256")
    val size = android.optLong("size", -1)
    val app = a.applicationContext
    val id = ++job
    val gone = { job != id }
    // progress of this download, unless it was stopped
    val show = { u: Ui -> main.post { if (!gone()) ui = u } }
    hidden = false
    ui = Ui.Downloading(version, "", 0, -1, 0)
    Thread {
      val dir = File(app.cacheDir, "updates").apply { mkdirs() }
      val file = File(dir, "tmux-web.apk")
      // our server (it fetches from the quickest mirror itself), then the mirrors, the quick one first
      val order = MIRRORS.indices.sortedBy { if (it == quickest) -1 else it }
      val tries = listOfNotNull(base?.let { b -> { "$b/_tw/api/app/download/$name" to emptyMap<String, String>() } }) + order.map { i -> { MIRRORS[i].file(name, sha) } }
      val ok = tries.any { next ->
        if (gone()) return@any false
        val (url, headers) = next() ?: return@any false
        val from = if (base != null && url.startsWith(base!!)) "服务器" else Uri.parse(url).host ?: url
        show(Ui.Downloading(version, from, 0, -1, 0))
        fetchFile(url, file, headers, gone) { done, total, speed -> show(Ui.Downloading(version, from, done, if (total > 0) total else size, speed)) } &&
          (sha.isEmpty() || sha256(file).equals(sha, ignoreCase = true))
      }
      if (gone()) return@Thread file.delete().let {}
      main.post {
        if (gone()) return@post
        if (!ok) {
          hidden = false
          ui = Ui.Failed("下载更新失败", "服务器、GitHub 和各个镜像都没下载成功，稍后再试。", retry = true)
          return@post
        }
        apk = file
        hidden = false
        ui = Ui.Ready(version)
        if (!a.isFinishing && a.packageManager.canRequestPackageInstalls()) install(a)
      }
    }.start()
  }

  /** the system installer; the first time, the setting that allows it */
  fun install(a: Activity) {
    val file = apk ?: return
    if (!a.packageManager.canRequestPackageInstalls()) {
      a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
      return
    }
    val uri = FileProvider.getUriForFile(a, "${a.packageName}.files", file)
    a.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
  }

  private fun fetchJson(url: String, headers: Map<String, String> = emptyMap()): JSONObject? = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 15_000
    headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
    if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()) else null
  } catch (_: Exception) {
    null
  }

  /** `progress`(bytes so far, total or -1, bytes a second), a few times a second */
  private fun fetchFile(url: String, to: File, headers: Map<String, String>, stop: () -> Boolean, progress: (Long, Long, Long) -> Unit): Boolean = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 60_000
    headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
    if (c.responseCode != 200) false
    else {
      val total = c.contentLengthLong
      var done = 0L
      var lastAt = System.nanoTime()
      var lastDone = 0L
      var speed = 0L
      progress(0, total, 0)
      c.inputStream.use { i ->
        to.outputStream().use { o ->
          val buf = ByteArray(65536)
          while (true) {
            if (stop()) throw java.io.IOException("cancelled")
            val n = i.read(buf)
            if (n < 0) break
            o.write(buf, 0, n)
            done += n
            val now = System.nanoTime()
            if (now - lastAt > 200_000_000L) {
              val s = (done - lastDone) * 1_000_000_000L / (now - lastAt)
              speed = if (speed == 0L) s else (speed * 2 + s) / 3
              lastAt = now
              lastDone = done
              progress(done, total, speed)
            }
          }
        }
      }
      progress(done, total, speed)
      total < 0 || done == total
    }
  } catch (_: Exception) {
    false
  }

  private fun sha256(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { i ->
      val buf = ByteArray(65536)
      while (true) {
        val n = i.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }
}

private fun mb(b: Long) = "%.1f MB".format(b / 1048576.0)
private fun rate(b: Long) = if (b >= 1048576) "%.1f MB/s".format(b / 1048576.0) else "${b / 1024} KB/s"

/** The update, from 检查更新 to the installer: what was found, the download's progress, what went wrong. */
@Composable
fun UpdateDialog() {
  val u = Updater.ui ?: return
  if (Updater.hidden) return
  val a = LocalContext.current as Activity
  // 安装未知应用 may have just been allowed in the settings we sent them to
  var allowed by remember { mutableStateOf(a.packageManager.canRequestPackageInstalls()) }
  val owner = LocalLifecycleOwner.current
  DisposableEffect(owner) {
    val o = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) allowed = a.packageManager.canRequestPackageInstalls() }
    owner.lifecycle.addObserver(o)
    onDispose { owner.lifecycle.removeObserver(o) }
  }
  val busy = u is Updater.Ui.Checking || u is Updater.Ui.Downloading
  AlertDialog(
    onDismissRequest = { if (u is Updater.Ui.Downloading) Updater.hide() else if (!busy) Updater.dismiss() },
    properties = DialogProperties(dismissOnClickOutside = !busy),
    icon = when (u) {
      is Updater.Ui.Latest, is Updater.Ui.Ready -> ({ Icon(Icons.Filled.CheckCircle, null, tint = MaterialTheme.colorScheme.primary) })
      is Updater.Ui.Failed -> ({ Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.error) })
      else -> ({ Icon(UpdateIcon, null) })
    },
    title = {
      Text(
        when (u) {
          Updater.Ui.Checking -> "正在检查更新…"
          is Updater.Ui.Latest -> "已是最新版本"
          is Updater.Ui.Failed -> u.title
          is Updater.Ui.Offer -> "发现新版本 ${u.version}"
          is Updater.Ui.Downloading -> "正在下载 ${u.version}"
          is Updater.Ui.Ready -> "${u.version} 已下载"
        },
      )
    },
    text = {
      when (u) {
        Updater.Ui.Checking -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
          LinearProgressIndicator(Modifier.fillMaxWidth())
          Text("当前版本 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is Updater.Ui.Latest -> Text("当前版本 ${u.version}。")
        is Updater.Ui.Failed -> Text(u.text)
        is Updater.Ui.Offer -> Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text("当前版本 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Text(u.notes)
        }
        is Updater.Ui.Downloading -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
          if (u.total > 0) {
            val f = (u.done.toFloat() / u.total).coerceIn(0f, 1f)
            LinearProgressIndicator(progress = { f }, Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
              Text("${(f * 100).toInt()}%", fontWeight = FontWeight.SemiBold)
              Text("${mb(u.done)} / ${mb(u.total)}" + if (u.speed > 0) " · ${rate(u.speed)}" else "", style = MaterialTheme.typography.bodyMedium)
            }
          } else {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(
              when {
                u.from.isEmpty() -> "正在准备…"
                u.done > 0 -> "已下载 ${mb(u.done)}"
                u.from == "服务器" -> "服务器正在取安装包…"
                else -> "正在连接…"
              },
            )
          }
          if (u.from.isNotEmpty()) Text("来源：${u.from}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is Updater.Ui.Ready -> Text(
          if (allowed) "已下载并校验。点「安装」，按系统提示完成更新。"
          else "已下载并校验。安装更新需要允许 tmux-web「安装未知应用」：点「去设置」允许后返回，再点「安装」。",
        )
      }
    },
    confirmButton = {
      when (u) {
        is Updater.Ui.Offer -> TextButton(onClick = { Updater.download(a) }) { Text("更新") }
        is Updater.Ui.Downloading -> TextButton(onClick = { Updater.hide() }) { Text("后台下载") }
        is Updater.Ui.Ready -> TextButton(onClick = { Updater.install(a) }) { Text(if (allowed) "安装" else "去设置") }
        is Updater.Ui.Failed -> if (u.retry) TextButton(onClick = { Updater.download(a) }) { Text("重试") } else TextButton(onClick = { Updater.dismiss() }) { Text("好") }
        is Updater.Ui.Latest -> TextButton(onClick = { Updater.dismiss() }) { Text("好") }
        Updater.Ui.Checking -> {}
      }
    },
    dismissButton = {
      when (u) {
        is Updater.Ui.Offer -> Row {
          TextButton(onClick = { Updater.skip(a) }) { Text("跳过这个版本") }
          TextButton(onClick = { Updater.dismiss() }) { Text("以后") }
        }
        is Updater.Ui.Downloading -> TextButton(onClick = { Updater.cancel() }) { Text("取消") }
        is Updater.Ui.Ready -> TextButton(onClick = { Updater.dismiss() }) { Text("以后") }
        is Updater.Ui.Failed -> if (u.retry) TextButton(onClick = { Updater.dismiss() }) { Text("关闭") }
        Updater.Ui.Checking -> TextButton(onClick = { Updater.dismiss() }) { Text("取消") }
        else -> {}
      }
    },
  )
}
