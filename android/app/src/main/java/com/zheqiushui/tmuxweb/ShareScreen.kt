package com.zheqiushui.tmuxweb

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.SecureRandom

/** Share selected servers and keys over the LAN, or receive them from another device. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareScreen(m: AppModel, a: Actions) {
  BackHandler { a.home() }
  var tab by remember { mutableIntStateOf(0) }
  Scaffold(
    topBar = {
      TopAppBar(
        navigationIcon = { IconButton(onClick = { a.home() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
        title = { Text("共享配置") },
      )
    },
  ) { pad ->
    Column(Modifier.padding(pad).fillMaxSize().imePadding()) {
      TabRow(selectedTabIndex = tab) {
        Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("共享给其他设备") })
        Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("从其他设备获取") })
      }
      if (tab == 0) ShareSender(m) else ShareReceiver(a)
    }
  }
}

@Composable
private fun ShareSender(m: AppModel) {
  val scope = rememberCoroutineScope()
  val clipboard = LocalClipboardManager.current
  val context = LocalContext.current
  var selectedProfiles by remember { mutableStateOf(m.profiles.map { it.id }.toSet()) }
  var selectedKeys by remember { mutableStateOf(m.keys.map { it.id }.toSet()) }
  var port by remember { mutableStateOf(ShareProtocol.DEFAULT_PORT.toString()) }
  var password by remember { mutableStateOf("") }
  var error by remember { mutableStateOf<String?>(null) }
  val running = ShareRuntime.running

  fun toggleProfile(p: Profile) {
    val select = p.id !in selectedProfiles
    selectedProfiles = if (select) selectedProfiles + p.id else selectedProfiles - p.id
    if (select && p.keyId.isNotEmpty()) selectedKeys = selectedKeys + p.keyId
  }

  LazyColumn(
    Modifier.fillMaxSize().navigationBarsPadding(),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    if (running != null) {
      item {
        ShareCard {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.CheckCircle, null, tint = StateColor.ok)
            Spacer(Modifier.size(10.dp))
            Column {
              Text("共享已开始", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
              Text("${running.profileCount} 个服务器 · ${running.keyCount} 把私钥", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
          }
          Spacer(Modifier.size(16.dp))
          Text("在另一台设备打开 tmux-web App → 共享配置 → 从其他设备获取，填入下面的地址和端口，再输入刚才设置的密码。", style = MaterialTheme.typography.bodyMedium)
          Spacer(Modifier.size(14.dp))
          Text("本机地址", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
          if (running.addresses.isEmpty()) {
            Text("没有找到局域网 IPv4 地址。确认手机已连接 Wi-Fi。", color = MaterialTheme.colorScheme.error)
          } else {
            for (ip in running.addresses) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text("$ip:${running.port}", style = MaterialTheme.typography.titleMedium, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                  clipboard.setText(AnnotatedString("$ip:${running.port}"))
                }) { Text("复制") }
              }
            }
          }
          Spacer(Modifier.size(7.dp))
          Text("共享的配置只会在密码正确时返回；离开此页后仍会继续，直到点停止或退出 App。只在你信任的局域网中使用。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Spacer(Modifier.size(16.dp))
          OutlinedButton(onClick = { ShareRuntime.stop() }, modifier = Modifier.fillMaxWidth()) { Text("停止共享") }
        }
      }
      return@LazyColumn
    }

    item {
      ShareCard {
        Text("共享哪些配置", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("选中的服务器会带上连接地址、账号、密码、EasyTier 网络信息和所用私钥。接收方会自动跳过完全相同的配置。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.size(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          TextButton(onClick = { selectedProfiles = m.profiles.map { it.id }.toSet(); selectedKeys = m.keys.map { it.id }.toSet() }) { Text("全选") }
          TextButton(onClick = { selectedProfiles = emptySet(); selectedKeys = emptySet() }) { Text("全不选") }
        }
      }
    }

    if (m.profiles.isEmpty()) {
      item { ShareCard { Text("还没有服务器配置可以共享。", color = MaterialTheme.colorScheme.onSurfaceVariant) } }
    } else {
      item { SectionLabel("服务器 · ${selectedProfiles.size}/${m.profiles.size}") }
      items(m.profiles, key = { "p-${it.id}" }) { p ->
        SelectionRow(
          checked = p.id in selectedProfiles,
          title = p.title,
          subtitle = p.address,
          leading = { ServerAvatar(p, 38.dp) },
          onCheckedChange = { toggleProfile(p) },
        )
      }
    }

    if (m.keys.isNotEmpty()) {
      item { SectionLabel("SSH 私钥 · ${selectedKeys.size}/${m.keys.size}") }
      items(m.keys, key = { "k-${it.id}" }) { k ->
        val users = m.profiles.count { it.mode == "ssh" && it.keyId == k.id }
        SelectionRow(
          checked = k.id in selectedKeys,
          title = k.name.ifBlank { "未命名私钥" },
          subtitle = if (users > 0) "$users 个服务器在用" else "独立私钥",
          leading = { Icon(KeyIcon, null, tint = MaterialTheme.colorScheme.primary) },
          onCheckedChange = { on ->
            selectedKeys = if (on) selectedKeys + k.id else selectedKeys - k.id
          },
        )
      }
    }

    item {
      ShareCard {
        Text("连接方式", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.size(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
          OutlinedTextField(
            port, { port = it.filter(Char::isDigit).take(5) }, Modifier.weight(1f),
            label = { Text("端口") }, singleLine = true,
            isError = port.toIntOrNull() !in 1024..65535,
            supportingText = { Text(if (port.toIntOrNull() !in 1024..65535) "1024–65535" else "另一台设备用这个端口连接") },
          )
          OutlinedButton(onClick = { password = randomPassword() }) { Text("随机密码") }
        }
        SecretField(
          password, { password = it }, "访问密码",
          supporting = if (password.isNotEmpty() && password.length < ShareProtocol.MIN_PASSWORD) "至少 ${ShareProtocol.MIN_PASSWORD} 位" else "对方需要输入这个密码才能获取",
        )
        error?.let {
          Spacer(Modifier.size(10.dp))
          LabeledError(it)
        }
        Spacer(Modifier.size(14.dp))
        val ready = selectedProfiles.isNotEmpty() && port.toIntOrNull() in 1024..65535 && password.length >= ShareProtocol.MIN_PASSWORD
        Button(
          onClick = {
            error = null
            scope.launch {
              try {
                val payload = SharePayloadBuilder.build(m.profiles, m.keys, selectedProfiles, selectedKeys)
                ShareRuntime.start(payload, password, port.toInt())
              } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
              }
            }
          },
          enabled = ready && !ShareRuntime.starting,
          modifier = Modifier.fillMaxWidth(),
        ) {
          if (ShareRuntime.starting) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.size(9.dp))
          }
          Text(if (selectedProfiles.isEmpty()) "选择至少一个服务器" else "开始共享")
        }
      }
    }
  }
}

@Composable
private fun ShareReceiver(a: Actions) {
  val scope = rememberCoroutineScope()
  var host by remember { mutableStateOf("") }
  var port by remember { mutableStateOf(ShareProtocol.DEFAULT_PORT.toString()) }
  var password by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var result by remember { mutableStateOf<ShareImportSummary?>(null) }

  LazyColumn(
    Modifier.fillMaxSize().navigationBarsPadding(),
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    if (result != null) {
      item {
        ShareCard {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.CheckCircle, null, tint = StateColor.ok)
            Spacer(Modifier.size(10.dp))
            Text("导入完成", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
          }
          Spacer(Modifier.size(10.dp))
          Text(result!!.text, style = MaterialTheme.typography.bodyLarge)
          Spacer(Modifier.size(14.dp))
          Button(onClick = { result = null; password = ""; error = null }, modifier = Modifier.fillMaxWidth()) { Text("再接收一份") }
        }
      }
      return@LazyColumn
    }
    item {
      ShareCard {
        Text("从另一台设备获取", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("让对方打开 tmux-web App 的「共享配置」，开始共享后，把显示的 IP 和端口填在这里。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.size(14.dp))
        OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text("对方 IP") }, placeholder = { Text("比如 192.168.1.23") }, singleLine = true)
        Spacer(Modifier.size(10.dp))
        OutlinedTextField(
          port, { port = it.filter(Char::isDigit).take(5) }, Modifier.fillMaxWidth(),
          label = { Text("端口") }, singleLine = true,
          isError = port.toIntOrNull() !in 1024..65535,
          supportingText = if (port.toIntOrNull() !in 1024..65535) ({ Text("1024–65535") }) else null,
        )
        Spacer(Modifier.size(4.dp))
        SecretField(password, { password = it }, "对方设置的访问密码", supporting = "密码不对时不会收到任何配置")
        error?.let {
          Spacer(Modifier.size(10.dp))
          LabeledError(it)
        }
        Spacer(Modifier.size(14.dp))
        Button(
          onClick = {
            error = null
            busy = true
            scope.launch {
              try {
                val payload = withContext(Dispatchers.IO) { ShareClient.fetch(host, port.toInt(), password) }
                result = a.importShared(payload)
                a.probeAll()
              } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
              } finally {
                busy = false
              }
            }
          },
          enabled = !busy && host.isNotBlank() && port.toIntOrNull() in 1024..65535 && password.isNotEmpty(),
          modifier = Modifier.fillMaxWidth(),
        ) {
          if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.size(9.dp))
          }
          Text(if (busy) "正在获取…" else "获取并导入")
        }
      }
    }
    item {
      ShareCard {
        Text("查重规则", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.size(7.dp))
        Text("服务器会按连接方式、账号、地址、端口、密码和私钥判断；EasyTier 还会比较网络名称、密钥、公共节点和服务器虚拟 IP。完全相同的配置会跳过；同一台服务器但凭据不同，会作为另一个配置导入。相同的私钥只保留一份，导入的服务器会复用它。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}

@Composable
private fun ShareCard(content: @Composable ColumnScope.() -> Unit) {
  Surface(
    shape = RoundedCornerShape(18.dp),
    color = MaterialTheme.colorScheme.surfaceContainerLow,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(Modifier.padding(16.dp), content = content)
  }
}

@Composable
private fun SectionLabel(text: String) {
  Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp, start = 4.dp))
}

@Composable
private fun SelectionRow(checked: Boolean, title: String, subtitle: String, leading: @Composable () -> Unit, onCheckedChange: (Boolean) -> Unit) {
  Surface(
    shape = RoundedCornerShape(14.dp),
    color = if (checked) MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.55f) else MaterialTheme.colorScheme.surfaceContainerLow,
    modifier = Modifier.fillMaxWidth().clickable { onCheckedChange(!checked) },
  ) {
    Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
      leading()
      Spacer(Modifier.size(12.dp))
      Column(Modifier.weight(1f)) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
      }
      Checkbox(checked = checked, onCheckedChange = onCheckedChange)
    }
  }
}

@Composable
private fun LabeledError(text: String) {
  Row(verticalAlignment = Alignment.Top) {
    Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
    Spacer(Modifier.size(7.dp))
    Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
  }
}

private fun randomPassword(): String {
  val alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  val random = SecureRandom()
  return (1..12).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("")
}
