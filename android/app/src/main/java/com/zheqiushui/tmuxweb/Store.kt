package com.zheqiushui.tmuxweb

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One server: where to SSH to, and which port of it serves tmux-web. */
data class Profile(
  val id: String = UUID.randomUUID().toString(),
  val name: String = "",
  /** "direct": open [directUrl] as it is; "easytier": bundled EasyTier + a local forward; "ssh" */
  val mode: String = "direct",
  val directUrl: String = "",
  /** the EasyTier network name and its shared secret */
  val easyTierNetwork: String = "",
  val easyTierSecret: String = "",
  /** one or more public relay nodes, comma or newline separated */
  val easyTierPeers: String = "",
  /** the tmux-web server's IPv4 address inside the EasyTier network */
  val easyTierServerIP: String = "",
  /** user@host */
  val target: String = "",
  val sshPort: Int = 22,
  val remoteHost: String = "127.0.0.1",
  val remotePort: Int = 8080,
  /** fixed, so the page keeps its login and settings (they belong to http://127.0.0.1:<port>) */
  val localPort: Int = 18080,
  /** the private key it logs in with, one of the key list's ([SshKey]); empty = none */
  val keyId: String = "",
  /** that key's text, filled in only for connecting ([ProfileStore.resolved]); never saved
   * here (older versions did: moved to the key list when read) */
  val privateKey: String = "",
  val keyPassphrase: String = "",
  /** empty = asked for when the server wants it */
  val password: String = "",
  /** when it was last connected to (ms), 0 = never: the home screen lists the recent ones first */
  val lastUsed: Long = 0,
) {
  val isDirect get() = mode == "direct"
  val isEasyTier get() = mode == "easytier"
  val title get() = name.ifBlank {
    when {
      isDirect -> directBase?.let { android.net.Uri.parse(it).host } ?: directUrl
      isEasyTier -> easyTierServerIP.ifBlank { easyTierNetwork.ifBlank { "EasyTier" } }
      else -> target
    }
  }
  val user get() = target.substringBefore('@', "")
  val host get() = target.substringAfter('@')
  /** what the card shows under the name */
  val address get() = when {
    isDirect -> directBase ?: directUrl
    isEasyTier -> "EasyTier${easyTierNetwork.trim().let { if (it.isEmpty()) "" else " · $it" }} → ${easyTierServerIP.trim()}:$remotePort"
    else -> "${target.trim()}${if (sshPort == 22) "" else ":$sshPort"} → $remotePort"
  }
  val isComplete get() = when {
    isDirect -> directBase != null
    isEasyTier -> EasyTierConfig.problem(this) == null
    else -> target.contains('@') && host.isNotBlank() && user.isNotBlank() && remotePort > 0 && localPort > 0
  }

  /** The direct address as http(s)://host[:port] ("10.0.0.2:8080" gets http://), or null. */
  val directBase: String?
    get() {
      var s = directUrl.trim().trimEnd('/')
      if (s.isEmpty()) return null
      if (!s.contains("://")) s = "http://$s"
      val u = android.net.Uri.parse(s)
      return if ((u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrBlank()) s else null
    }

  fun toJson() = JSONObject().apply {
    put("id", id); put("name", name); put("mode", mode); put("directUrl", directUrl); put("target", target); put("sshPort", sshPort)
    put("easyTierNetwork", easyTierNetwork); put("easyTierSecret", easyTierSecret); put("easyTierPeers", easyTierPeers); put("easyTierServerIP", easyTierServerIP)
    put("remoteHost", remoteHost); put("remotePort", remotePort); put("localPort", localPort)
    put("keyId", keyId); put("password", password); put("lastUsed", lastUsed)
  }

  companion object {
    fun fromJson(o: JSONObject) = Profile(
      id = o.optString("id", UUID.randomUUID().toString()), name = o.optString("name"), mode = o.optString("mode", "ssh"), directUrl = o.optString("directUrl"), target = o.optString("target"),
      easyTierNetwork = o.optString("easyTierNetwork"), easyTierSecret = o.optString("easyTierSecret"),
      easyTierPeers = o.optString("easyTierPeers"), easyTierServerIP = o.optString("easyTierServerIP"),
      sshPort = o.optInt("sshPort", 22), remoteHost = o.optString("remoteHost", "127.0.0.1"), remotePort = o.optInt("remotePort", 8080),
      localPort = o.optInt("localPort", 18080), keyId = o.optString("keyId"), privateKey = o.optString("privateKey"), keyPassphrase = o.optString("keyPassphrase"),
      password = o.optString("password"), lastUsed = o.optLong("lastUsed", 0),
    )
  }
}

/** A private key, kept once: any number of servers log in with it. */
data class SshKey(
  val id: String = UUID.randomUUID().toString(),
  val name: String = "",
  val privateKey: String = "",
  val passphrase: String = "",
  val added: Long = System.currentTimeMillis(),
) {
  fun toJson() = JSONObject().apply {
    put("id", id); put("name", name); put("privateKey", privateKey); put("passphrase", passphrase); put("added", added)
  }

  companion object {
    fun fromJson(o: JSONObject) = SshKey(
      id = o.optString("id", UUID.randomUUID().toString()), name = o.optString("name"), privateKey = o.optString("privateKey"),
      passphrase = o.optString("passphrase"), added = o.optLong("added", 0),
    )
  }
}

/**
 * The servers, the one used last, and the private keys, kept encrypted: AES-GCM with a key that
 * lives in the Android keystore and never leaves it. Passwords and private keys are in there too.
 */
class ProfileStore(context: Context) {
  private val prefs = context.getSharedPreferences("config", Context.MODE_PRIVATE)

  var keys: List<SshKey> = loadKeys()
    private set
  var profiles: List<Profile> = load()
    private set
  var currentId: String? = prefs.getString("current", null)
    private set

  init {
    // older versions kept each server's key with it
    if (profiles.any { it.privateKey.isNotBlank() }) {
      profiles = profiles.map(::adopt)
      save()
    }
  }

  val current: Profile? get() = profiles.firstOrNull { it.id == currentId } ?: profiles.firstOrNull()

  /** a changed one stays where it was in the list; a new one goes last */
  fun upsert(server: Profile) {
    val p = adopt(server)
    profiles = if (profiles.any { it.id == p.id }) profiles.map { if (it.id == p.id) p else it } else profiles + p
    if (currentId == null) currentId = p.id
    save()
  }

  /** A local port no other SSH server here uses: each keeps its own page login (it belongs to the port). */
  fun freeLocalPort(except: String? = null): Int {
    val used = profiles.filter { !it.isDirect && it.id != except }.map { it.localPort }.toSet()
    var port = 18080
    while (port in used) port++
    return port
  }

  fun remove(id: String) {
    profiles = profiles.filter { it.id != id }
    if (currentId == id) currentId = profiles.firstOrNull()?.id
    save()
  }

  /** connecting to it: it's the current one, and the most recently used */
  fun select(id: String) {
    currentId = id
    profiles = profiles.map { if (it.id == id) it.copy(lastUsed = System.currentTimeMillis()) else it }
    save()
  }

  fun key(id: String): SshKey? = if (id.isEmpty()) null else keys.firstOrNull { it.id == id }

  /** the servers that log in with it */
  fun usersOf(keyId: String) = profiles.filter { it.mode == "ssh" && it.keyId == keyId }

  /** The server as the connection needs it: with its key's text. */
  fun resolved(p: Profile): Profile = if (p.mode == "ssh") {
    key(p.keyId)?.let { p.copy(privateKey = it.privateKey, keyPassphrase = it.passphrase) } ?: p.copy(privateKey = "", keyPassphrase = "")
  } else p.copy(privateKey = "", keyPassphrase = "")

  /** a changed one stays where it was; a new one goes last */
  fun upsertKey(k: SshKey) {
    keys = if (keys.any { it.id == k.id }) keys.map { if (it.id == k.id) k else it } else keys + k
    save()
  }

  /** a shared bundle: all new keys and servers land together, with one write */
  fun upsertImported(importedKeys: List<SshKey>, importedProfiles: List<Profile>) {
    keys = importedKeys
    profiles = importedProfiles
    if (currentId == null) currentId = profiles.firstOrNull()?.id
    save()
  }

  /** gone from the list; the servers that used it log in without a key from now on */
  fun removeKey(id: String) {
    keys = keys.filter { it.id != id }
    profiles = profiles.map { if (it.keyId == id) it.copy(keyId = "") else it }
    save()
  }

  /** A key that came with the server (an older version's, a test's) goes into the key list; the same key only once. */
  private fun adopt(p: Profile): Profile {
    val text = p.privateKey.trim()
    if (p.mode != "ssh") return p.copy(keyId = "", privateKey = "", keyPassphrase = "")
    if (text.isEmpty() || key(p.keyId) != null) return p.copy(privateKey = "", keyPassphrase = "")
    val k = keys.firstOrNull { it.privateKey.trim() == text }
      ?: SshKey(name = "${p.title} 的私钥", privateKey = text, passphrase = p.keyPassphrase).also { keys = keys + it }
    return p.copy(keyId = k.id, privateKey = "", keyPassphrase = "")
  }

  private fun loadKeys(): List<SshKey> {
    val enc = prefs.getString("keys", null) ?: return emptyList()
    return try {
      val arr = JSONArray(Crypto.open(enc))
      (0 until arr.length()).map { SshKey.fromJson(arr.getJSONObject(it)) }
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun load(): List<Profile> {
    val enc = prefs.getString("profiles", null) ?: return emptyList()
    return try {
      val arr = JSONArray(Crypto.open(enc))
      (0 until arr.length()).map { Profile.fromJson(arr.getJSONObject(it)) }
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun save() {
    val arr = JSONArray().apply { profiles.forEach { put(it.toJson()) } }
    val ks = JSONArray().apply { keys.forEach { put(it.toJson()) } }
    // commit, not apply: the keys and the servers that point at them must land together
    prefs.edit().putString("keys", Crypto.seal(ks.toString())).putString("profiles", Crypto.seal(arr.toString())).putString("current", currentId).commit()
  }
}

/** SSH host keys seen before (first use is trusted, a change afterwards is refused), like known_hosts. */
class KnownHosts(context: Context) {
  private val prefs = context.getSharedPreferences("known_hosts", Context.MODE_PRIVATE)
  fun get(host: String, port: Int): String? = prefs.getString("$host:$port", null)
  fun put(host: String, port: Int, fingerprint: String) = prefs.edit().putString("$host:$port", fingerprint).apply()
  fun forget(host: String, port: Int) = prefs.edit().remove("$host:$port").apply()
}

object Crypto {
  private const val ALIAS = "tmux-web-config"

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  fun seal(text: String): String {
    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val ct = c.doFinal(text.toByteArray())
    return Base64.encodeToString(c.iv + ct, Base64.NO_WRAP)
  }

  fun open(data: String): String {
    val all = Base64.decode(data, Base64.NO_WRAP)
    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, 12)) }
    return String(c.doFinal(all, 12, all.size - 12))
  }
}
