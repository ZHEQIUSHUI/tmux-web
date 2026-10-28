package com.zheqiushui.tmuxweb

import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.userauth.password.PasswordFinder
import net.schmizz.sshj.userauth.password.Resource
import java.security.MessageDigest
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.ConcurrentHashMap

/** What a pasted or imported private key is: its kind and fingerprint, or why it can't be used. */
object KeyInfo {
  sealed interface Result {
    /** `publicKey`: the line for the server's ~/.ssh/authorized_keys */
    data class Ok(val type: String, val fingerprint: String, val publicKey: String) : Result
    data class Bad(val message: String) : Result
    object NeedsPassphrase : Result
    object WrongPassphrase : Result
  }

  private val cache = ConcurrentHashMap<String, Result>()

  /** The shape alone, at once (no parsing): a public key, or not a key at all. */
  fun shapeError(text: String): String? {
    val t = text.trim()
    return when {
      t.isEmpty() -> null
      t.startsWith("ssh-") || t.startsWith("ecdsa-") || t.startsWith("sk-") -> "这是公钥。登录要用私钥：以 -----BEGIN … PRIVATE KEY----- 开头的那个文件"
      t.startsWith("PuTTY-User-Key-File") -> "这是 PuTTY 格式（.ppk）。先用 PuTTYgen 导出为 OpenSSH 格式"
      !t.startsWith("-----BEGIN") -> "看起来不是 SSH 私钥：应以 -----BEGIN … PRIVATE KEY----- 开头"
      else -> null
    }
  }

  /** Reads the key the way the connection will. Slow for one with a passphrase: off the main thread. */
  fun inspect(text: String, passphrase: String): Result {
    val t = text.trim()
    shapeError(t)?.let { return Result.Bad(it) }
    val id = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest("$t\u0000$passphrase".toByteArray()), Base64.NO_WRAP)
    cache[id]?.let { return it }
    Bc.install()
    var asked = false
    val finder = object : PasswordFinder {
      override fun reqPassword(resource: Resource<*>?): CharArray {
        asked = true
        return passphrase.toCharArray()
      }
      override fun shouldRetry(resource: Resource<*>?) = false
    }
    val r = try {
      val kp = SSHClient(DefaultConfig()).loadKeys("$t\n", null, finder)
      kp.private // the passphrase is checked here
      val pub = kp.public
      val type = KeyType.fromKey(pub).toString()
      val blob = Buffer.PlainBuffer().putPublicKey(pub).compactData
      val fp = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(blob), Base64.NO_WRAP or Base64.NO_PADDING)
      val label = when {
        type == "ssh-ed25519" -> "ED25519"
        type == "ssh-rsa" -> "RSA ${(pub as? RSAPublicKey)?.modulus?.bitLength() ?: ""}".trim()
        type.startsWith("ecdsa-sha2-nistp") -> "ECDSA ${type.removePrefix("ecdsa-sha2-nistp")}"
        else -> type
      }
      Result.Ok(label, "SHA256:$fp", "$type ${Base64.encodeToString(blob, Base64.NO_WRAP)}")
    } catch (e: Exception) {
      when {
        asked && passphrase.isEmpty() -> Result.NeedsPassphrase
        asked -> Result.WrongPassphrase
        else -> Result.Bad("读不出这个私钥（${e.message ?: e.javaClass.simpleName}）")
      }
    }
    cache[id] = r
    return r
  }

  fun describe(r: Result?, short: Boolean = false): String = when (r) {
    null -> "正在读取…"
    is Result.Ok -> "${r.type} · ${if (short) r.fingerprint.take(19) + "…" else r.fingerprint}"
    is Result.Bad -> r.message
    Result.NeedsPassphrase -> "这把私钥有口令，请填上"
    Result.WrongPassphrase -> "口令不对"
  }
}

/** A key's [KeyInfo], read in the background (null while reading). */
@Composable
fun rememberKeyInfo(text: String, passphrase: String): KeyInfo.Result? =
  produceState<KeyInfo.Result?>(null, text, passphrase) {
    value = null
    // typing: read once it settles
    if (text.isNotBlank()) delay(300)
    value = if (text.isBlank()) null else withContext(Dispatchers.Default) { KeyInfo.inspect(text, passphrase) }
  }.value

/** The private keys, each kept once; any number of servers log in with the same one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeysScreen(m: AppModel, a: Actions) {
  BackHandler { a.home() }
  var editing by remember { mutableStateOf<SshKey?>(null) }
  var deleting by remember { mutableStateOf<SshKey?>(null) }
  val ctx = LocalContext.current
  val clipboard = LocalClipboardManager.current
  val users = { k: SshKey -> m.profiles.filter { it.mode == "ssh" && it.keyId == k.id } }

  Scaffold(
    topBar = {
      TopAppBar(
        navigationIcon = { IconButton(onClick = { a.home() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
        title = { Text("私钥") },
      )
    },
    floatingActionButton = {
      if (m.keys.isNotEmpty()) ExtendedFloatingActionButton(onClick = { editing = SshKey(name = "") }, icon = { Icon(Icons.Filled.Add, null) }, text = { Text("添加私钥") })
    },
  ) { pad ->
    if (m.keys.isEmpty()) {
      Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 520.dp).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
          Spacer(Modifier.size(32.dp))
          Box(Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(KeyIcon, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
          }
          Spacer(Modifier.size(20.dp))
          Text("还没有私钥", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
          Spacer(Modifier.size(8.dp))
          Text(
            "私钥在这里保存一次，编辑服务器时选它就行，多台服务器可以共用一把。在这里改了，用它的服务器都跟着变。",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
          )
          Spacer(Modifier.size(24.dp))
          OutlinedButton(onClick = { editing = SshKey(name = "") }) {
            Icon(Icons.Filled.Add, null, Modifier.size(18.dp)); Spacer(Modifier.size(8.dp)); Text("添加私钥")
          }
        }
      }
    } else {
      LazyColumn(
        Modifier.padding(pad).fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 104.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        items(m.keys, key = { it.id }) { k ->
          KeyCard(
            k, users(k),
            onEdit = { editing = k },
            onCopy = { pub ->
              clipboard.setText(AnnotatedString("$pub ${k.name}".trim()))
              Toast.makeText(ctx, "公钥已复制，加到服务器的 ~/.ssh/authorized_keys 里", Toast.LENGTH_LONG).show()
            },
            onDelete = { deleting = k },
          )
        }
      }
    }
  }

  editing?.let { k ->
    KeyEditor(k.takeIf { it.privateKey.isNotEmpty() }, m.keys, onDismiss = { editing = null }) { a.saveKey(it); editing = null }
  }
  deleting?.let { k ->
    val used = users(k)
    AlertDialog(
      onDismissRequest = { deleting = null },
      icon = { Icon(Icons.Filled.Delete, null) },
      title = { Text("删除「${k.name}」？") },
      text = {
        Text(
          if (used.isEmpty()) "删掉后不能恢复。"
          else "${used.joinToString("、") { "「${it.title}」" }}正在用它，删掉后${if (used.size == 1) "这台服务器" else "这些服务器"}登录时不再用私钥。删掉后不能恢复。",
        )
      },
      confirmButton = { TextButton(onClick = { a.removeKey(k); deleting = null }) { Text("删除", color = MaterialTheme.colorScheme.error) } },
      dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
    )
  }
}

@Composable
private fun KeyCard(k: SshKey, users: List<Profile>, onEdit: () -> Unit, onCopy: (String) -> Unit, onDelete: () -> Unit) {
  val info = rememberKeyInfo(k.privateKey, k.passphrase)
  val shape = RoundedCornerShape(22.dp)
  Surface(
    shape = shape, color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 1.dp,
    modifier = Modifier.widthIn(max = 640.dp).fillMaxWidth().clip(shape).clickable(onClick = onEdit),
  ) {
    Row(Modifier.padding(start = 16.dp, top = 14.dp, end = 4.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
      Box(Modifier.size(42.dp).clip(RoundedCornerShape(13.dp)).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
        Icon(KeyIcon, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
      }
      Spacer(Modifier.size(14.dp))
      Column(Modifier.weight(1f)) {
        Text(k.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
          KeyInfo.describe(info, short = true), maxLines = 1, overflow = TextOverflow.Ellipsis,
          style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
          color = if (info == null || info is KeyInfo.Result.Ok) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
        )
        Text(
          if (users.isEmpty()) "还没有服务器在用" else "${users.size} 台在用：${users.joinToString("、") { it.title }}",
          style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
      }
      Box {
        var menu by remember { mutableStateOf(false) }
        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
          DropdownMenuItem(text = { Text("编辑") }, leadingIcon = { Icon(Icons.Filled.Edit, null) }, onClick = { menu = false; onEdit() })
          (info as? KeyInfo.Result.Ok)?.let { ok ->
            DropdownMenuItem(text = { Text("复制公钥") }, leadingIcon = { Icon(CopyIcon, null) }, onClick = { menu = false; onCopy(ok.publicKey) })
          }
          DropdownMenuItem(
            text = { Text("删除", color = MaterialTheme.colorScheme.error) },
            leadingIcon = { Icon(Icons.Filled.Delete, null, tint = MaterialTheme.colorScheme.error) },
            onClick = { menu = false; onDelete() },
          )
        }
      }
    }
  }
}

/**
 * A key's settings, full screen over whatever opened it (the key list, or a server's settings,
 * whose unsaved changes stay underneath): `original` null = a new one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeyEditor(original: SshKey?, others: List<SshKey>, onDismiss: () -> Unit, onSave: (SshKey) -> Unit) {
  val ctx = LocalContext.current
  val clipboard = LocalClipboardManager.current
  var name by remember { mutableStateOf(original?.name ?: "") }
  var text by remember { mutableStateOf(original?.privateKey ?: "") }
  var passphrase by remember { mutableStateOf(original?.passphrase ?: "") }
  var note by remember { mutableStateOf<String?>(null) }
  val shape = KeyInfo.shapeError(text)
  val info = if (shape == null) rememberKeyInfo(text, passphrase) else KeyInfo.Result.Bad(shape)
  val ok = info as? KeyInfo.Result.Ok
  // the same key kept twice would only confuse: point at the one there is
  val same = produceState<SshKey?>(null, ok?.fingerprint) {
    val fp = ok?.fingerprint
    value = if (fp == null) null else withContext(Dispatchers.Default) {
      others.firstOrNull { it.id != original?.id && (KeyInfo.inspect(it.privateKey, it.passphrase) as? KeyInfo.Result.Ok)?.fingerprint == fp }
    }
  }.value
  val valid = ok != null && same == null && text.isNotBlank()

  val importKey = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri == null) return@rememberLauncherForActivityResult
    val read = try {
      ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().take(64 * 1024).toByteArray().toString(Charsets.UTF_8) } ?: ""
    } catch (_: Exception) {
      ""
    }
    when {
      read.trimStart().startsWith("-----BEGIN") -> {
        text = read.trim()
        note = "已导入"
        // the file's name, if none was given
        if (name.isBlank()) fileName(ctx, uri)?.let { name = it }
      }
      read.startsWith("ssh-") -> note = "选的是公钥。登录要用对应的私钥（通常是同名、没有 .pub 的那个文件）。"
      else -> note = "这个文件看起来不是 SSH 私钥。"
    }
  }

  BackHandler { onDismiss() }
  // over the screen that opened it: its touches stop here
  Box(Modifier.fillMaxSize().pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
    Scaffold(
      topBar = {
        TopAppBar(
          navigationIcon = { IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, "关闭") } },
          title = { Text(if (original == null) "添加私钥" else "编辑私钥") },
          actions = {
            TextButton(
              enabled = valid,
              onClick = {
                val n = name.trim().ifEmpty { "${ok!!.type} 私钥" }
                onSave((original ?: SshKey()).copy(name = n, privateKey = text.trim(), passphrase = passphrase))
              },
            ) { Text("保存") }
          },
        )
      },
    ) { pad ->
      Box(Modifier.padding(pad).fillMaxSize().imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(
          Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding(),
          verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
          OutlinedTextField(
            name, { name = it }, Modifier.fillMaxWidth(), label = { Text("名称") }, placeholder = { Text("比如「工作笔记本」") },
            supportingText = { Text("选私钥时看到的名字。不填就用类型") }, singleLine = true,
          )
          OutlinedTextField(
            text, { text = it; note = null }, Modifier.fillMaxWidth(), label = { Text("私钥") },
            placeholder = { Text("-----BEGIN OPENSSH PRIVATE KEY-----") },
            leadingIcon = { Icon(KeyIcon, null) },
            isError = shape != null,
            supportingText = { Text(shape ?: note ?: "粘贴私钥内容，或从文件导入") },
            minLines = 3, maxLines = 8,
            textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { importKey.launch(arrayOf("*/*")) }) {
              Icon(UploadFileIcon, null, Modifier.size(18.dp)); Spacer(Modifier.size(8.dp)); Text("从文件导入")
            }
            if (text.isNotEmpty()) TextButton(onClick = { text = ""; note = null }) { Text("清除") }
          }
          SecretField(passphrase, { passphrase = it }, "私钥口令", supporting = "私钥有口令才填")

          // what it is, checked the way the connection will read it
          if (text.isNotBlank() && shape == null) {
            Surface(
              shape = RoundedCornerShape(16.dp),
              color = when {
                info == null -> MaterialTheme.colorScheme.surfaceContainerLow
                info is KeyInfo.Result.Ok && same == null -> StateColor.ok.copy(alpha = 0.12f)
                else -> MaterialTheme.colorScheme.errorContainer
              },
              modifier = Modifier.fillMaxWidth(),
            ) {
              Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                when {
                  info == null -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                  info is KeyInfo.Result.Ok && same == null -> Icon(Icons.Filled.CheckCircle, null, tint = StateColor.ok)
                  else -> Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
                }
                Spacer(Modifier.size(12.dp))
                Column(Modifier.weight(1f)) {
                  if (ok != null && same != null) {
                    Text("这把私钥已经保存过了：「${same.name}」", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onErrorContainer)
                    Text("不用再加一次，直接选它就行", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                  } else if (ok != null) {
                    Text(ok.type, fontWeight = FontWeight.SemiBold)
                    Text(ok.fingerprint, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                  } else {
                    Text(
                      KeyInfo.describe(info), fontWeight = FontWeight.SemiBold,
                      color = if (info == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onErrorContainer,
                    )
                  }
                }
              }
            }
          }
          if (ok != null && same == null) {
            OutlinedButton(onClick = {
              clipboard.setText(AnnotatedString("${ok.publicKey} ${name.trim()}".trim()))
              Toast.makeText(ctx, "公钥已复制，加到服务器的 ~/.ssh/authorized_keys 里", Toast.LENGTH_LONG).show()
            }) {
              Icon(CopyIcon, null, Modifier.size(18.dp)); Spacer(Modifier.size(8.dp)); Text("复制公钥")
            }
          }
          Text(
            "私钥加密保存在手机里。编辑服务器时选它，多台服务器可以共用。",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          Spacer(Modifier.height(24.dp))
        }
      }
    }
  }
}

/** a picked file's own name (a document's address often ends in a number) */
private fun fileName(ctx: android.content.Context, uri: android.net.Uri): String? = try {
  ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
    if (c.moveToFirst()) c.getString(0) else null
  }
} catch (_: Exception) {
  null
}?.takeIf { it.isNotBlank() }

/** A server's key: none, one of the list's, or a new one added on the spot. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeyPicker(keys: List<SshKey>, selected: String, onSelect: (String) -> Unit, onAdd: () -> Unit) {
  var open by remember { mutableStateOf(false) }
  val key = keys.firstOrNull { it.id == selected }
  val info = key?.let { rememberKeyInfo(it.privateKey, it.passphrase) }
  ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
    OutlinedTextField(
      key?.name ?: "不用私钥", {}, Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
      readOnly = true, singleLine = true, label = { Text("私钥") },
      leadingIcon = { Icon(KeyIcon, null) },
      trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
      isError = info != null && info !is KeyInfo.Result.Ok,
      supportingText = {
        Text(
          when {
            key != null -> KeyInfo.describe(info, short = true)
            keys.isEmpty() -> "可选。私钥统一保存在「私钥」里，多台服务器可以共用"
            else -> "可选。从保存的私钥里选一把"
          },
        )
      },
    )
    ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      DropdownMenuItem(text = { Text("不用私钥") }, onClick = { onSelect(""); open = false })
      for (k in keys) {
        DropdownMenuItem(
          text = { Text(k.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
          leadingIcon = { Icon(if (k.id == selected) Icons.Filled.CheckCircle else KeyIcon, null) },
          onClick = { onSelect(k.id); open = false },
        )
      }
      HorizontalDivider()
      DropdownMenuItem(
        text = { Text("添加新私钥…", color = MaterialTheme.colorScheme.primary) },
        leadingIcon = { Icon(Icons.Filled.Add, null, tint = MaterialTheme.colorScheme.primary) },
        onClick = { open = false; onAdd() },
      )
    }
  }
}
