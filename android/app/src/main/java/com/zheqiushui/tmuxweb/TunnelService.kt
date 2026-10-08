package com.zheqiushui.tmuxweb

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** What the window and the service share (one process). */
object Hub {
  private val main = Handler(Looper.getMainLooper())
  private val listeners = mutableSetOf<(TunnelState) -> Unit>()
  @Volatile var state: TunnelState = TunnelState.Idle
    private set
  /** the window is in front (alerts are shown by the page then) */
  @Volatile var foreground = false
  var profileTitle = ""

  fun publish(s: TunnelState) {
    state = s
    main.post { listeners.toList().forEach { it(s) } }
  }
  fun listen(l: (TunnelState) -> Unit) { listeners += l; l(state) }
  fun unlisten(l: (TunnelState) -> Unit) { listeners -= l }

  // ---- questions from ssh (codes, passwords) answered in the window ----

  class Question(val prompt: String, val secret: Boolean) {
    val answer = AtomicReference<String?>(null)
    val done = CountDownLatch(1)
  }
  @Volatile var question: Question? = null
  /** the window shows questions; set while it exists */
  var onQuestion: ((Question) -> Unit)? = null

  fun ask(context: Context, prompt: String, secret: Boolean): String? {
    val q = Question(prompt, secret)
    question = q
    main.post { onQuestion?.invoke(q) ?: Notices.askNotification(context, prompt) }
    val ok = q.done.await(5, TimeUnit.MINUTES)
    question = null
    return if (ok) q.answer.get() else null
  }
  fun answer(q: Question, text: String?) {
    q.answer.set(text)
    q.done.countDown()
  }
}

/**
 * Keeps the forward up while the app is in the background (a foreground service, with its quiet
 * notification), and turns tmux-web's alerts (waiting for you / done) into notifications.
 */
class TunnelService : Service() {
  private lateinit var tunnel: Tunnel
  @Volatile private var alertsThread: Thread? = null

  override fun onCreate() {
    super.onCreate()
    Notices.channels(this)
    tunnel = Tunnel(this, { prompt, secret -> Hub.ask(this, prompt, secret) }) { s ->
      Hub.publish(s)
      updateNotification(s)
      if (s is TunnelState.Ready) followAlerts(s.base)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = Notices.service(this, "正在连接…")
    if (Build.VERSION.SDK_INT >= 34) startForeground(Notices.SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(Notices.SERVICE_ID, notification)
    when (intent?.action) {
      ACTION_STOP -> {
        tunnel.stop()
        stopSelf()
      }
      // "make sure it's up": nothing to do while it is connecting or connected
      ACTION_ENSURE -> if (tunnel.state is TunnelState.Idle || tunnel.state is TunnelState.Failed) connect()
      // new settings, or 重试: start over
      else -> connect()
    }
    return START_STICKY
  }

  private fun connect() {
    val p = ProfileStore(this).current
    if (p == null || !p.isComplete) return Hub.publish(TunnelState.Failed("还没有设置服务器。"))
    Hub.profileTitle = p.title
    tunnel.start(p)
  }

  override fun onDestroy() {
    tunnel.stop()
    alertsThread?.interrupt()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun updateNotification(s: TunnelState) {
    val text = when (s) {
      is TunnelState.Ready -> "已连接 ${Hub.profileTitle}"
      is TunnelState.Connecting -> "正在连接…"
      is TunnelState.Reconnecting -> s.message
      is TunnelState.Failed -> "连不上：${s.message}"
      TunnelState.Idle -> "未连接"
    }
    getSystemService(NotificationManager::class.java).notify(Notices.SERVICE_ID, Notices.service(this, text))
  }

  /**
   * tmux-web's alert stream (SSE), through the forward, with the page's login: a notification for
   * each while you aren't looking at the app.
   */
  private fun followAlerts(base: String) {
    alertsThread?.interrupt()
    alertsThread = Thread({
      while (!Thread.currentThread().isInterrupted && Hub.state is TunnelState.Ready) {
        try {
          val cookie = CookieManager.getInstance().getCookie(base)
          if (cookie == null || !cookie.contains("tw_sid")) {
            Thread.sleep(10_000) // not logged in yet
            continue
          }
          val c = URL("$base/_tw/api/notifications/stream").openConnection() as HttpURLConnection
          c.setRequestProperty("Cookie", cookie)
          c.setRequestProperty("Accept", "text/event-stream")
          c.readTimeout = 60_000 // the server pings every 20 s
          c.inputStream.bufferedReader().use { r ->
            var event = ""
            while (true) {
              val line = r.readLine() ?: break
              when {
                line.startsWith("event:") -> event = line.substring(6).trim()
                line.startsWith("data:") && event == "notice" -> if (!Hub.foreground) Notices.alert(this, JSONObject(line.substring(5).trim()))
                line.isEmpty() -> event = ""
              }
            }
          }
        } catch (_: InterruptedException) {
          return@Thread
        } catch (_: Exception) {
          try { Thread.sleep(5000) } catch (_: InterruptedException) { return@Thread }
        }
      }
    }, "alerts").apply { isDaemon = true; start() }
  }

  companion object {
    const val ACTION_STOP = "stop"
    const val ACTION_ENSURE = "ensure"
    /** (re)connect with the current settings */
    fun start(context: Context) = send(context, null)
    /** connect unless already connecting / connected */
    fun ensure(context: Context) = send(context, ACTION_ENSURE)
    private fun send(context: Context, action: String?) {
      val i = Intent(context, TunnelService::class.java).setAction(action)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
    }
    fun stop(context: Context) {
      context.startService(Intent(context, TunnelService::class.java).setAction(ACTION_STOP))
    }
  }
}

object Notices {
  const val SERVICE_ID = 1
  private const val ASK_ID = 2
  private const val CH_SERVICE = "tunnel"
  private const val CH_ALERTS = "alerts"
  private var nextId = 100

  fun channels(c: Context) {
    val nm = c.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "连接状态", NotificationManager.IMPORTANCE_MIN))
    nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "会话提醒", NotificationManager.IMPORTANCE_HIGH))
  }

  private fun open(c: Context, sessionId: Int? = null, req: Int = 0): PendingIntent {
    val i = Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (sessionId != null) i.putExtra("sessionId", sessionId)
    return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun service(c: Context, text: String): Notification =
    Notification.Builder(c, CH_SERVICE)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle("tmux-web")
      .setContentText(text)
      .setOngoing(true)
      .setContentIntent(open(c))
      .build()

  fun alert(c: Context, n: JSONObject) {
    val sid = n.optInt("sessionId", -1)
    val b = Notification.Builder(c, CH_ALERTS)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(n.optString("title", "tmux-web"))
      .setContentText(n.optString("text"))
      .setStyle(Notification.BigTextStyle().bigText(n.optString("text")))
      .setSubText(n.optString("session"))
      .setAutoCancel(true)
      .setContentIntent(open(c, sid.takeIf { it >= 0 }, sid))
    c.getSystemService(NotificationManager::class.java).notify(nextId++, b.build())
  }

  /** ssh asks something while the app is in the background: tap to answer */
  fun askNotification(c: Context, prompt: String) {
    val b = Notification.Builder(c, CH_ALERTS)
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
      .setContentTitle("SSH 需要输入")
      .setContentText(prompt)
      .setAutoCancel(true)
      .setContentIntent(open(c))
    c.getSystemService(NotificationManager::class.java).notify(ASK_ID, b.build())
  }
}
