package com.zheqiushui.tmuxweb

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** The servers as cards, the recent ones first; a tap connects (or goes back to its page). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(m: AppModel, a: Actions) {
  val activity = LocalContext.current as android.app.Activity
  // the app stays in the background (the forward and the alerts with it)
  BackHandler { activity.moveTaskToBack(true) }
  var searching by remember { mutableStateOf(false) }
  var query by remember { mutableStateOf("") }
  var sheet by remember { mutableStateOf<Profile?>(null) }
  var deleting by remember { mutableStateOf<Profile?>(null) }
  var about by remember { mutableStateOf(false) }
  val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())

  // reachability: when the screen shows, then every half minute while it's in front
  LaunchedEffect(m.resumed, m.profiles.size) {
    while (m.resumed) {
      a.probeAll()
      delay(30_000)
    }
  }

  val q = query.trim().lowercase()
  val list = m.profiles
    .filter { q.isEmpty() || "${it.title} ${it.address}".lowercase().contains(q) }
    .sortedWith(compareByDescending<Profile> { it.lastUsed })

  Scaffold(
    modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
    topBar = {
      if (searching) {
        BackHandler { searching = false; query = "" }
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { focus.requestFocus() }
        TopAppBar(
          navigationIcon = { IconButton(onClick = { searching = false; query = "" }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "结束搜索") } },
          title = {
            TextField(
              query, { query = it }, Modifier.fillMaxWidth().focusRequester(focus),
              placeholder = { Text("搜索名称或地址") }, singleLine = true,
              keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
              colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
              ),
            )
          },
          actions = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "清除") } },
        )
      } else {
        LargeTopAppBar(
          title = {
            Column {
              Text("服务器", fontWeight = FontWeight.SemiBold)
            }
          },
          actions = {
            if (m.profiles.isNotEmpty()) IconButton(onClick = { searching = true }) { Icon(Icons.Filled.Search, "搜索") }
            Box {
              var menu by remember { mutableStateOf(false) }
              IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
              DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("私钥") }, leadingIcon = { Icon(KeyIcon, null) }, onClick = { menu = false; a.keys() })
                DropdownMenuItem(text = { Text("共享配置") }, leadingIcon = { Icon(ShareIcon, null) }, onClick = { menu = false; a.share() })
                DropdownMenuItem(text = { Text("检查更新") }, leadingIcon = { Icon(UpdateIcon, null) }, onClick = { menu = false; a.checkUpdates() })
                DropdownMenuItem(text = { Text("关于") }, leadingIcon = { Icon(Icons.Filled.Info, null) }, onClick = { menu = false; about = true })
              }
            }
          },
          scrollBehavior = scroll,
        )
      }
    },
    floatingActionButton = {
      if (m.profiles.isNotEmpty()) {
        ExtendedFloatingActionButton(onClick = { a.edit(Screen.Editor()) }, icon = { Icon(Icons.Filled.Add, null) }, text = { Text("新建服务器") })
      }
    },
  ) { pad ->
    if (m.profiles.isEmpty()) {
      EmptyHome(a, Modifier.padding(pad))
      return@Scaffold
    }
    // the spinner only for a pull (the half-minute checks run quietly)
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(m.probing) { if (m.probing == 0) pulled = false }
    PullToRefreshBox(isRefreshing = pulled && m.probing > 0, onRefresh = { pulled = true; a.probeAll() }, modifier = Modifier.padding(pad).fillMaxSize()) {
      LazyVerticalGrid(
        columns = GridCells.Adaptive(320.dp),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 104.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxSize(),
      ) {
        items(list, key = { it.id }) { p ->
          ServerCard(
            p, m.probes[p.id], if (p.id == m.activeId) m.tunnel to m.page else null,
            onOpen = { a.connect(p) }, onMore = { sheet = p }, onDisconnect = { a.disconnect() },
          )
        }
        if (list.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
          Text("没有找到「$query」", Modifier.padding(32.dp), textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item(span = { GridItemSpan(maxLineSpan) }) { Footer(a) }
      }
    }
  }

  sheet?.let { p ->
    ServerActionsSheet(p, close = { sheet = null }, a = a, onDelete = { sheet = null; deleting = p })
  }
  deleting?.let { p ->
    ConfirmDelete(p, onDismiss = { deleting = null }) { deleting = null; a.remove(p) }
  }
  if (about) AboutDialog(a) { about = false }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ServerCard(
  p: Profile, probe: Probe.Result?, state: Pair<TunnelState, PageLoad>?,
  onOpen: () -> Unit, onMore: () -> Unit, onDisconnect: () -> Unit,
) {
  val active = state != null && state.first !is TunnelState.Idle
  val shape = RoundedCornerShape(22.dp)
  Surface(
    shape = shape,
    color = if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
    tonalElevation = if (active) 0.dp else 1.dp,
    modifier = Modifier.fillMaxWidth().clip(shape).combinedClickable(onClick = onOpen, onLongClick = onMore),
  ) {
    Column(Modifier.padding(start = 16.dp, top = 16.dp, end = 6.dp, bottom = 14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        ServerAvatar(p)
        Spacer(Modifier.size(14.dp))
        Column(Modifier.weight(1f)) {
          Text(p.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(middleEllipsis(p.address), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onMore) { Icon(Icons.Filled.MoreVert, "更多") }
      }
      Spacer(Modifier.size(12.dp))
      Row(Modifier.padding(end = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Pill(if (p.isDirect) "直接访问" else if (p.isEasyTier) "内置 EasyTier" else "SSH 转发")
        ReachPill(probe)
        Spacer(Modifier.weight(1f))
        Text(ago(p.lastUsed), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
      }
      if (active) {
        val (t, page) = state!!
        Spacer(Modifier.size(10.dp))
        HorizontalDivider(Modifier.padding(end = 10.dp), color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.12f))
        Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
          Dot(stateColor(t, page))
          Spacer(Modifier.size(8.dp))
          Text(
            when {
              t is TunnelState.Failed || page is PageLoad.Failed -> "连接失败"
              t is TunnelState.Reconnecting -> "正在重新连接"
              t is TunnelState.Ready && page is PageLoad.Loaded -> "已连接 · 点卡片回到页面"
              else -> "正在连接…"
            },
            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.weight(1f),
          )
          TextButton(onClick = onDisconnect) { Text("断开") }
        }
      }
    }
  }
}

/** 检测中 / 在线 · 23 ms / 离线 */
@Composable
fun ReachPill(r: Probe.Result?) {
  when (r) {
    null, Probe.Result.Checking -> Pill("检测中", dot = StateColor.off)
    is Probe.Result.Up -> Pill("在线 · ${r.ms} ms", dot = StateColor.ok)
    is Probe.Result.Down -> Pill("离线", dot = StateColor.bad)
    is Probe.Result.Unknown -> Pill("连接时检测", dot = StateColor.off)
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ServerActionsSheet(p: Profile, close: () -> Unit, a: Actions, onDelete: () -> Unit) {
  ModalBottomSheet(onDismissRequest = close) {
    Row(Modifier.padding(horizontal = 24.dp).padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
      ServerAvatar(p, 48.dp)
      Spacer(Modifier.size(14.dp))
      Column {
        Text(p.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(middleEllipsis(p.address, 44), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    HorizontalDivider()
    val item = @Composable { icon: ImageVector, label: String, color: Color?, action: () -> Unit ->
      ListItem(
        modifier = Modifier.clickable { action() },
        leadingContent = { Icon(icon, null, tint = color ?: MaterialTheme.colorScheme.onSurfaceVariant) },
        headlineContent = { Text(label, color = color ?: MaterialTheme.colorScheme.onSurface) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
      )
    }
    Column(Modifier.navigationBarsPadding().padding(vertical = 8.dp).padding(bottom = 16.dp)) {
      item(Icons.Filled.PlayArrow, "连接", null) { close(); a.connect(p) }
      item(Icons.Filled.Edit, "编辑", null) { close(); a.edit(Screen.Editor(id = p.id)) }
      item(CopyIcon, "复制一份", null) { close(); a.edit(Screen.Editor(copyOf = p.id)) }
      item(Icons.Filled.Delete, "删除", MaterialTheme.colorScheme.error) { onDelete() }
    }
  }
}

@Composable
fun ConfirmDelete(p: Profile, onDismiss: () -> Unit, onConfirm: () -> Unit) {
  AlertDialog(
    onDismissRequest = onDismiss,
    icon = { Icon(Icons.Filled.Delete, null) },
    title = { Text("删除「${p.title}」？") },
    text = { Text(if (p.keyId.isEmpty()) "它的设置和保存的密码都会删掉，不能恢复。" else "它的设置和保存的密码都会删掉，不能恢复。用的私钥还留在「私钥」里。") },
    confirmButton = { TextButton(onClick = onConfirm) { Text("删除", color = MaterialTheme.colorScheme.error) } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
  )
}

/** nothing yet: the ways in, each a big choice */
@Composable
private fun EmptyHome(a: Actions, modifier: Modifier) {
  Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
    Column(Modifier.widthIn(max = 560.dp).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Spacer(Modifier.size(24.dp))
      Box(Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
        Icon(DnsIcon, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
      }
      Spacer(Modifier.size(20.dp))
      Text("还没有服务器", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
      Spacer(Modifier.size(8.dp))
      Text(
        "添加一台运行 tmux-web 的服务器。先选怎么连过去：",
        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
      )
      Spacer(Modifier.size(24.dp))
      ChoiceCard(LanIcon, Color(0xFF13A3A0), "直接访问", "EasyTier、局域网、VPN 里能直接打开网址时用") { a.edit(Screen.Editor(mode = "direct")) }
      Spacer(Modifier.size(12.dp))
      ChoiceCard(LinkIcon, Color(0xFF2F6FDE), "内置 EasyTier", "App 自己加入 EasyTier 网络，不用另开 App，也不占用系统 VPN") { a.edit(Screen.Editor(mode = "easytier")) }
      Spacer(Modifier.size(12.dp))
      ChoiceCard(TerminalIcon, Color(0xFF5B5BD6), "SSH 转发", "通过 SSH 登录服务器，把 tmux-web 转发到手机上，不用开放端口") { a.edit(Screen.Editor(mode = "ssh")) }
      Spacer(Modifier.size(24.dp))
      Footer(a)
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChoiceCard(icon: ImageVector, color: Color, title: String, text: String, onClick: () -> Unit) {
  val shape = RoundedCornerShape(20.dp)
  Surface(shape = shape, color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 1.dp, modifier = Modifier.fillMaxWidth().clip(shape).combinedClickable(onClick = onClick)) {
    Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
      Box(Modifier.size(48.dp).clip(RoundedCornerShape(14.dp)).background(color), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(26.dp))
      }
      Spacer(Modifier.size(16.dp))
      Column(Modifier.weight(1f)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Icon(Icons.Filled.Add, null, tint = MaterialTheme.colorScheme.primary)
    }
  }
}

@Composable
private fun Footer(a: Actions) {
  Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
    Text("tmux-web ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    TextButton(onClick = { a.checkUpdates() }) { Text("检查更新") }
  }
}

@Composable
private fun AboutDialog(a: Actions, close: () -> Unit) {
  AlertDialog(
    onDismissRequest = close,
    icon = { Icon(TerminalIcon, null) },
    title = { Text("tmux-web") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("版本 ${BuildConfig.VERSION_NAME}", fontWeight = FontWeight.SemiBold)
        Text("在手机上使用服务器上的 Claude Code / Codex 会话：直接打开 tmux-web 的网页，或者通过内置 EasyTier、SSH 转发过去。")
        Text("开源项目（MIT），按现状提供。安装包只从项目的 GitHub Release 下载。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    },
    confirmButton = { TextButton(onClick = close) { Text("好") } },
    dismissButton = { TextButton(onClick = { close(); a.openUrl("https://github.com/ZHEQIUSHUI/tmux-web") }) { Text("GitHub") } },
  )
}
