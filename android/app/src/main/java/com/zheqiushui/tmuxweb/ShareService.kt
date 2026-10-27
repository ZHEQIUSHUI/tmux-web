package com.zheqiushui.tmuxweb

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.BindException

data class ShareRunning(
  val port: Int,
  val addresses: List<String>,
  val profileCount: Int,
  val keyCount: Int,
)

/** The one outgoing share. It stays up when the screen closes, until stopped or the app exits. */
object ShareRuntime {
  var running by mutableStateOf<ShareRunning?>(null)
    private set
  var starting by mutableStateOf(false)
    private set

  private var server: ConfigShareServer? = null

  suspend fun start(payload: SharedPayload, password: String, port: Int) {
    if (starting) return
    stop()
    starting = true
    try {
      val sealed = withContext(Dispatchers.Default) { ShareProtocol.seal(payload, password) }
      val next = ConfigShareServer(port, sealed, payload.profiles.size)
      try {
        withContext(Dispatchers.IO) { next.start() }
      } catch (e: BindException) {
        throw ShareException("端口 $port 已被占用，换一个端口")
      } catch (e: Exception) {
        throw ShareException("共享服务启动失败：${e.message ?: e.javaClass.simpleName}", e)
      }
      server = next
      running = ShareRunning(port, localShareAddresses(), payload.profiles.size, payload.keys.size)
    } finally {
      starting = false
    }
  }

  fun stop() {
    try { server?.stop() } catch (_: Exception) {}
    server = null
    running = null
  }
}
