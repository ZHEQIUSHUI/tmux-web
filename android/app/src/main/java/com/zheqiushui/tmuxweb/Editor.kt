package com.zheqiushui.tmuxweb

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/** One server's settings, full screen: new, edited, or a copy. Mistakes show as you type. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(m: AppModel, a: Actions, e: Screen.Editor) {
  val ctx = LocalContext.current
  val original = remember(e) { e.id?.let { id -> m.profiles.firstOrNull { it.id == id } } }
  val start = remember(e) {
    val free = ProfileStore(ctx).freeLocalPort()
    original
      ?: e.copyOf?.let { id -> m.profiles.firstOrNull { it.id == id } }?.let {
        it.copy(id = UUID.randomUUID().toString(), name = "${it.title} 副本", lastUsed = 0, localPort = if (it.isDirect) it.localPort else free)
      }
      ?: Profile(mode = e.mode ?: "direct", localPort = free)
  }
  var mode by remember(e) { mutableStateOf(start.mode) }
  var name by remember(e) { mutableStateOf(start.name) }
  var url by remember(e) { mutableStateOf(start.directUrl) }
  var target by remember(e) { mutableStateOf(start.target) }
  var sshPort by remember(e) { mutableStateOf(start.sshPort.toString()) }
  var remotePort by remember(e) { mutableStateOf(start.remotePort.toString()) }
  var remoteHost by remember(e) { mutableStateOf(start.remoteHost) }
  var localPort by remember(e) { mutableStateOf(start.localPort.toString()) }
  var password by remember(e) { mutableStateOf(start.password) }
  var key by remember(e) { mutableStateOf(start.privateKey) }
  var passphrase by remember(e) { mutableStateOf(start.keyPassphrase) }
  var advanced by remember(e) { mutableStateOf(false) }
  var deleting by remember { mutableStateOf(false) }
  var test by remember(e) { mutableStateOf<Probe.Result?>(null) }
  var keyNote by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  val draft = start.copy(
    mode = mode, name = name.trim(), directUrl = url.trim(), target = target.trim(),
    sshPort = sshPort.toIntOrNull() ?: 0, remotePort = remotePort.toIntOrNull() ?: 0, remoteHost = remoteHost.trim().ifEmpty { "127.0.0.1" },
    localPort = localPort.toIntOrNull() ?: 0, password = password, privateKey = key.trim(), keyPassphrase = passphrase,
  )
  LaunchedEffect(mode, url, target, sshPort) { test = null }

  // ---- checks as you type ----
  fun portError(s: String) = if ((s.toIntOrNull() ?: 0) in 1..65535) null else "端口在 1–65535 之间"
  val urlError = if (url.isBlank() || draft.directBase != null) null else "网址不对，比如 http://10.126.126.2:8080"
  val targetError = when {
    target.isBlank() -> null
    !target.contains('@') || draft.user.isBlank() || draft.host.isBlank() -> "要写成 user@host"
    target.contains(' ') -> "不能有空格；端口填在下面"
    else -> null
  }
  val taken = m.profiles.firstOrNull { !it.isDirect && it.id != draft.id && it.localPort == draft.localPort }
  val localError = portError(localPort) ?: taken?.let { "「${it.title}」也用这个端口，换一个" }
  val keyError = if (key.trimStart().let { it.startsWith("ssh-") || it.startsWith("ecdsa-") || it.startsWith("sk-") }) "这是公钥。登录要用私钥：以 -----BEGIN … PRIVATE KEY----- 开头的那个文件" else null
  val valid = if (mode == "direct") draft.directBase != null else
    targetError == null && draft.isComplete && listOf(sshPort, remotePort).all { portError(it) == null } && localError == null && keyError == null

  val importKey = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri == null) return@rememberLauncherForActivityResult
    val text = try {
      ctx.contentResolver.openInputStream(uri)?.use { it.readBytes().take(64 * 1024).toByteArray().toString(Charsets.UTF_8) } ?: ""
    } catch (_: Exception) {
      ""
    }
    when {
      text.trimStart().startsWith("-----BEGIN") -> { key = text.trim(); keyNote = "已导入" }
      text.startsWith("ssh-") -> keyNote = "选的是公钥。登录要用对应的私钥（通常是同名、没有 .pub 的那个文件）。"
      else -> keyNote = "这个文件看起来不是 SSH 私钥。"
    }
  }

  BackHandler { a.closeEditor() }
  Scaffold(
    topBar = {
      TopAppBar(
        navigationIcon = { IconButton(onClick = { a.closeEditor() }) { Icon(Icons.Filled.Close, "关闭") } },
        title = { Text(if (original == null) "新建服务器" else "编辑服务器") },
        actions = { TextButton(onClick = { a.save(draft, false, original) }, enabled = valid) { Text("保存") } },
      )
    },
  ) { pad ->
    Box(Modifier.padding(pad).fillMaxSize().imePadding(), contentAlignment = Alignment.TopCenter) {
      Column(
        Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(14.dp),
      ) {
        // the way in: two big choices
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
          ModeCard(LanIcon, Color(0xFF13A3A0), "直接访问", "EasyTier、局域网等能直接打开的网址", mode == "direct", Modifier.weight(1f)) { mode = "direct" }
          ModeCard(TerminalIcon, Color(0xFF5B5BD6), "SSH 转发", "SSH 登录后转发端口，不用开放端口", mode == "ssh", Modifier.weight(1f)) { mode = "ssh" }
        }

        Section("服务器")
        OutlinedTextField(
          name, { name = it }, Modifier.fillMaxWidth(), label = { Text("名称") }, placeholder = { Text("比如「工作站」") },
          supportingText = { Text("不填就显示地址") }, singleLine = true,
        )
        if (mode == "direct") {
          OutlinedTextField(
            url, { url = it }, Modifier.fillMaxWidth(), label = { Text("网址") }, placeholder = { Text("http://10.126.126.2:8080") },
            isError = urlError != null, supportingText = { Text(urlError ?: "tmux-web 的地址，不写 http:// 也行") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
          )
        } else {
          OutlinedTextField(
            target, { target = it }, Modifier.fillMaxWidth(), label = { Text("SSH 目标") }, placeholder = { Text("user@host") },
            isError = targetError != null, supportingText = { Text(targetError ?: "登录用户名和服务器地址") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(
              sshPort, { sshPort = it.filter(Char::isDigit) }, Modifier.weight(1f), label = { Text("SSH 端口") },
              isError = portError(sshPort) != null, supportingText = { Text(portError(sshPort) ?: "一般是 22") }, singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            OutlinedTextField(
              remotePort, { remotePort = it.filter(Char::isDigit) }, Modifier.weight(1f), label = { Text("tmux-web 端口") },
              isError = portError(remotePort) != null, supportingText = { Text(portError(remotePort) ?: "服务器上的，默认 8080") }, singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
          }

          Section("登录")
          SecretField(password, { password = it }, "SSH 密码", supporting = "可选。不填的话需要时弹框输入")
          OutlinedTextField(
            key, { key = it; keyNote = null }, Modifier.fillMaxWidth(), label = { Text("私钥") },
            placeholder = { Text("-----BEGIN OPENSSH PRIVATE KEY-----") },
            leadingIcon = { Icon(KeyIcon, null) },
            isError = keyError != null,
            supportingText = { Text(keyError ?: keyNote ?: "可选。粘贴私钥内容，或从文件导入") },
            minLines = 2, maxLines = 6,
            textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { importKey.launch(arrayOf("*/*")) }) {
              Icon(UploadFileIcon, null, Modifier.size(18.dp)); Spacer(Modifier.size(8.dp)); Text("从文件导入")
            }
            if (key.isNotEmpty()) TextButton(onClick = { key = ""; passphrase = ""; keyNote = null }) { Text("清除") }
          }
          AnimatedVisibility(key.isNotBlank()) {
            SecretField(passphrase, { passphrase = it }, "私钥口令", supporting = "私钥有口令才填")
          }

          // the rarely needed ones, folded away
          Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { advanced = !advanced }.padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text("高级", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
            Icon(if (advanced) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, tint = MaterialTheme.colorScheme.primary)
          }
          // a port clash opens it by itself: that's where the fix is
          AnimatedVisibility(advanced || localError != null) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
              OutlinedTextField(
                localPort, { localPort = it.filter(Char::isDigit) }, Modifier.fillMaxWidth(), label = { Text("本地端口") },
                isError = localError != null, singleLine = true,
                supportingText = { Text(localError ?: "手机上用的端口，每台服务器固定一个，网页的登录状态才能保留") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
              )
              OutlinedTextField(
                remoteHost, { remoteHost = it }, Modifier.fillMaxWidth(), label = { Text("tmux-web 在服务器上的地址") },
                supportingText = { Text("一般不用改") }, singleLine = true,
              )
              if (draft.host.isNotBlank()) {
                OutlinedButton(onClick = { a.forgetHostKey(draft) }) {
                  Icon(Icons.Filled.Lock, null, Modifier.size(18.dp)); Spacer(Modifier.size(8.dp)); Text("忘记主机密钥")
                }
                Text(
                  "第一次连接时会记住服务器的身份，之后变了就拒绝连接（防冒充）。服务器重装过才需要点这个。",
                  style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
              }
            }
          }
        }

        // 测试连接: is it there at all (logging in is checked when connecting)
        Row(verticalAlignment = Alignment.CenterVertically) {
          OutlinedButton(
            enabled = valid && test != Probe.Result.Checking,
            onClick = {
              test = Probe.Result.Checking
              val p = draft
              scope.launch { test = withContext(Dispatchers.IO) { Probe.run(p, 5000) } }
            },
          ) {
            if (test == Probe.Result.Checking) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Icon(NetworkCheckIcon, null, Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text("测试连接")
          }
        }
        test?.takeIf { it != Probe.Result.Checking }?.let { TestResult(it, mode == "direct") }

        if (mode == "ssh") {
          Text(
            "需要验证码时，连接过程中会弹框输入。设置（包括密码和私钥）加密保存在手机里。",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        Spacer(Modifier.size(4.dp))
        Button(onClick = { a.save(draft, true, original) }, enabled = valid, modifier = Modifier.fillMaxWidth().height(52.dp)) {
          Text("保存并连接", style = MaterialTheme.typography.titleSmall)
        }
        if (original != null) {
          TextButton(onClick = { deleting = true }, modifier = Modifier.fillMaxWidth()) {
            Text("删除服务器", color = MaterialTheme.colorScheme.error)
          }
        }
        Spacer(Modifier.size(24.dp))
      }
    }
  }
  if (deleting && original != null) ConfirmDelete(original, { deleting = false }) { deleting = false; a.remove(original) }
}

@Composable
private fun Section(title: String) {
  Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp))
}

@Composable
private fun ModeCard(icon: ImageVector, color: Color, title: String, text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(20.dp)
  Surface(
    shape = shape,
    color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
    border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
    modifier = modifier.fillMaxHeight().clip(shape).clickable(onClick = onClick),
  ) {
    Column(Modifier.padding(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(11.dp)).background(color), contentAlignment = Alignment.Center) {
          Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.weight(1f))
        if (selected) Icon(Icons.Filled.CheckCircle, "已选", tint = MaterialTheme.colorScheme.primary)
      }
      Spacer(Modifier.size(10.dp))
      Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
      Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun TestResult(r: Probe.Result, direct: Boolean) {
  val ok = r is Probe.Result.Up
  Surface(
    shape = RoundedCornerShape(16.dp),
    color = if (ok) StateColor.ok.copy(alpha = 0.12f) else MaterialTheme.colorScheme.errorContainer,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
      Icon(if (ok) Icons.Filled.CheckCircle else Icons.Filled.Warning, null, tint = if (ok) StateColor.ok else MaterialTheme.colorScheme.onErrorContainer)
      Spacer(Modifier.size(12.dp))
      Column {
        when (r) {
          is Probe.Result.Up -> {
            Text(if (direct) "tmux-web 有响应 · ${r.ms} ms" else "SSH 端口能连上 · ${r.ms} ms", fontWeight = FontWeight.SemiBold)
            if (!direct) Text("登录在连接时验证", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
          is Probe.Result.Down -> {
            Text("连不上：${r.why}", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onErrorContainer)
            Text(
              if (direct) "确认网址、tmux-web 在运行，以及手机能访问到它" else "确认地址、SSH 端口，以及手机能访问到服务器",
              style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer,
            )
          }
          else -> {}
        }
      }
    }
  }
}

/** a password field: dots, or the text after a tap on the eye */
@Composable
fun SecretField(value: String, onChange: (String) -> Unit, label: String, supporting: String? = null, secret: Boolean = true, autoFocus: Boolean = false) {
  var shown by remember { mutableStateOf(false) }
  val focus = remember { FocusRequester() }
  if (autoFocus) LaunchedEffect(Unit) { focus.requestFocus() }
  OutlinedTextField(
    value, onChange, Modifier.fillMaxWidth().focusRequester(focus), label = { Text(label) }, singleLine = true,
    supportingText = supporting?.let { { Text(it) } },
    visualTransformation = if (secret && !shown) PasswordVisualTransformation() else VisualTransformation.None,
    keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else KeyboardType.Text),
    trailingIcon = if (secret) ({
      IconButton(onClick = { shown = !shown }) { Icon(if (shown) EyeOffIcon else EyeIcon, if (shown) "隐藏密码" else "显示密码") }
    }) else null,
  )
}
