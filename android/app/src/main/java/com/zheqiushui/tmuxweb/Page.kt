package com.zheqiushui.tmuxweb

import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay

/** The whole window: the page underneath (kept loaded), the servers or a server's settings over it. */
@Composable
fun AppScreen(m: AppModel, a: Actions, web: WebView) {
  Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
    PageScreen(m, a, web, visible = m.screen == Screen.Page)
    AnimatedContent(
      targetState = m.screen.takeIf { it != Screen.Page },
      transitionSpec = { fadeIn() togetherWith fadeOut() },
      contentKey = { it?.javaClass },
      label = "screen",
    ) { s ->
      // over the page (which stays laid out and running underneath): its touches stop here
      if (s != null) Box(Modifier.fillMaxSize().pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
        when (s) {
          Screen.Home -> HomeScreen(m, a)
          is Screen.Editor -> EditorScreen(m, a, s)
          Screen.Keys -> KeysScreen(m, a)
          Screen.Share -> ShareScreen(m, a)
          else -> {}
        }
      }
    }
  }
  m.question?.let { QuestionDialog(it, a) }
  UpdateDialog()
}

// ---- the page ----

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PageScreen(m: AppModel, a: Actions, web: WebView, visible: Boolean) {
  val p = m.active
  var switcher by remember { mutableStateOf(false) }
  BackHandler(enabled = visible) { if (web.canGoBack()) web.goBack() else a.home() }
  val shown = m.page is PageLoad.Loaded && (m.tunnel is TunnelState.Ready || m.tunnel is TunnelState.Reconnecting)

  Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
    // the bar: ← servers · ● name ▾ (switch) · ⟳ · ⋮
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
      Row(Modifier.statusBarsPadding().fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { a.home() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "服务器列表") }
        // the switcher takes the room there is, no more: the actions stay on the right
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) { Row(
          Modifier.clip(RoundedCornerShape(12.dp)).clickable { switcher = true }.padding(horizontal = 8.dp, vertical = 6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Dot(stateColor(m.tunnel, m.page))
          Spacer(Modifier.size(8.dp))
          Text(
            p?.title ?: "tmux-web", Modifier.weight(1f, fill = false),
            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
          )
          Icon(Icons.Filled.ArrowDropDown, "切换服务器", Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        } }
        IconButton(onClick = { a.reload() }, enabled = shown) { Icon(Icons.Filled.Refresh, "刷新") }
        Box {
          var menu by remember { mutableStateOf(false) }
          IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
          DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("编辑此服务器") }, leadingIcon = { Icon(Icons.Filled.Edit, null) }, onClick = { menu = false; p?.let { a.edit(Screen.Editor(id = it.id)) } })
            DropdownMenuItem(text = { Text("断开连接") }, leadingIcon = { Icon(LinkOffIcon, null) }, onClick = { menu = false; a.disconnect() })
            HorizontalDivider()
            DropdownMenuItem(text = { Text("检查更新") }, leadingIcon = { Icon(UpdateIcon, null) }, onClick = { menu = false; a.checkUpdates() })
          }
        }
      }
    }
    // gone after it worked: the page stays, a thin line says it's coming back
    AnimatedVisibility(visible = shown && m.tunnel is TunnelState.Reconnecting, enter = expandVertically(), exit = shrinkVertically()) {
      Surface(color = MaterialTheme.colorScheme.tertiaryContainer) {
        Column(Modifier.fillMaxWidth()) {
          LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
          Text(
            (m.tunnel as? TunnelState.Reconnecting)?.message ?: "正在重新连接…",
            Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onTertiaryContainer,
          )
        }
      }
    }
    // the keyboard's final height, at once: following its animation frame by frame made the page
    // lay itself out again on every frame, and the keyboard crawled up in slow motion
    Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.imeAnimationTarget))) {
      // never hidden, only covered (the page keeps running); MATCH_PARENT matters: a web view
      // left wrap_content (AndroidView's default) sizes to its content and gets 0 for 100vh
      AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = {
          (web.parent as? ViewGroup)?.removeView(web)
          web.apply { layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT) }
        },
      )
      if (!shown && p != null) Box(Modifier.fillMaxSize().pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
        ConnectingScreen(m, a, p)
      }
    }
  }
  if (switcher) ServerSwitcher(m, a) { switcher = false }
}

fun stateColor(t: TunnelState, page: PageLoad): Color = when {
  t is TunnelState.Failed || page is PageLoad.Failed -> StateColor.bad
  t is TunnelState.Ready && page is PageLoad.Loaded -> StateColor.ok
  t is TunnelState.Idle -> StateColor.off
  else -> StateColor.busy
}

/** every server, the one in use checked: another one is a tap away */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerSwitcher(m: AppModel, a: Actions, close: () -> Unit) {
  ModalBottomSheet(onDismissRequest = close) {
    Text("切换服务器", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
    Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp)) {
      for (p in m.profiles.sortedByDescending { it.lastUsed }) {
        val current = p.id == m.activeId
        ListItem(
          modifier = Modifier.clickable { close(); a.connect(p) },
          leadingContent = { ServerAvatar(p, 40.dp) },
          headlineContent = { Text(p.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (current) FontWeight.SemiBold else null) },
          supportingContent = { Text(middleEllipsis(p.address), maxLines = 1) },
          trailingContent = { if (current) Icon(Icons.Filled.Check, "当前", tint = MaterialTheme.colorScheme.primary) else ReachPill(m.probes[p.id]) },
          colors = ListItemDefaults.colors(containerColor = if (current) MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f) else Color.Transparent),
        )
      }
      HorizontalDivider(Modifier.padding(vertical = 8.dp))
      ListItem(
        modifier = Modifier.clickable { close(); a.home() },
        leadingContent = { Icon(Icons.Filled.Home, null) },
        headlineContent = { Text("全部服务器") },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
      )
    }
  }
}

// ---- connecting ----

/** Each step on the way to the page; a failure says where, why, and what to do about it. */
@Composable
fun ConnectingScreen(m: AppModel, a: Actions, p: Profile) {
  val steps = if (p.isDirect) {
    listOf("连接服务器" to (p.directBase ?: p.directUrl), "打开网页" to "加载 tmux-web")
  } else {
    listOf(
      "SSH 登录" to "${p.host}:${p.sshPort}",
      "端口转发" to "手机 ${p.localPort} → 服务器 ${p.remoteHost}:${p.remotePort}",
      "打开网页" to "加载 tmux-web",
    )
  }
  val t = m.tunnel
  val error: String? = (t as? TunnelState.Failed)?.message ?: (m.page as? PageLoad.Failed)?.message
  val at = when {
    t is TunnelState.Failed -> m.step.coerceAtMost(steps.lastIndex)
    m.page is PageLoad.Failed || t is TunnelState.Ready -> steps.lastIndex
    t is TunnelState.Connecting -> t.step.coerceAtMost(steps.lastIndex)
    else -> 0
  }
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(error, m.startedAt) {
    while (error == null) {
      now = System.currentTimeMillis()
      delay(1000)
    }
  }

  Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
      Column(Modifier.widthIn(max = 460.dp).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ServerAvatar(p, 64.dp)
        Spacer(Modifier.size(14.dp))
        Text(p.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Text(middleEllipsis(p.address, 44), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.size(24.dp))

        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
          Column(Modifier.padding(vertical = 8.dp)) {
            steps.forEachIndexed { i, (label, detail) ->
              val state = when {
                i < at -> StepState.Done
                i == at && error != null -> StepState.Failed
                i == at && t is TunnelState.Reconnecting -> StepState.Active
                i == at -> StepState.Active
                else -> StepState.Waiting
              }
              // while logging in: questions (a code, a password) come up as a dialog
              val hint = if (state == StepState.Active && i == 0 && !p.isDirect) "$detail · 需要验证码或密码时会弹框" else detail
              StepRow(label, hint.takeIf { state == StepState.Active || state == StepState.Failed }, state)
            }
          }
        }

        Spacer(Modifier.size(20.dp))
        if (error == null) {
          val secs = ((now - m.startedAt) / 1000).coerceAtLeast(0)
          Text(if (t is TunnelState.Reconnecting) t.message else "已用 $secs 秒", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Spacer(Modifier.size(12.dp))
          OutlinedButton(onClick = { a.disconnect() }) { Text("取消") }
        } else {
          FailureCard(error, failedPage = m.page is PageLoad.Failed, a = a, p = p)
        }
      }
    }
  }
}

private enum class StepState { Done, Active, Failed, Waiting }

@Composable
private fun StepRow(label: String, detail: String?, state: StepState) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(26.dp), contentAlignment = Alignment.Center) {
      when (state) {
        StepState.Done -> Box(Modifier.size(22.dp).clip(CircleShape).background(StateColor.ok), contentAlignment = Alignment.Center) {
          Icon(Icons.Filled.Check, null, tint = Color.White, modifier = Modifier.size(15.dp))
        }
        StepState.Active -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.5.dp)
        StepState.Failed -> Box(Modifier.size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.error), contentAlignment = Alignment.Center) {
          Text("!", color = MaterialTheme.colorScheme.onError, fontWeight = FontWeight.Bold)
        }
        StepState.Waiting -> Box(Modifier.size(18.dp).clip(CircleShape).border(2.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape))
      }
    }
    Spacer(Modifier.size(14.dp))
    Column(Modifier.weight(1f)) {
      Text(
        label, style = MaterialTheme.typography.bodyLarge,
        fontWeight = if (state == StepState.Active || state == StepState.Failed) FontWeight.SemiBold else null,
        color = if (state == StepState.Waiting) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
      )
      if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/** a failure in words, what to do, the raw message folded away */
@Composable
private fun FailureCard(error: String, failedPage: Boolean, a: Actions, p: Profile) {
  val (title, hint) = explain(error, failedPage, p)
  var details by remember { mutableStateOf(false) }
  Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(18.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
        Spacer(Modifier.size(10.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onErrorContainer)
      }
      Spacer(Modifier.size(8.dp))
      Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
      Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable { details = !details }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("详细信息", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onErrorContainer)
        Icon(if (details) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, tint = MaterialTheme.colorScheme.onErrorContainer)
      }
      AnimatedVisibility(details) {
        SelectionContainer {
          Text(
            error, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.6f)).horizontalScroll(rememberScrollState()).padding(10.dp),
            fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
          )
        }
      }
    }
  }
  Spacer(Modifier.size(16.dp))
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
    TextButton(onClick = { a.disconnect() }) { Text("返回首页") }
    OutlinedButton(onClick = { a.edit(Screen.Editor(id = p.id)) }) { Text("编辑服务器") }
    Button(onClick = { a.retry() }) { Text("重试") }
  }
}

/** the usual reasons, said plainly, with what helps */
fun explain(msg: String, failedPage: Boolean, p: Profile): Pair<String, String> = when {
  failedPage -> "网页打不开" to
    if (p.isDirect) "服务器有响应，但页面没加载出来。刷新试试，或者确认网址就是 tmux-web 的地址。"
    else "SSH 已经连上，但服务器上的 ${p.remoteHost}:${p.remotePort} 没有响应。确认 tmux-web 在运行，端口填对（默认 8080）。"
  msg.contains("地址不对") -> "网址不对" to "填完整的网址，比如 http://10.126.126.2:8080。"
  msg.contains("找不到主机") -> "找不到服务器" to "检查地址有没有拼错，以及手机是否连上了能访问它的网络（EasyTier、VPN、局域网）。"
  msg.contains("超时") || msg.contains("timed out", true) -> "连接超时" to "服务器没有响应：确认地址和端口对、服务器开着，手机的网络能到达它。"
  msg.contains("拒绝") || msg.contains("refused", true) -> "连接被拒绝" to
    if (p.isDirect) "这个地址的端口上没有服务。确认 tmux-web 在运行、端口没填错。" else "SSH 端口上没有服务，确认 SSH 端口（一般是 22）。"
  msg.contains("登录失败") -> "登录失败" to "密码、私钥或私钥口令不对，或者服务器不接受这种登录方式。编辑服务器检查一下。"
  msg.contains("主机密钥") -> "服务器身份变了" to "如果服务器重装过，在「编辑服务器 → 高级」里点「忘记主机密钥」再重试；否则可能有人冒充，先别连。"
  msg.contains("本地端口") -> "本地端口被占用" to "在「编辑服务器 → 高级」里换一个本地端口，或者关掉占用它的其他 App。"
  msg.contains("已取消") -> "已取消" to "输入验证码或密码时取消了。"
  msg.contains("没有设置") -> "还没设置好" to "编辑这台服务器，把连接信息填完整。"
  else -> "连接失败" to "看看下面的详细信息；需要的话编辑服务器检查设置。"
}

// ---- ssh asks something ----

@Composable
fun QuestionDialog(q: Hub.Question, a: Actions) {
  var text by remember(q) { mutableStateOf("") }
  androidx.compose.material3.AlertDialog(
    onDismissRequest = {},
    title = { Text("SSH 验证") },
    text = {
      Column {
        Text(q.prompt, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.size(12.dp))
        SecretField(text, { text = it }, label = if (q.secret) "密码 / 验证码" else "回答", secret = q.secret, autoFocus = true)
      }
    },
    confirmButton = { TextButton(onClick = { a.answer(q, text) }) { Text("确定") } },
    dismissButton = { TextButton(onClick = { a.answer(q, null) }) { Text("取消") } },
  )
}
