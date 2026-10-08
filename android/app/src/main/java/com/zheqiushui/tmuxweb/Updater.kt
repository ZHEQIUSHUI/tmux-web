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
 * already there, and GitHub may be slow or unreachable from the phone), else from GitHub itself.
 */
object Updater {
  private const val GITHUB = "https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/"
  private const val EVERY_MS = 6 * 3600 * 1000L

  fun checkSoon(a: Activity, port: Int, force: Boolean = false) {
    val prefs = a.getSharedPreferences("updates", Context.MODE_PRIVATE)
    if (!force && System.currentTimeMillis() - prefs.getLong("checked", 0) < EVERY_MS) return
    Thread {
      val info = fetchJson("http://127.0.0.1:$port/_tw/api/app/version.json") ?: fetchJson(GITHUB + "version.json") ?: return@Thread
      prefs.edit().putLong("checked", System.currentTimeMillis()).apply()
      val android = info.optJSONObject("android") ?: return@Thread
      val code = android.optInt("versionCode")
      if (code <= BuildConfig.VERSION_CODE || prefs.getInt("skipped", 0) == code) return@Thread
      a.runOnUiThread {
        if (a.isFinishing) return@runOnUiThread
        AlertDialog.Builder(a)
          .setTitle("发现新版本 ${info.optString("version")}")
          .setMessage(info.optString("notes").ifBlank { "当前版本 ${BuildConfig.VERSION_NAME}" })
          .setPositiveButton("更新") { _, _ -> download(a, port, android) }
          .setNegativeButton("以后") { _, _ -> }
          .setNeutralButton("跳过这个版本") { _, _ -> prefs.edit().putInt("skipped", code).apply() }
          .show()
      }
    }.start()
  }

  private fun download(a: Activity, port: Int, android: JSONObject) {
    val name = android.optString("file", "tmux-web-android.apk")
    val sha = android.optString("sha256")
    Toast.makeText(a, "正在下载更新…", Toast.LENGTH_SHORT).show()
    Thread {
      val dir = File(a.cacheDir, "updates").apply { mkdirs() }
      val apk = File(dir, "tmux-web.apk")
      val ok = listOf("http://127.0.0.1:$port/_tw/api/app/download/$name", GITHUB + name).any { url ->
        fetchFile(url, apk) && (sha.isEmpty() || sha256(apk).equals(sha, ignoreCase = true))
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

  private fun fetchJson(url: String): JSONObject? = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 15_000
    if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()) else null
  } catch (_: Exception) {
    null
  }

  private fun fetchFile(url: String, to: File): Boolean = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000
    c.readTimeout = 60_000
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
