package com.zheqiushui.tmuxweb

import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.Executors

/**
 * Is the server there, and how far away: what the home cards and 测试连接 show. Direct access
 * asks tmux-web itself (any HTTP answer counts, 401 included); SSH only knocks on the SSH port —
 * logging in is left to connecting, it may need a code.
 */
object Probe {
  sealed class Result {
    object Checking : Result()
    data class Up(val ms: Long) : Result()
    data class Down(val why: String) : Result()
  }

  private val pool = Executors.newFixedThreadPool(4) { r -> Thread(r, "probe").apply { isDaemon = true } }

  /** in the background; `done` is called on that thread */
  fun check(p: Profile, done: (Result) -> Unit) {
    pool.execute { done(run(p)) }
  }

  fun run(p: Profile, timeout: Int = 3000): Result {
    val t0 = System.nanoTime()
    return try {
      if (p.isDirect) {
        val base = p.directBase ?: return Result.Down("网址不对")
        val c = URL("$base/_tw/api/me").openConnection() as HttpURLConnection
        c.connectTimeout = timeout
        c.readTimeout = timeout
        c.responseCode
        c.disconnect()
      } else {
        if (p.host.isBlank()) return Result.Down("没填主机")
        Socket().use { it.connect(InetSocketAddress(p.host, p.sshPort), timeout) }
      }
      Result.Up((System.nanoTime() - t0) / 1_000_000)
    } catch (e: java.net.UnknownHostException) {
      Result.Down("找不到主机")
    } catch (e: java.net.SocketTimeoutException) {
      Result.Down("超时")
    } catch (e: java.net.ConnectException) {
      Result.Down("连接被拒绝")
    } catch (e: Exception) {
      Result.Down(e.message ?: e.javaClass.simpleName)
    }
  }
}
