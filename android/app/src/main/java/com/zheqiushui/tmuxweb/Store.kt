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
  /** "direct": open [directUrl] as it is (EasyTier, LAN…); "ssh": through an SSH port forward */
  val mode: String = "direct",
  val directUrl: String = "",
  /** user@host */
  val target: String = "",
  val sshPort: Int = 22,
  val remoteHost: String = "127.0.0.1",
  val remotePort: Int = 8080,
  /** fixed, so the page keeps its login and settings (they belong to http://127.0.0.1:<port>) */
  val localPort: Int = 18080,
  /** the private key itself (pasted or imported from a file); empty = none */
  val privateKey: String = "",
  val keyPassphrase: String = "",
  /** empty = asked for when the server wants it */
  val password: String = "",
) {
  val isDirect get() = mode == "direct"
  val title get() = name.ifBlank { if (isDirect) directBase?.let { android.net.Uri.parse(it).host } ?: directUrl else target }
  val user get() = target.substringBefore('@', "")
  val host get() = target.substringAfter('@')
  val isComplete get() = if (isDirect) directBase != null else target.contains('@') && host.isNotBlank() && user.isNotBlank() && remotePort > 0 && localPort > 0

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
    put("remoteHost", remoteHost); put("remotePort", remotePort); put("localPort", localPort)
    put("privateKey", privateKey); put("keyPassphrase", keyPassphrase); put("password", password)
  }

  companion object {
    fun fromJson(o: JSONObject) = Profile(
      id = o.optString("id", UUID.randomUUID().toString()), name = o.optString("name"), mode = o.optString("mode", "ssh"), directUrl = o.optString("directUrl"), target = o.optString("target"),
      sshPort = o.optInt("sshPort", 22), remoteHost = o.optString("remoteHost", "127.0.0.1"), remotePort = o.optInt("remotePort", 8080),
      localPort = o.optInt("localPort", 18080), privateKey = o.optString("privateKey"), keyPassphrase = o.optString("keyPassphrase"),
      password = o.optString("password"),
    )
  }
}

/**
 * The servers (one for now; the list is there for later), kept encrypted: AES-GCM with a key that
 * lives in the Android keystore and never leaves it. Passwords and private keys are in there too.
 */
class ProfileStore(context: Context) {
  private val prefs = context.getSharedPreferences("config", Context.MODE_PRIVATE)

  var profiles: List<Profile> = load()
    private set
  var currentId: String? = prefs.getString("current", null)
    private set

  val current: Profile? get() = profiles.firstOrNull { it.id == currentId } ?: profiles.firstOrNull()

  fun upsert(p: Profile) {
    profiles = profiles.filter { it.id != p.id } + p
    currentId = p.id
    save()
  }

  fun remove(id: String) {
    profiles = profiles.filter { it.id != id }
    if (currentId == id) currentId = profiles.firstOrNull()?.id
    save()
  }

  fun select(id: String) {
    currentId = id
    save()
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
    prefs.edit().putString("profiles", Crypto.seal(arr.toString())).putString("current", currentId).apply()
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
