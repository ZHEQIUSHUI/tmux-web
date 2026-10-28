package com.zheqiushui.tmuxweb

import android.content.Context
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.method.AuthKeyboardInteractive
import net.schmizz.sshj.userauth.method.AuthMethod
import net.schmizz.sshj.userauth.method.AuthPassword
import net.schmizz.sshj.userauth.method.AuthPublickey
import net.schmizz.sshj.userauth.method.ChallengeResponseProvider
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.PasswordUtils
import net.schmizz.sshj.userauth.password.Resource
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.PublicKey
import java.security.Security
import java.util.concurrent.TimeUnit

/** Android's built-in "BC" is a cut-down one: sshj needs the full BouncyCastle. */
object Bc {
  private val done by lazy {
    Security.removeProvider("BC")
    Security.insertProviderAt(BouncyCastleProvider(), 1)
  }
  fun install() = done
}

/** Where the forward is; observed by the window and the notification. */
sealed class TunnelState {
  object Idle : TunnelState()
  /** `step`: 0 = reaching the server (SSH: and logging in), 1 = the port forward (SSH only) */
  data class Connecting(val step: Int = 0) : TunnelState()
  /** the page's address: the forward (http://127.0.0.1:<port>) or the direct one */
  data class Ready(val base: String) : TunnelState()
  /** gone after it worked: trying again on its own */
  data class Reconnecting(val message: String) : TunnelState()
  /** never came up: waiting for the user */
  data class Failed(val message: String) : TunnelState()
}

/** Asks the user something ssh wants to know (a code, a password); blocks until answered (null = cancelled). */
fun interface Asker {
  fun ask(prompt: String, secret: Boolean): String?
}

/**
 * The SSH port forward to tmux-web (sshj): 127.0.0.1:<localPort> → <remoteHost>:<remotePort> on the
 * server. Keeps itself up: reconnects after the network goes away.
 */
class Tunnel(private val context: Context, private val asker: Asker, private val onState: (TunnelState) -> Unit) {
  @Volatile private var wanted = false
  /** each start is a new run; an older run that is still winding down must not report anything */
  @Volatile private var generation = 0
  @Volatile private var client: SSHClient? = null
  @Volatile private var server: ServerSocket? = null
  @Volatile private var profile: Profile? = null
  private var thread: Thread? = null
  /** the wait before the next reconnect; nudge() cuts it short */
  private val pause = Object()
  @Volatile private var nudged = false
  @Volatile private var checking = false
  @Volatile var state: TunnelState = TunnelState.Idle
    private set

  private fun report(gen: Int, s: TunnelState) {
    if (gen != generation) return
    state = s
    onState(s)
  }

  companion object {
    init { Bc.install() }
  }

  fun start(p: Profile) {
    stop()
    profile = p
    wanted = true
    val gen = ++generation
    thread = Thread({ run(p, gen) }, "tunnel").apply { isDaemon = true; start() }
  }

  fun stop() {
    wanted = false
    val wasEasyTier = profile?.isEasyTier == true
    profile = null
    try { server?.close() } catch (_: Exception) {}
    try { client?.disconnect() } catch (_: Exception) {}
    if (wasEasyTier) EasyTierNative.stop()
    thread?.interrupt()
    thread = null
    generation++
    state = TunnelState.Idle
    onState(TunnelState.Idle)
  }

  /** No SSH: the address is reachable as it is. One look whether tmux-web answers there. */
  private fun direct(p: Profile, gen: Int) {
    val base = p.directBase ?: return report(gen, TunnelState.Failed("地址不对：${p.directUrl}"))
    report(gen, TunnelState.Connecting(0))
    try {
      if (!webAnswers(base, 10_000)) throw IllegalStateException("没有响应")
      report(gen, TunnelState.Ready(base))
    } catch (e: Exception) {
      report(gen, TunnelState.Failed("打不开 $base：${describe(e)}"))
    }
  }

  /** The bundled EasyTier joins the virtual network; the generated forward exposes tmux-web locally. */
  private fun runEasyTier(p: Profile, gen: Int) {
    var everReady = false
    var retry = 0
    while (wanted && gen == generation) {
      report(gen, if (everReady) TunnelState.Reconnecting("EasyTier 正在重新连接…") else TunnelState.Connecting(0))
      try {
        easyTierConnection(p, gen) { everReady = true; retry = 0 }
      } catch (e: Exception) {
        if (!wanted || gen != generation) return
        val msg = EasyTierLog.redact(describe(e), p.easyTierSecret)
        android.util.Log.w("tmux-web", "EasyTier: $msg")
        if (!everReady) {
          report(gen, TunnelState.Failed(msg))
          wanted = false
          return
        }
        retry++
        val wait = minOf(30, 1 shl minOf(retry, 5))
        report(gen, TunnelState.Reconnecting("EasyTier 连接断开，$wait 秒后重连…"))
        try {
          synchronized(pause) {
            if (!nudged) pause.wait(wait * 1000L)
            nudged = false
          }
        } catch (_: InterruptedException) { return }
      } finally {
        EasyTierNative.stop()
      }
    }
  }

  /** Starts one instance, waits for tmux-web through the forward, then watches it until it breaks. */
  private fun easyTierConnection(p: Profile, gen: Int, onReady: () -> Unit) {
    EasyTierConfig.problem(p)?.let { throw EasyTierException(it) }
    var waited = 0
    while (waited < 1_000 && portInUse(p.localPort)) {
      if (!sleep(100)) return
      waited += 100
    }
    if (portInUse(p.localPort)) {
      throw IllegalStateException("本地端口 ${p.localPort} 已被占用，换一个本地端口试试。")
    }

    EasyTierNative.start(EasyTierConfig.make(p), p.easyTierSecret)
    val base = "http://127.0.0.1:${p.localPort}"
    val deadline = System.currentTimeMillis() + 60_000
    var ready = false
    while (wanted && gen == generation && System.currentTimeMillis() < deadline) {
      if (webAnswers(base, 2_000)) {
        ready = true
        break
      }
      if (!sleep(500)) return
    }
    if (!wanted || gen != generation) return
    if (!ready) throw IllegalStateException("EasyTier 在 60 秒内没有连上 tmux-web。检查网络名称、密钥、公共节点和服务器虚拟 IP。")

    report(gen, TunnelState.Ready(base))
    onReady()

    var misses = 0
    while (wanted && gen == generation) {
      if (!sleep(5_000)) return
      if (webAnswers(base, 3_000)) {
        misses = 0
        if (state !is TunnelState.Ready) report(gen, TunnelState.Ready(base))
      } else if (++misses >= 3) {
        throw IllegalStateException("EasyTier 连接断开")
      }
    }
  }

  private fun webAnswers(base: String, timeout: Int): Boolean = try {
    val c = java.net.URL("$base/_tw/api/me").openConnection() as java.net.HttpURLConnection
    c.connectTimeout = timeout
    c.readTimeout = timeout
    c.responseCode // any answer (401 = not logged in yet) means it's there
    c.disconnect()
    true
  } catch (_: Exception) {
    false
  }

  private fun sleep(ms: Long): Boolean = try {
    Thread.sleep(ms)
    true
  } catch (_: InterruptedException) {
    false
  }

  private fun run(p: Profile, gen: Int) {
    if (p.isDirect) return direct(p, gen)
    if (p.isEasyTier) return runEasyTier(p, gen)
    var everReady = false
    var retry = 0
    while (wanted && gen == generation) {
      report(gen, if (everReady) TunnelState.Reconnecting("正在重新连接…") else TunnelState.Connecting(0))
      try {
        connect(p, gen, !everReady) { everReady = true; retry = 0 }
      } catch (e: Exception) {
        if (!wanted || gen != generation) return
        android.util.Log.w("tmux-web", "tunnel", e)
        val msg = describe(e)
        if (!everReady) {
          report(gen, TunnelState.Failed(msg))
          wanted = false
          return
        }
        retry++
        val wait = minOf(30, 1 shl minOf(retry, 5))
        report(gen, TunnelState.Reconnecting("连接断开，$wait 秒后重连…"))
        try {
          synchronized(pause) {
            if (!nudged) pause.wait(wait * 1000L)
            nudged = false
          }
        } catch (_: InterruptedException) { return }
      } finally {
        try { server?.close() } catch (_: Exception) {}
        try { client?.disconnect() } catch (_: Exception) {}
      }
    }
  }

  /** Connects, logs in, forwards until the connection breaks (then throws). */
  private fun connect(p: Profile, gen: Int, first: Boolean, onReady: () -> Unit) {
    if (portInUse(p.localPort)) throw IllegalStateException("本地端口 ${p.localPort} 已被占用，换一个本地端口试试。")
    // keep-alives that expect an answer: a connection that died without a word (network switched,
    // the phone slept, a NAT forgot it) is noticed within ~40 s and replaced. The default kind only
    // sends and never notices; and it has to be on before connect() or it never starts.
    val ssh = SSHClient(DefaultConfig().apply { keepAliveProvider = KeepAliveProvider.KEEP_ALIVE })
    client = ssh
    ssh.connection.keepAlive.keepAliveInterval = 10
    (ssh.connection.keepAlive as? KeepAliveRunner)?.maxAliveCount = 3
    ssh.addHostKeyVerifier(Verifier(KnownHosts(context)))
    ssh.connectTimeout = 15000
    ssh.timeout = 30000
    ssh.connect(p.host, p.sshPort)

    // a key and/or a password, and whatever the server asks (verification codes): ssh lets a
    // server want several in turn (key first, then a code)
    val methods = mutableListOf<AuthMethod>()
    if (p.privateKey.isNotBlank()) {
      val finder = if (p.keyPassphrase.isNotEmpty()) PasswordUtils.createOneOff(p.keyPassphrase.toCharArray()) else null
      methods += AuthPublickey(ssh.loadKeys(p.privateKey.trim() + "\n", null, finder))
    }
    var passwordUsed = false
    methods += AuthKeyboardInteractive(object : ChallengeResponseProvider {
      override fun getSubmethods() = emptyList<String>()
      override fun init(resource: Resource<*>?, name: String?, instruction: String?) {}
      override fun getResponse(prompt: String, echo: Boolean): CharArray {
        // the saved password answers the first password question; codes and the rest are asked
        if (!passwordUsed && p.password.isNotEmpty() && prompt.contains("assword", ignoreCase = true)) {
          passwordUsed = true
          return p.password.toCharArray()
        }
        return (asker.ask(prompt.trim(), !echo) ?: throw IllegalStateException("已取消")).toCharArray()
      }
      override fun shouldRetry() = false
    })
    methods += AuthPassword(object : PasswordFinder {
      override fun reqPassword(resource: Resource<*>?): CharArray =
        (p.password.ifEmpty { null } ?: asker.ask("${p.target} 的密码", true) ?: throw IllegalStateException("已取消")).toCharArray()
      override fun shouldRetry(resource: Resource<*>?) = false
    })
    ssh.auth(p.user, methods)
    // logged in: the forward next (a reconnect stays "reconnecting")
    if (first) report(gen, TunnelState.Connecting(1))

    val ss = ServerSocket()
    ss.reuseAddress = true
    ss.bind(InetSocketAddress("127.0.0.1", p.localPort))
    server = ss
    report(gen, TunnelState.Ready("http://127.0.0.1:${p.localPort}"))
    onReady()
    // blocks while the forward runs; a broken connection ends it
    val fwd = ssh.newLocalPortForwarder(Parameters("127.0.0.1", p.localPort, p.remoteHost, p.remotePort), ss)
    // the connection gone: end listen() with the forwarder's close(), which also interrupts it.
    // Closing just the socket isn't enough: sshj's listen() then spins on accept() forever, the
    // forward looks up but nothing gets through (and the phone runs hot).
    val watcher = Thread {
      while (wanted && ssh.isConnected) try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
      try { fwd.close() } catch (_: Exception) {}
    }.apply { isDaemon = true; start() }
    try {
      fwd.listen()
    } finally {
      watcher.interrupt()
      try { ss.close() } catch (_: Exception) {}
      // close() interrupted this thread: clear it, or the wait before reconnecting would end the loop
      if (wanted) Thread.interrupted()
    }
    if (wanted) throw IllegalStateException("连接断开")
  }

  /** Waiting to reconnect: do it now (the network is back, the app was opened). */
  fun nudge() {
    synchronized(pause) {
      nudged = true
      pause.notifyAll()
    }
  }

  /**
   * Something suggests the connection may be gone (the network changed, the app came back, the page
   * didn't load): ask the server right away instead of waiting for the keep-alives, and replace the
   * connection if it doesn't answer within a few seconds.
   */
  fun check() {
    if (state is TunnelState.Reconnecting) return nudge()
    val easy = profile?.takeIf { it.isEasyTier }
    if (state is TunnelState.Ready && easy != null && !checking) {
      checking = true
      Thread({
        try {
          if (!webAnswers("http://127.0.0.1:${easy.localPort}", 3_000)) {
            // Interrupt the monitor: its finally block stops the instance and the loop reconnects.
            thread?.interrupt()
          }
        } finally {
          checking = false
        }
      }, "check-easytier").apply { isDaemon = true; start() }
      return
    }
    val ssh = client
    if (state !is TunnelState.Ready || ssh == null || checking) return
    checking = true
    Thread({
      try {
        ssh.connection.sendGlobalRequest("keepalive@openssh.com", true, ByteArray(0)).retrieve(5, TimeUnit.SECONDS)
      } catch (e: Exception) {
        // any reply counts (most servers say "unknown request"); only silence or a broken socket don't
        val answered = e.message?.let { it.startsWith("Global request") && it.endsWith("failed") } == true
        if (!answered) {
          android.util.Log.w("tmux-web", "check: no answer, reconnecting", e)
          if (client === ssh) try { ssh.disconnect() } catch (_: Exception) {}
        }
      } finally {
        checking = false
      }
    }, "check").apply { isDaemon = true; start() }
  }

  private fun portInUse(port: Int) = try {
    Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300) }
    true
  } catch (_: Exception) {
    false
  }

  private fun describe(e: Throwable): String {
    // the root cause says the most (sshj wraps it in TransportException)
    var root: Throwable = e
    while (root.cause != null && root.cause !== root) root = root.cause!!
    val m = listOfNotNull(e.message, root.message.takeIf { root !== e }).joinToString("：").ifBlank { root.javaClass.simpleName }
    return when {
      e is java.net.UnknownHostException -> "找不到主机：${e.message}"
      e is java.net.SocketTimeoutException || m.contains("timed out", true) -> "连接超时：服务器连不上（地址、端口或网络）"
      e is java.net.ConnectException -> "连接被拒绝：${m}"
      m.contains("Exhausted available authentication methods", true) -> "登录失败：密钥或密码不对，或者服务器不接受这种登录方式"
      m.contains("Could not verify", true) || m.contains("HOST_KEY", true) -> "服务器的主机密钥变了（可能被冒充）。如果确认是服务器重装，在设置里点「忘记主机密钥」后重试。"
      else -> m
    }
  }

  /** First use: remember the host key. Afterwards: it must be the same. */
  private class Verifier(private val known: KnownHosts) : HostKeyVerifier {
    override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
      val fp = SecurityUtils.getFingerprint(key)
      val seen = known.get(hostname, port)
      if (seen == null) known.put(hostname, port, fp)
      return seen == null || seen == fp
    }
    override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
  }
}
