package com.zheqiushui.tmuxweb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Base64

class ConfigShareTest {
  @Test
  fun pbkdf2MatchesTheStandardVector() {
    val key = ShareProtocol.deriveKey("password", "salt".toByteArray(), 4096)
    assertEquals("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a", key.joinToString("") { "%02x".format(it) })
  }

  @Test
  fun opensABundleMadeByTheOtherPlatform() {
    val payload = ShareProtocol.open(NODE_FIXTURE, "test-password")
    assertEquals(1, payload.keys.size)
    assertEquals("k1", payload.keys[0].id)
    assertEquals("key-pass", payload.keys[0].passphrase)
    assertEquals(1, payload.profiles.size)
    assertEquals("noqi@10.0.0.5", payload.profiles[0].target)
    assertEquals("-J jump", payload.profiles[0].extraArgs)
  }

  @Test(expected = ShareException::class)
  fun wrongPasswordDoesNotOpenTheBundle() {
    ShareProtocol.open(NODE_FIXTURE, "wrong-password")
  }

  @Test
  fun keyFingerprintIgnoresLineEndingsAndNames() {
    val a = "-----BEGIN KEY-----\r\nabc  \r\n-----END KEY-----\r\n\r\n"
    val b = "\n-----BEGIN KEY-----\nabc\n-----END KEY-----"
    assertEquals(ShareIdentity.keyFingerprint(a), ShareIdentity.keyFingerprint(b))
  }

  @Test
  fun profileIdentityMatchesEveryCredential() {
    val key = "-----BEGIN KEY-----\nabc\n-----END KEY-----"
    val a = SharedProfile("name", "ssh", "", "noqi@Host", 22, "127.0.0.1", 8080, "k", "pw")
    val same = a.copy(name = "另一个名字")
    val otherPassword = a.copy(password = "other")
    val otherKey = a.copy(keyId = "other")
    assertEquals(ShareIdentity.profileIdentity(a, key), ShareIdentity.profileIdentity(same, key))
    assertNotEquals(ShareIdentity.profileIdentity(a, key), ShareIdentity.profileIdentity(otherPassword, key))
    assertNotEquals(ShareIdentity.profileIdentity(a, key), ShareIdentity.profileIdentity(otherKey, "another key"))
  }

  @Test
  fun directUrlIgnoresDefaultPortAndTrailingSlash() {
    assertEquals(ShareIdentity.directIdentity("HTTP://Example.com:80/tmux/"), ShareIdentity.directIdentity("example.com/tmux"))
  }

  @Test
  fun serverOnlyReturnsTheEnvelopeAfterThePassword() {
    val port = ServerSocket(0).use { it.localPort }
    val salt = ByteArray(16) { it.toByte() }
    val key = ShareProtocol.deriveKey("test-password", salt, 120_000)
    val sealed = ShareProtocol.Sealed("{\"ok\":true}", salt, 120_000, ShareProtocol.authCode(key))
    val server = ConfigShareServer(port, sealed, 1)
    server.start()
    try {
      val c = URL("http://127.0.0.1:$port/api/bundle").openConnection() as HttpURLConnection
      c.setRequestProperty("X-Share-Password-B64", Base64.getEncoder().encodeToString("test-password".toByteArray(StandardCharsets.UTF_8)))
      assertEquals(200, c.responseCode)
      assertEquals("{\"ok\":true}", c.inputStream.bufferedReader().readText())
      c.disconnect()
    } finally {
      server.stop()
    }
  }

  private companion object {
    const val NODE_FIXTURE = "{\"format\":\"tmux-web-config-share\",\"version\":1,\"kdf\":{\"algorithm\":\"PBKDF2-HMAC-SHA256\",\"iterations\":120000,\"salt\":\"AAECAwQFBgcICQoLDA0ODw==\"},\"cipher\":{\"algorithm\":\"AES-256-GCM\",\"nonce\":\"EBESExQVFhcYGRob\"},\"payload\":\"F+uGjJMAiKhnh9iHLH3vLUnseIFkhaBhJCXEyrNdD/Nifr4jaPT6gOVaK894YxVh6/K3I5RY8mttjGc+GWSENglcVTydx/f/CwOE93Kf0bGlPtezCa398CE9SpQWGPZ9Yb+AQmhzZ9ISFDSx04QHS4pOx2upvjh84+zwRaxu6D/mLQu0EqGI2iJ9HCYRwFJ8fwVgZ+3pVEoNpuZfRNzNefA2CsnYM7lNok/cpWF+9BhpDqdXj5oqxIqBwCXqZAT5QaxTpCGXqPNTxTwO78UsvMRPBfUS4KjJsz57UGrp17Sy5s4dgnJXJaXeEvr8gyLvfo/WSsVDf7v6BWxGbLdHB/VyuIgxYRiL0ENgsKIi1EhfsagoXmLwwyylDi01sP2TQ8u3dzclSHfMcM6tW0bYtYF3MdGcnxar4dKLHjDIwOYizZs5onK1FXjZxunESeaHBc+r+1BZk07FCZ/DaHIKq+wuKhrxj2SemeD1Fgh+ILU9nX1uDWQgwFYuk+BBUePTvQJCnfipyxYTfyxcgylBLA8JHE9XVSR+rc8VMWOzHLUeVcuCLuw8Q8u640UKwzFfBkjv/3rdrgdwYMvmhFcM2RdO79dock/be6Y/wpzQcTFBmYhH0fop2fnXOXWpZMaz\"}"
  }
}
