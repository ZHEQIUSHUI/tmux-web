package com.zheqiushui.tmuxweb

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

/** A private key as it travels between devices: its text, not the local key-list id. */
data class SharedKey(
  val id: String,
  val name: String,
  val privateKey: String,
  val passphrase: String = "",
)

/** A server as it travels between devices: local ports and local ids are assigned on import. */
data class SharedProfile(
  val name: String,
  val mode: String,
  val directUrl: String,
  val target: String,
  val sshPort: Int,
  val remoteHost: String,
  val remotePort: Int,
  val keyId: String,
  val password: String,
  val extraArgs: String = "",
  /** 内置 EasyTier（两端共用） */
  val easyTierNetwork: String = "",
  val easyTierSecret: String = "",
  val easyTierPeers: String = "",
  val easyTierServerIP: String = "",
)

data class SharedPayload(
  val keys: List<SharedKey>,
  val profiles: List<SharedProfile>,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("format", ShareProtocol.FORMAT)
    put("version", ShareProtocol.VERSION)
    put("exportedAt", System.currentTimeMillis())
    put("sender", "tmux-web Android")
    put("keys", JSONArray().apply {
      keys.forEach { k ->
        put(JSONObject().apply {
          put("id", k.id)
          put("name", k.name)
          put("privateKey", k.privateKey)
          put("passphrase", k.passphrase)
        })
      }
    })
    put("profiles", JSONArray().apply {
      profiles.forEach { p ->
        put(JSONObject().apply {
          put("name", p.name)
          put("mode", p.mode)
          put("directUrl", p.directUrl)
          put("target", p.target)
          put("sshPort", p.sshPort)
          put("remoteHost", p.remoteHost)
          put("remotePort", p.remotePort)
          put("keyId", p.keyId)
          put("password", p.password)
          put("extraArgs", p.extraArgs)
          put("easyTierNetwork", p.easyTierNetwork)
          put("easyTierSecret", p.easyTierSecret)
          put("easyTierPeers", p.easyTierPeers)
          put("easyTierServerIP", p.easyTierServerIP)
        })
      }
    })
  }

  companion object {
    fun fromJson(o: JSONObject): SharedPayload {
      if (o.optString("format") != ShareProtocol.FORMAT || o.optInt("version", 0) != ShareProtocol.VERSION) {
        throw ShareException("这不是受支持的 tmux-web 共享配置")
      }
      val keys = o.optJSONArray("keys") ?: JSONArray()
      val profiles = o.optJSONArray("profiles") ?: JSONArray()
      return SharedPayload(
        keys = (0 until keys.length()).map { i ->
          val k = keys.getJSONObject(i)
          SharedKey(
            id = k.optString("id").ifBlank { UUID.randomUUID().toString() },
            name = k.optString("name"),
            privateKey = k.optString("privateKey"),
            passphrase = k.optString("passphrase"),
          )
        },
        profiles = (0 until profiles.length()).map { i ->
          val p = profiles.getJSONObject(i)
          SharedProfile(
            name = p.optString("name"),
            mode = p.optString("mode", "ssh"),
            directUrl = p.optString("directUrl"),
            target = p.optString("target"),
            sshPort = p.optInt("sshPort", 22),
            remoteHost = p.optString("remoteHost", "127.0.0.1"),
            remotePort = p.optInt("remotePort", 8080),
            keyId = p.optString("keyId"),
            password = p.optString("password"),
            extraArgs = p.optString("extraArgs"),
            easyTierNetwork = p.optString("easyTierNetwork"),
            easyTierSecret = p.optString("easyTierSecret"),
            easyTierPeers = p.optString("easyTierPeers"),
            easyTierServerIP = p.optString("easyTierServerIP"),
          )
        },
      )
    }
  }
}

class ShareException(message: String, cause: Throwable? = null) : Exception(message, cause)

object ShareProtocol {
  const val FORMAT = "tmux-web-config-share"
  const val VERSION = 1
  const val ITERATIONS = 120_000
  const val DEFAULT_PORT = 48620
  const val MIN_PASSWORD = 6
  val AAD = "tmux-web-config-share:v1".toByteArray(StandardCharsets.UTF_8)
  private val AUTH_LABEL = "tmux-web-config-share-auth-v1".toByteArray(StandardCharsets.UTF_8)
  private const val MAX_ENVELOPE = 8 * 1024 * 1024

  private val random = SecureRandom()
  private val encoder = Base64.getEncoder()
  private val decoder = Base64.getDecoder()

  data class Sealed(
    val envelopeJson: String,
    val salt: ByteArray,
    val iterations: Int,
    val authCode: ByteArray,
  )

  private data class Envelope(
    val salt: ByteArray,
    val iterations: Int,
    val nonce: ByteArray,
    val ciphertext: ByteArray,
  )

  fun seal(payload: SharedPayload, password: String): Sealed {
    checkPassword(password)
    val salt = ByteArray(16).also(random::nextBytes)
    val nonce = ByteArray(12).also(random::nextBytes)
    val key = deriveKey(password, salt, ITERATIONS)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
      updateAAD(AAD)
    }
    val encrypted = cipher.doFinal(payload.toJson().toString().toByteArray(StandardCharsets.UTF_8))
    val envelope = JSONObject().apply {
      put("format", FORMAT)
      put("version", VERSION)
      put("kdf", JSONObject().apply {
        put("algorithm", "PBKDF2-HMAC-SHA256")
        put("iterations", ITERATIONS)
        put("salt", encoder.encodeToString(salt))
      })
      put("cipher", JSONObject().apply {
        put("algorithm", "AES-256-GCM")
        put("nonce", encoder.encodeToString(nonce))
      })
      put("payload", encoder.encodeToString(encrypted))
    }.toString()
    return Sealed(envelope, salt, ITERATIONS, authCode(key))
  }

  fun open(envelopeJson: String, password: String): SharedPayload {
    if (envelopeJson.toByteArray(StandardCharsets.UTF_8).size > MAX_ENVELOPE) throw ShareException("共享配置太大")
    val envelope = parseEnvelope(envelopeJson)
    val key = deriveKey(password, envelope.salt, envelope.iterations)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, envelope.nonce))
      updateAAD(AAD)
    }
    val plain = try {
      cipher.doFinal(envelope.ciphertext)
    } catch (e: Exception) {
      throw ShareException("密码不对，或者共享内容已损坏", e)
    }
    return try {
      SharedPayload.fromJson(JSONObject(String(plain, StandardCharsets.UTF_8)))
    } catch (e: ShareException) {
      throw e
    } catch (e: Exception) {
      throw ShareException("共享内容格式不对", e)
    }
  }

  fun verify(password: String, salt: ByteArray, iterations: Int, expected: ByteArray): Boolean =
    MessageDigest.isEqual(authCode(deriveKey(password, salt, iterations)), expected)

  fun authCode(key: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
    init(SecretKeySpec(key, "HmacSHA256"))
    doFinal(AUTH_LABEL)
  }

  fun checkPassword(password: String) {
    if (password.length < MIN_PASSWORD) throw ShareException("密码至少 $MIN_PASSWORD 位")
  }

  private fun parseEnvelope(json: String): Envelope {
    val o = try { JSONObject(json) } catch (e: Exception) { throw ShareException("共享配置格式不对", e) }
    if (o.optString("format") != FORMAT || o.optInt("version", 0) != VERSION) throw ShareException("这不是受支持的 tmux-web 共享配置")
    val kdf = o.optJSONObject("kdf") ?: throw ShareException("共享配置缺少密钥参数")
    if (kdf.optString("algorithm") != "PBKDF2-HMAC-SHA256") throw ShareException("不支持的密钥算法")
    val iterations = kdf.optInt("iterations", 0)
    if (iterations !in 10_000..600_000) throw ShareException("共享配置的密钥参数不对")
    val cipher = o.optJSONObject("cipher") ?: throw ShareException("共享配置缺少加密参数")
    if (cipher.optString("algorithm") != "AES-256-GCM") throw ShareException("不支持的加密算法")
    val salt = decode(kdf.optString("salt"), 16, 64, "盐")
    val nonce = decode(cipher.optString("nonce"), 12, 12, "随机数")
    val encrypted = decode(o.optString("payload"), 16, MAX_ENVELOPE, "加密内容")
    return Envelope(salt, iterations, nonce, encrypted)
  }

  private fun decode(text: String, min: Int, max: Int, what: String): ByteArray {
    val bytes = try { decoder.decode(text) } catch (e: Exception) { throw ShareException("共享配置的${what}不对", e) }
    if (bytes.size !in min..max) throw ShareException("共享配置的${what}不对")
    return bytes
  }

  /**
   * PBKDF2-HMAC-SHA256 with the password's UTF-8 bytes. Written out instead of using the platform's
   * PBEKeySpec so Android and macOS produce exactly the same bytes for every password.
   */
  fun deriveKey(password: String, salt: ByteArray, iterations: Int, length: Int = 32): ByteArray {
    val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(password.toByteArray(StandardCharsets.UTF_8), "HmacSHA256")) }
    val blocks = (length + mac.macLength - 1) / mac.macLength
    val out = ByteArray(blocks * mac.macLength)
    for (block in 1..blocks) {
      mac.update(salt)
      mac.update(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
      var u = mac.doFinal()
      val acc = u.copyOf()
      repeat(iterations - 1) {
        u = mac.doFinal(u)
        for (i in acc.indices) acc[i] = (acc[i].toInt() xor u[i].toInt()).toByte()
      }
      System.arraycopy(acc, 0, out, (block - 1) * mac.macLength, acc.size)
    }
    return out.copyOf(length)
  }
}

/** What makes two servers the same configuration. */
object ShareIdentity {
  /** CRLF/CR → LF, trailing spaces removed, blank lines at both ends dropped. */
  fun canonicalKey(text: String): String {
    val lines = text.replace("\r\n", "\n").replace('\r', '\n').lineSequence().map { it.trimEnd(' ', '\t') }.toList()
    return lines.dropWhile { it.isEmpty() }.dropLastWhile { it.isEmpty() }.joinToString("\n")
  }

  fun keyFingerprint(text: String): String = sha256(canonicalKey(text).toByteArray(StandardCharsets.UTF_8))

  fun directIdentity(url: String): String {
    var s = url.trim()
    if (s.isEmpty()) return ""
    if (!s.contains("://")) s = "http://$s"
    return try {
      val u = URI(s)
      val scheme = u.scheme?.lowercase() ?: return s.lowercase()
      val host = u.host?.lowercase() ?: return s
      val defaultPort = if (scheme == "https") 443 else 80
      val port = if (u.port == -1 || u.port == defaultPort) "" else ":${u.port}"
      val path = (u.rawPath ?: "").trimEnd('/')
      val query = u.rawQuery?.let { "?$it" } ?: ""
      val user = u.rawUserInfo?.let { "$it@" } ?: ""
      "$scheme://$user$host$port$path$query"
    } catch (_: Exception) {
      s.lowercase()
    }
  }

  fun profileIdentity(p: Profile, keyText: String?): String =
    if (p.isDirect) "direct|${directIdentity(p.directUrl)}"
    else if (p.isEasyTier) easyTierIdentity(p.easyTierNetwork, p.easyTierSecret, p.easyTierPeers, p.easyTierServerIP, p.remotePort)
    else sshIdentity(p.target, p.sshPort, p.remoteHost, p.remotePort, p.password, keyText, "")

  fun profileIdentity(p: SharedProfile, keyText: String?): String =
    if (p.mode == "direct") "direct|${directIdentity(p.directUrl)}"
    else if (p.mode == "easytier") easyTierIdentity(p.easyTierNetwork, p.easyTierSecret, p.easyTierPeers, p.easyTierServerIP, p.remotePort)
    else sshIdentity(p.target, p.sshPort, p.remoteHost, p.remotePort, p.password, keyText, p.extraArgs)

  private fun easyTierIdentity(network: String, secret: String, peers: String, serverIP: String, remotePort: Int): String {
    val nodes = EasyTierConfig.peers(peers).map { it.lowercase() }.sorted()
    return listOf("easytier", network.trim(), secret, nodes.joinToString(","), serverIP.trim(), remotePort.toString())
      .joinToString("\u0000")
  }

  private fun sshIdentity(target: String, sshPort: Int, remoteHost: String, remotePort: Int, password: String, key: String?, extraArgs: String): String {
    val t = target.trim()
    val at = t.lastIndexOf('@')
    val user = if (at >= 0) t.substring(0, at) else ""
    val host = (if (at >= 0) t.substring(at + 1) else t).lowercase()
    val keyFp = key?.takeIf { it.isNotBlank() }?.let(::keyFingerprint) ?: ""
    val args = extraArgs.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    return listOf("ssh", user, host, sshPort.toString(), remoteHost.trim().lowercase(), remotePort.toString(), password, keyFp, args)
      .joinToString("\u0000")
  }

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

/** The selected profiles and keys, without local ports, ids or timestamps. */
object SharePayloadBuilder {
  fun build(profiles: List<Profile>, keys: List<SshKey>, selectedProfiles: Set<String>, selectedKeys: Set<String>): SharedPayload {
    val selectedKeyList = keys.filter { it.id in selectedKeys }
    val includedKeyIds = selectedKeyList.map { it.id }.toSet()
    return SharedPayload(
      keys = selectedKeyList.map { k ->
        SharedKey(id = k.id, name = k.name, privateKey = k.privateKey, passphrase = k.passphrase)
      },
      profiles = profiles.filter { it.id in selectedProfiles }.map { p ->
        SharedProfile(
          name = p.name,
          mode = p.mode,
          directUrl = p.directUrl,
          target = p.target,
          sshPort = p.sshPort,
          remoteHost = p.remoteHost,
          remotePort = p.remotePort,
          keyId = p.keyId.takeIf { p.mode == "ssh" && it in includedKeyIds } ?: "",
          password = if (p.mode == "ssh") p.password else "",
          easyTierNetwork = p.easyTierNetwork,
          easyTierSecret = p.easyTierSecret,
          easyTierPeers = p.easyTierPeers,
          easyTierServerIP = p.easyTierServerIP,
        )
      },
    )
  }
}

data class ShareImportSummary(
  val profilesAdded: Int,
  val profilesSkipped: Int,
  val keysAdded: Int,
  val keysReused: Int,
  val profilesUnsupported: Int = 0,
) {
  val text: String
    get() = buildString {
      append("新增 ${profilesAdded} 个服务器")
      if (profilesSkipped > 0) append("，跳过 ${profilesSkipped} 个重复配置")
      if (profilesUnsupported > 0) append("，跳过 ${profilesUnsupported} 个不支持或填写不完整的配置")
      if (keysAdded > 0) append("；新增 ${keysAdded} 把私钥")
      if (keysReused > 0) append("；复用 ${keysReused} 把已有私钥")
    }
}

fun ProfileStore.importShared(payload: SharedPayload): ShareImportSummary {
  val nextKeys = keys.toMutableList()
  val nextProfiles = profiles.toMutableList()
  val keyByFingerprint = HashMap<String, String>()
  for (k in nextKeys) {
    if (k.privateKey.isNotBlank()) keyByFingerprint[ShareIdentity.keyFingerprint(k.privateKey)] = k.id
  }
  val portableKeyIds = HashMap<String, String>()
  var keysAdded = 0
  var keysReused = 0
  for (shared in payload.keys) {
    if (shared.privateKey.isBlank()) continue
    val fingerprint = ShareIdentity.keyFingerprint(shared.privateKey)
    val existing = keyByFingerprint[fingerprint]
    if (existing != null) {
      portableKeyIds[shared.id] = existing
      keysReused++
    } else {
      val k = SshKey(
        id = UUID.randomUUID().toString(),
        name = shared.name.ifBlank { "共享私钥" },
        privateKey = shared.privateKey,
        passphrase = shared.passphrase,
      )
      nextKeys += k
      keyByFingerprint[fingerprint] = k.id
      portableKeyIds[shared.id] = k.id
      keysAdded++
    }
  }

  val identities = HashSet<String>()
  for (p in nextProfiles) identities += ShareIdentity.profileIdentity(p, key(p.keyId)?.privateKey)
  val usedPorts = nextProfiles.filter { !it.isDirect }.map { it.localPort }.toMutableSet()
  var profilesAdded = 0
  var profilesSkipped = 0
  var profilesUnsupported = 0
  for (p in payload.profiles) {
    if (p.mode !in setOf("direct", "ssh", "easytier")) {
      profilesUnsupported++
      continue
    }
    if (p.mode == "easytier" && EasyTierConfig.problem(p.easyTierNetwork, p.easyTierServerIP, p.easyTierPeers, p.remotePort, 18080) != null) {
      profilesUnsupported++
      continue
    }
    val keyId = if (p.mode != "ssh" || p.keyId.isEmpty()) "" else portableKeyIds[p.keyId] ?: ""
    val keyText = nextKeys.firstOrNull { it.id == keyId }?.privateKey
    val identity = ShareIdentity.profileIdentity(p, keyText)
    if (identity in identities) {
      profilesSkipped++
      continue
    }
    var localPort = 18080
    if (p.mode != "direct") while (localPort in usedPorts) localPort++
    val imported = Profile(
      id = UUID.randomUUID().toString(),
      name = p.name,
      mode = p.mode,
      directUrl = p.directUrl,
      target = p.target,
      sshPort = p.sshPort,
      remoteHost = p.remoteHost,
      remotePort = p.remotePort,
      localPort = if (p.mode == "direct") 18080 else localPort,
      easyTierNetwork = p.easyTierNetwork,
      easyTierSecret = p.easyTierSecret,
      easyTierPeers = p.easyTierPeers,
      easyTierServerIP = p.easyTierServerIP,
      keyId = keyId,
      password = if (p.mode == "ssh") p.password else "",
      lastUsed = 0,
    )
    nextProfiles += imported
    if (p.mode != "direct") usedPorts += localPort
    identities += identity
    profilesAdded++
  }

  if (profilesAdded > 0 || keysAdded > 0) {
    upsertImported(nextKeys, nextProfiles)
  }
  return ShareImportSummary(profilesAdded, profilesSkipped, keysAdded, keysReused, profilesUnsupported)
}

/** What the share server answers: metadata for clients, and the one encrypted bundle. */
class ConfigShareServer(
  val port: Int,
  private val sealed: ShareProtocol.Sealed,
  private val profileCount: Int,
) {
  private val socket = ServerSocket()
  private val failed = ConcurrentHashMap<String, Attempt>()
  @Volatile private var running = true

  private data class Attempt(var count: Int = 0, var until: Long = 0)

  fun start() {
    socket.reuseAddress = true
    socket.bind(InetSocketAddress("0.0.0.0", port))
    thread(name = "config-share", isDaemon = true) {
      while (running) {
        val client = try { socket.accept() } catch (_: Exception) { break }
        thread(name = "config-share-client", isDaemon = true) { client.use(::handle) }
      }
    }
  }

  fun stop() {
    running = false
    try { socket.close() } catch (_: Exception) {}
  }

  private fun handle(socket: Socket) {
    socket.soTimeout = 10_000
    val input = BufferedInputStream(socket.getInputStream())
    val request = readRequest(input) ?: return respond(socket, 400, "text/plain; charset=utf-8", "请求不完整")
    val ip = socket.inetAddress.hostAddress ?: "?"
    when {
      request.method == "GET" && (request.path == "/" || request.path == "/index.html") ->
        respond(socket, 200, "text/html; charset=utf-8", page())
      request.method == "GET" && request.path == "/api/info" ->
        respond(socket, 200, "application/json; charset=utf-8", JSONObject().apply {
          put("format", ShareProtocol.FORMAT); put("version", ShareProtocol.VERSION); put("service", "tmux-web")
        }.toString())
      request.method == "GET" && request.path == "/api/bundle" -> {
        val password = request.headers["x-share-password-b64"]?.let {
          try { String(Base64.getDecoder().decode(it), StandardCharsets.UTF_8) } catch (_: Exception) { null }
        }
        if (password == null) return respond(socket, 401, "application/json; charset=utf-8", errorJson("需要密码"))
        authenticated(ip) { password }?.let { respond(socket, 200, "application/json; charset=utf-8", it) }
          ?: respond(socket, if (blocked(ip)) 429 else 401, "application/json; charset=utf-8", errorJson(if (blocked(ip)) "尝试次数太多，请稍后再试" else "密码不对"))
      }
      request.method == "POST" && request.path == "/download" -> {
        val password = formValue(request.body, "password")
        if (password == null) return respond(socket, 400, "application/json; charset=utf-8", errorJson("需要密码"))
        authenticated(ip) { password }?.let {
          respond(socket, 200, "application/json; charset=utf-8", it, mapOf("Content-Disposition" to "attachment; filename=\"tmux-web-config-share.json\""))
        } ?: respond(socket, if (blocked(ip)) 429 else 401, "application/json; charset=utf-8", errorJson(if (blocked(ip)) "尝试次数太多，请稍后再试" else "密码不对"))
      }
      else -> respond(socket, 404, "text/plain; charset=utf-8", "没有这个页面")
    }
  }

  /** nil = password wrong or this address is blocked. */
  private fun authenticated(ip: String, password: () -> String): String? {
    if (blocked(ip)) return null
    val ok = try {
      ShareProtocol.verify(password(), sealed.salt, sealed.iterations, sealed.authCode)
    } catch (_: Exception) {
      false
    }
    if (!ok) {
      recordFailure(ip)
      return null
    }
    failed.remove(ip)
    return sealed.envelopeJson
  }

  private fun blocked(ip: String): Boolean = synchronized(failed) { (failed[ip]?.until ?: 0) > System.currentTimeMillis() }

  private fun recordFailure(ip: String) = synchronized(failed) {
    val a = failed[ip] ?: Attempt()
    a.count++
    if (a.count >= 5) {
      a.until = System.currentTimeMillis() + 60_000
      a.count = 0
    }
    failed[ip] = a
  }

  private data class Request(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
  )

  private fun readRequest(input: InputStream): Request? {
    val headerBytes = ByteArrayOutputStream()
    var matched = 0
    val end = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
    while (headerBytes.size() < 32 * 1024) {
      val b = input.read()
      if (b < 0) return null
      headerBytes.write(b)
      matched = if (b.toByte() == end[matched]) matched + 1 else if (b.toByte() == end[0]) 1 else 0
      if (matched == end.size) break
    }
    if (matched != end.size) return null
    val lines = String(headerBytes.toByteArray(), StandardCharsets.ISO_8859_1).removeSuffix("\r\n\r\n").split("\r\n")
    val first = lines.firstOrNull()?.split(' ') ?: return null
    if (first.size < 2) return null
    val headers = lines.drop(1).mapNotNull { line ->
      val i = line.indexOf(':')
      if (i <= 0) null else line.substring(0, i).trim().lowercase() to line.substring(i + 1).trim()
    }.toMap()
    val length = headers["content-length"]?.toIntOrNull() ?: 0
    if (length !in 0..16 * 1024) return null
    val body = ByteArray(length)
    var read = 0
    while (read < length) {
      val n = input.read(body, read, length - read)
      if (n <= 0) return null
      read += n
    }
    return Request(first[0].uppercase(), first[1].substringBefore('?'), headers, body)
  }

  private fun formValue(body: ByteArray, name: String): String? = try {
    String(body, StandardCharsets.UTF_8).split('&').firstOrNull { it.substringBefore('=') == name }?.substringAfter('=', "")
      ?.let { URLDecoder.decode(it, "UTF-8") }
  } catch (_: Exception) {
    null
  }

  private fun respond(socket: Socket, code: Int, type: String, body: String, extra: Map<String, String> = emptyMap()) {
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    val reason = when (code) { 200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"; 429 -> "Too Many Requests"; else -> "Error" }
    val head = StringBuilder("HTTP/1.1 $code $reason\r\n")
      .append("Content-Type: $type\r\n")
      .append("Content-Length: ${bytes.size}\r\n")
      .append("Cache-Control: no-store\r\n")
      .append("Connection: close\r\n")
    extra.forEach { (k, v) -> head.append("$k: $v\r\n") }
    head.append("\r\n")
    try {
      socket.getOutputStream().use { out ->
        out.write(head.toString().toByteArray(StandardCharsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
      }
    } catch (_: Exception) {}
  }

  private fun errorJson(message: String) = JSONObject().put("error", message).toString()

  private fun page(): String = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tmux-web 共享配置</title>
<style>body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#202124}code{background:#f1f3f4;padding:2px 5px;border-radius:4px}input,button{font:inherit;padding:10px}input{width:100%;box-sizing:border-box;margin:8px 0 14px;border:1px solid #bbb;border-radius:8px}button{border:0;border-radius:8px;background:#2f6fde;color:#fff;padding:11px 20px}.note{color:#5f6368;font-size:14px}</style></head>
<body><h2>tmux-web 共享配置</h2>
<p>这台设备正在共享 <b>$profileCount</b> 个服务器配置。请在另一台设备打开 tmux-web App，进入「共享配置 → 接收」，填入本页地址、端口和密码。</p>
<p class="note">也可以在下面输入密码下载加密的共享文件。文件里的私钥和密码只有密码正确时才能解开。</p>
<form method="post" action="/download"><label for="password">访问密码</label><input id="password" name="password" type="password" required><button type="submit">下载加密配置</button></form>
<p class="note">只在你信任的局域网里使用。关闭共享后这个页面就不能访问了。</p></body></html>"""
}

object ShareClient {
  private const val MAX_RESPONSE = 8 * 1024 * 1024

  /** A scanned link: the sender's addresses in turn, the first one that answers. */
  fun fetch(link: ShareLink): SharedPayload {
    var last: ShareException? = null
    for (h in link.hosts) {
      try {
        return fetch(h, link.port, link.password, if (link.hosts.size > 1) 3_000 else 8_000)
      } catch (e: ShareException) {
        // a wrong password or a refusal: the same from every address
        if (e.cause == null) throw e
        last = e
      }
    }
    throw last ?: ShareException("二维码里没有地址")
  }

  fun fetch(hostInput: String, port: Int, password: String, connectTimeout: Int = 8_000): SharedPayload {
    ShareProtocol.checkPassword(password)
    val (host, actualPort) = parseHost(hostInput, port)
    val url = java.net.URL("http://$host:$actualPort/api/bundle")
    val c = url.openConnection() as java.net.HttpURLConnection
    c.connectTimeout = connectTimeout
    c.readTimeout = 12_000
    c.instanceFollowRedirects = false
    c.setRequestProperty("X-Share-Password-B64", Base64.getEncoder().encodeToString(password.toByteArray(StandardCharsets.UTF_8)))
    c.setRequestProperty("Accept", "application/json")
    try {
      val code = c.responseCode
      val body = readLimited(if (code in 200..299) c.inputStream else c.errorStream)
      if (code == 401) throw ShareException("密码不对")
      if (code == 429) throw ShareException("尝试次数太多，请等一分钟再试")
      if (code !in 200..299) throw ShareException("对方拒绝连接（HTTP $code）")
      return ShareProtocol.open(String(body, StandardCharsets.UTF_8), password)
    } catch (e: ShareException) {
      throw e
    } catch (e: Exception) {
      throw ShareException("连不上 $host:$actualPort：${e.message ?: e.javaClass.simpleName}", e)
    } finally {
      c.disconnect()
    }
  }

  fun parseHost(input: String, fallbackPort: Int): Pair<String, Int> {
    var s = input.trim()
    if (s.isEmpty()) throw ShareException("填上对方的 IP 地址")
    if (s.contains("://")) {
      val u = try { URI(s) } catch (e: Exception) { throw ShareException("地址不对") }
      if (u.host.isNullOrBlank()) throw ShareException("地址不对")
      return u.host to (if (u.port > 0) u.port else fallbackPort)
    }
    s = s.substringBefore('/')
    if (s.count { it == ':' } == 1) {
      val h = s.substringBefore(':')
      val p = s.substringAfter(':').toIntOrNull()
      if (h.isNotBlank() && p != null) return h to p
    }
    return s to fallbackPort
  }

  private fun readLimited(input: InputStream?): ByteArray {
    if (input == null) return ByteArray(0)
    input.use {
      val out = ByteArrayOutputStream()
      val buf = ByteArray(8192)
      while (out.size() < MAX_RESPONSE) {
        val n = it.read(buf)
        if (n <= 0) break
        out.write(buf, 0, n)
      }
      if (out.size() >= MAX_RESPONSE) throw ShareException("对方返回的内容太大")
      return out.toByteArray()
    }
  }
}

/**
 * Everything a receiver needs in one line, for the QR code: scanning it is enough.
 * tmuxweb://share?h=192.168.1.23,10.126.126.5&p=48620&k=<password>
 */
data class ShareLink(val hosts: List<String>, val port: Int, val password: String) {
  override fun toString() = "$PREFIX?h=${hosts.joinToString(",")}&p=$port&k=${URLEncoder.encode(password, "UTF-8")}"

  companion object {
    const val PREFIX = "tmuxweb://share"

    fun parse(text: String): ShareLink? {
      val s = text.trim()
      if (!s.startsWith("$PREFIX?")) return null
      val q = s.substringAfter('?').split('&').mapNotNull { kv ->
        val parts = kv.split('=', limit = 2)
        if (parts.size != 2) null else parts[0] to (try { URLDecoder.decode(parts[1], "UTF-8") } catch (_: Exception) { return null })
      }.toMap()
      val hosts = q["h"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }
      val port = q["p"]?.toIntOrNull() ?: return null
      val password = q["k"].orEmpty()
      if (hosts.isEmpty() || port !in 1024..65535 || password.length < ShareProtocol.MIN_PASSWORD) return null
      return ShareLink(hosts, port, password)
    }
  }
}

fun localShareAddresses(): List<String> = try {
  NetworkInterface.getNetworkInterfaces().toList()
    .filter { it.isUp && !it.isLoopback && !it.isVirtual }
    .flatMap { n -> n.inetAddresses.toList() }
    .filterIsInstance<Inet4Address>()
    .filter { !it.isLoopbackAddress }
    .mapNotNull { it.hostAddress }
    .distinct()
    .sorted()
} catch (_: Exception) {
  emptyList()
}
