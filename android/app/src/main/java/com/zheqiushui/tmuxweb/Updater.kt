package com.zheqiushui.tmuxweb

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
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

  fun checkSoon(a: Activity, base: String, force: Boolean = false) {
    val prefs = a.getSharedPreferences("updates", Context.MODE_PRIVATE)
    if (!force && System.currentTimeMillis() - prefs.getLong("checked", 0) < EVERY_MS) return
    Thread {
      // the mirror that answered first is likely the quickest for the download too
      var quickest: Int? = null
      val info = fetchJson("$base/_tw/api/app/version.json") ?: raceVersion()?.let { (j, i) -> quickest = i; j } ?: return@Thread
      prefs.edit().putLong("checked", System.currentTimeMillis()).apply()
      val android = info.optJSONObject("android") ?: return@Thread
      val code = android.optInt("versionCode")
      if (code <= BuildConfig.VERSION_CODE || prefs.getInt("skipped", 0) == code) return@Thread
      a.runOnUiThread {
        if (a.isFinishing) return@runOnUiThread
        AlertDialog.Builder(a)
          .setTitle("发现新版本 ${info.optString("version")}")
          .setMessage(info.optString("notes").ifBlank { "当前版本 ${BuildConfig.VERSION_NAME}" })
          .setPositiveButton("更新") { _, _ -> download(a, base, android, quickest) }
          .setNegativeButton("以后") { _, _ -> }
          .setNeutralButton("跳过这个版本") { _, _ -> prefs.edit().putInt("skipped", code).apply() }
          .show()
      }
    }.start()
  }

  private fun download(a: Activity, base: String, android: JSONObject, quickest: Int?) {
    val name = android.optString("file", "tmux-web-android.apk")
    val sha = android.optString("sha256")
    Toast.makeText(a, "正在下载更新…", Toast.LENGTH_SHORT).show()
    Thread {
      val dir = File(a.cacheDir, "updates").apply { mkdirs() }
      val apk = File(dir, "tmux-web.apk")
      // our server (it fetches from the quickest mirror itself), then the mirrors, the quick one first
      val order = MIRRORS.indices.sortedBy { if (it == quickest) -1 else it }
      val tries = listOf { "$base/_tw/api/app/download/$name" to emptyMap<String, String>() } + order.map { i -> { MIRRORS[i].file(name, sha) } }
      val ok = tries.any { next ->
        val (url, headers) = next() ?: return@any false
        fetchFile(url, apk, headers) && (sha.isEmpty() || sha256(apk).equals(sha, ignoreCase = true))
      }
      a.runOnUiThread {
        if (!ok) Toast.makeText(a, "下载更新失败，稍后再试", Toast.LENGTH_LONG).show()
        else install(a, apk)
      }
    }.start()
  }

  private fun install(a: Activity, apk: File) {
    if (!a.packageManager.canRequestPackageInstalls()) {
      AlertDialog.Builder(a)
        .setMessage("安装更新需要允许 tmux-web「安装未知应用」。打开设置允许后，回来再点一次「更新」。")
        .setPositiveButton("去设置") { _, _ -> a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}"))) }
        .setNegativeButton("取消", null)
        .show()
      a.getSharedPreferences("updates", Context.MODE_PRIVATE).edit().putLong("checked", 0).apply()
      return
    }
    val uri = FileProvider.getUriForFile(a, "${a.packageName}.files", apk)
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

  private fun fetchFile(url: String, to: File, headers: Map<String, String> = emptyMap()): Boolean = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 60_000
    headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
    if (c.responseCode != 200) false
    else {
      c.inputStream.use { i -> to.outputStream().use { o -> i.copyTo(o) } }
      true
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
