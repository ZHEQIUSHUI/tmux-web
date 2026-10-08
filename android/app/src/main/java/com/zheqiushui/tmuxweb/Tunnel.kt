package com.zheqiushui.tmuxweb

import android.content.Context
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

/** Where the forward is; observed by the window and the notification. */
sealed class TunnelState {
  object Idle : TunnelState()
  object Connecting : TunnelState()
  data class Ready(val port: Int) : TunnelState()
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
  private var thread: Thread? = null
  @Volatile var state: TunnelState = TunnelState.Idle
    private set

  private fun report(gen: Int, s: TunnelState) {
    if (gen != generation) return
    state = s
    onState(s)
  }

  companion object {
    init {
      // Android's built-in "BC" is a cut-down one: sshj needs the full BouncyCastle
      Security.removeProvider("BC")
      Security.insertProviderAt(BouncyCastleProvider(), 1)
    }
  }

  fun start(p: Profile) {
    stop()
    wanted = true
    val gen = ++generation
    thread = Thread({ run(p, gen) }, "tunnel").apply { isDaemon = true; start() }
  }

  fun stop() {
    wanted = false
    try { server?.close() } catch (_: Exception) {}
    try { client?.disconnect() } catch (_: Exception) {}
    thread?.interrupt()
    thread = null
    generation++
    state = TunnelState.Idle
    onState(TunnelState.Idle)
  }

  private fun run(p: Profile, gen: Int) {
    var everReady = false
    var retry = 0
    while (wanted && gen == generation) {
      report(gen, if (everReady) TunnelState.Reconnecting("正在重新连接…") else TunnelState.Connecting)
      try {
        connect(p, gen) { everReady = true; retry = 0 }
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
        try { Thread.sleep(wait * 1000L) } catch (_: InterruptedException) { return }
      } finally {
        try { server?.close() } catch (_: Exception) {}
        try { client?.disconnect() } catch (_: Exception) {}
      }
    }
  }

  /** Connects, logs in, forwards until the connection breaks (then throws). */
  private fun connect(p: Profile, gen: Int, onReady: () -> Unit) {
    if (portInUse(p.localPort)) throw IllegalStateException("本地端口 ${p.localPort} 已被占用，换一个本地端口试试。")
    val ssh = SSHClient(DefaultConfig())
    client = ssh
    ssh.addHostKeyVerifier(Verifier(KnownHosts(context)))
    ssh.connectTimeout = 15000
    ssh.connect(p.host, p.sshPort)
    ssh.connection.keepAlive.keepAliveInterval = 15

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

    val ss = ServerSocket()
    ss.reuseAddress = true
    ss.bind(InetSocketAddress("127.0.0.1", p.localPort))
    server = ss
    report(gen, TunnelState.Ready(p.localPort))
    onReady()
    // blocks while the forward runs; a broken connection ends it
    val fwd = ssh.newLocalPortForwarder(Parameters("127.0.0.1", p.localPort, p.remoteHost, p.remotePort), ss)
    val watcher = Thread {
      while (wanted && ssh.isConnected) try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
      try { ss.close() } catch (_: Exception) {}
    }.apply { isDaemon = true; start() }
    try {
      fwd.listen()
    } finally {
      watcher.interrupt()
    }
    if (wanted) throw IllegalStateException("连接断开")
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
