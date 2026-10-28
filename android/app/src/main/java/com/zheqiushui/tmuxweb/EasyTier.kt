package com.zheqiushui.tmuxweb

import android.os.Build
import com.easytier.jni.EasyTierJNI
import java.net.URI

/** The generated no-TUN EasyTier configuration for one server. */
object EasyTierConfig {
  fun problem(p: Profile): String? = problem(
    p.easyTierNetwork, p.easyTierServerIP, p.easyTierPeers, p.remotePort, p.localPort,
  )

  fun problem(network: String, serverIP: String, peers: String, remotePort: Int, localPort: Int): String? {
    if (network.trim().isEmpty()) return "填写 EasyTier 网络名称"
    if (!validIPv4(serverIP)) return "服务器虚拟 IP 要是 IPv4 地址，比如 10.144.144.30"
    if (remotePort !in 1..65535) return "tmux-web 端口在 1–65535 之间"
    if (localPort !in 1..65535) return "本地端口在 1–65535 之间"
    val list = peers(peers)
    if (list.isEmpty()) return "至少填一个 EasyTier 公共节点"
    list.firstOrNull { !validPeer(it) }?.let { return "公共节点格式不对：$it。比如 tcp://public.example.com:11010" }
    return null
  }

  fun peers(from: String): List<String> = from.split(',', '\n', '\r')
    .map { it.trim() }
    .filter { it.isNotEmpty() }

  fun validIPv4(text: String): Boolean {
    val parts = text.trim().split('.')
    if (parts.size != 4) return false
    return parts.all { part ->
      part.isNotEmpty() && part.length <= 3 && part.all(Char::isDigit) && part.toIntOrNull() in 0..255
    }
  }

  fun validPeer(text: String): Boolean = try {
    val u = URI(text.trim())
    !u.scheme.isNullOrBlank() && !u.host.isNullOrBlank() && u.port in 1..65535
  } catch (_: Exception) {
    false
  }

  fun instanceName(p: Profile): String {
    val id = p.id.filter { it.isLetterOrDigit() }.lowercase().take(12).ifEmpty { "profile" }
    return "tmux-web-android-$id"
  }

  /** A complete no-TUN configuration with one local TCP forward. */
  fun make(p: Profile): String {
    val issue = problem(p)
    if (issue != null) throw EasyTierException(issue)
    val serverIP = p.easyTierServerIP.trim()
    val instance = instanceName(p)
    val text = StringBuilder()
      .append("instance_name = ").append(string(instance)).append('\n')
      .append("dhcp = false\n")
      .append("listeners = []\n")
      .append("mapped_listeners = []\n")
      .append("exit_nodes = []\n")
      .append("rpc_portal = \"127.0.0.1:0\"\n\n")
      .append("[network_identity]\n")
      .append("network_name = ").append(string(p.easyTierNetwork.trim())).append('\n')
      .append("network_secret = ").append(string(p.easyTierSecret)).append("\n\n")
    for (peer in peers(p.easyTierPeers)) {
      text.append("[[peer]]\n")
        .append("uri = ").append(string(peer)).append("\n\n")
    }
    text.append("[flags]\n")
      .append("default_protocol = \"tcp\"\n")
      .append("enable_encryption = true\n")
      .append("enable_ipv6 = true\n")
      .append("mtu = 1380\n")
      .append("latency_first = false\n")
      .append("enable_exit_node = false\n")
      .append("no_tun = true\n")
      .append("use_smoltcp = false\n")
      .append("relay_network_whitelist = \"*\"\n")
      .append("disable_p2p = false\n")
      .append("relay_all_peer_rpc = false\n")
      .append("disable_udp_hole_punching = false\n")
      .append("disable_tcp_hole_punching = false\n\n")
      .append("[[port_forward]]\n")
      .append("proto = \"tcp\"\n")
      .append("bind_addr = ").append(string("127.0.0.1:${p.localPort}")).append('\n')
      .append("dst_addr = ").append(string("$serverIP:${p.remotePort}")).append('\n')
    return text.toString()
  }

  /** A TOML basic string; network secrets may contain quotes, backslashes and controls. */
  fun string(value: String): String {
    val out = StringBuilder("\"")
    for (c in value) {
      when (c.code) {
        0x08 -> out.append("\\b")
        0x09 -> out.append("\\t")
        0x0A -> out.append("\\n")
        0x0C -> out.append("\\f")
        0x0D -> out.append("\\r")
        0x22 -> out.append("\\\"")
        0x5C -> out.append("\\\\")
        in 0x00..0x1F, 0x7F -> out.append("\\u").append("%04X".format(c.code))
        else -> out.append(c)
      }
    }
    return out.append('"').toString()
  }
}

class EasyTierException(message: String) : Exception(message)

/** EasyTier logs its full config at info level, including the network secret. */
object EasyTierLog {
  fun redact(text: String, secret: String): String {
    var out = text.lineSequence().joinToString("\n") { line ->
      if (line.contains("network_secret", ignoreCase = true)) "network_secret = \"<已隐藏>\"" else line
    }
    if (secret.isEmpty()) return out
    out = out.replace(EasyTierConfig.string(secret), "\"<已隐藏>\"")
    if (secret.length >= 3) out = out.replace(secret, "<已隐藏>")
    return out
  }
}

/** Loads the bundled JNI once and keeps its single-instance lifecycle on one lock. */
object EasyTierNative {
  private val lock = Any()
  @Volatile private var loaded = false
  @Volatile private var loadError: Throwable? = null

  init {
    try {
      // Referencing the object initializes it and loads both libraries in dependency order.
      EasyTierJNI.hashCode()
      loaded = true
    } catch (t: Throwable) {
      loadError = t
    }
  }

  val isLoaded: Boolean get() = loaded

  fun unavailableMessage(): String {
    val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "未知"
    return if (abi == "arm64-v8a") {
      "安装包里没有 EasyTier 原生库，请安装最新版 APK。"
    } else {
      "这台设备是 $abi，当前安装包内置的 EasyTier 只支持 arm64-v8a 手机。"
    }
  }

  fun start(config: String, secret: String) {
    synchronized(lock) {
      if (!loaded) throw EasyTierException(unavailableMessage())
      try {
        if (EasyTierJNI.parseConfig(config) != 0) {
          throw EasyTierException(redactedError(secret) ?: "EasyTier 配置解析失败")
        }
        val result = try {
          EasyTierJNI.runNetworkInstance(config)
        } catch (t: RuntimeException) {
          // An earlier run in this process may still hold the same instance name. The JNI
          // wrapper throws on failure instead of returning a nonzero result.
          if (t.message?.contains("already exists", ignoreCase = true) != true) throw t
          EasyTierJNI.retainNetworkInstance(emptyArray())
          EasyTierJNI.runNetworkInstance(config)
        }
        if (result != 0) throw EasyTierException(redactedError(secret) ?: "EasyTier 网络启动失败")
      } catch (t: EasyTierException) {
        throw t
      } catch (t: Throwable) {
        val detail = t.message ?: t.javaClass.simpleName
        throw EasyTierException(EasyTierLog.redact(detail, secret))
      }
    }
  }

  /** Stops every EasyTier instance owned by this app process. */
  fun stop() {
    synchronized(lock) {
      if (!loaded) return
      try {
        EasyTierJNI.retainNetworkInstance(emptyArray())
      } catch (_: Throwable) {
        // Stopping is best effort; the service/process going away also ends the instances.
      }
    }
  }

  private fun redactedError(secret: String): String? =
    try { EasyTierJNI.getLastError()?.let { EasyTierLog.redact(it, secret) } } catch (_: Throwable) { null }
}
