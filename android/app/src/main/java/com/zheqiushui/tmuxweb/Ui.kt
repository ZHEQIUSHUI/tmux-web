package com.zheqiushui.tmuxweb

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ---- theme: the wallpaper's colors on Android 12+, tmux-web's blue before that ----

private val Light = lightColorScheme(
  primary = Color(0xFF2F6FDE), onPrimary = Color.White,
  primaryContainer = Color(0xFFDCE6FF), onPrimaryContainer = Color(0xFF0B2A66),
  secondary = Color(0xFF555F71), secondaryContainer = Color(0xFFD9E3F8), onSecondaryContainer = Color(0xFF121C2B),
  background = Color(0xFFF7F8FB), surface = Color(0xFFF7F8FB),
  surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF1F3F8), surfaceContainer = Color(0xFFEBEEF4),
  surfaceContainerHigh = Color(0xFFE5E8EF), surfaceContainerHighest = Color(0xFFDFE2EA),
)
private val Dark = darkColorScheme(
  primary = Color(0xFFADC6FF), onPrimary = Color(0xFF002E69),
  primaryContainer = Color(0xFF1E4A9C), onPrimaryContainer = Color(0xFFDCE6FF),
  secondary = Color(0xFFBDC7DC), secondaryContainer = Color(0xFF3E4759), onSecondaryContainer = Color(0xFFD9E3F8),
  background = Color(0xFF111318), surface = Color(0xFF111318),
  surfaceContainerLowest = Color(0xFF0C0E13), surfaceContainerLow = Color(0xFF191C20), surfaceContainer = Color(0xFF1D2024),
  surfaceContainerHigh = Color(0xFF272A2F), surfaceContainerHighest = Color(0xFF32353A),
)

@Composable
fun TmuxTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  val ctx = LocalContext.current
  val scheme = when {
    Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    dark -> Dark
    else -> Light
  }
  MaterialTheme(colorScheme = scheme, content = content)
}

/** connection colors, the same as the web page's status dots */
object StateColor {
  val ok = Color(0xFF2F9E5B)
  val busy = Color(0xFFD99A17)
  val bad = Color(0xFFE0503A)
  val off = Color(0xFF9AA0A6)
}

// ---- small pieces used on several screens ----

/** The server's letter on a rounded square: teal for direct access, indigo for SSH. */
@Composable
fun ServerAvatar(p: Profile, size: Dp = 44.dp) {
  Box(
    Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(if (p.isDirect) Color(0xFF13A3A0) else Color(0xFF5B5BD6)),
    contentAlignment = Alignment.Center,
  ) {
    Text(p.title.trim().take(1).uppercase().ifEmpty { "?" }, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.42f).sp)
  }
}

@Composable
fun Dot(color: Color, size: Dp = 8.dp) = Box(Modifier.size(size).clip(CircleShape).background(color))

/** a small rounded label: the mode, the reachability */
@Composable
fun Pill(text: String, dot: Color? = null, container: Color = MaterialTheme.colorScheme.surfaceContainerHighest, content: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
  Surface(shape = RoundedCornerShape(50), color = container) {
    Row(Modifier.padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      if (dot != null) Dot(dot, 6.dp)
      Text(text, style = MaterialTheme.typography.labelMedium, color = content)
    }
  }
}

/** "qiushui@a-very-long-host.example.com → 8080" → "qiushui@a-very…com → 8080" */
fun middleEllipsis(s: String, max: Int = 38): String = if (s.length <= max) s else s.take(max / 2 - 1) + "…" + s.takeLast(max / 2 - 1)

fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
  if (ms <= 0) return "还没用过"
  val m = (now - ms) / 60_000
  return when {
    m < 1 -> "刚刚用过"
    m < 60 -> "$m 分钟前用过"
    m < 24 * 60 -> "${m / 60} 小时前用过"
    m < 30 * 24 * 60 -> "${m / 60 / 24} 天前用过"
    else -> "很久以前用过"
  }
}

// icons the small core icon set doesn't have

val EyeIcon: ImageVector = materialIcon("Eye") {
  materialPath {
    moveTo(12f, 4.5f); curveTo(7f, 4.5f, 2.73f, 7.61f, 1f, 12f); curveToRelative(1.73f, 4.39f, 6f, 7.5f, 11f, 7.5f)
    reflectiveCurveToRelative(9.27f, -3.11f, 11f, -7.5f); curveToRelative(-1.73f, -4.39f, -6f, -7.5f, -11f, -7.5f); close()
    moveTo(12f, 17f); curveToRelative(-2.76f, 0f, -5f, -2.24f, -5f, -5f); reflectiveCurveToRelative(2.24f, -5f, 5f, -5f)
    reflectiveCurveToRelative(5f, 2.24f, 5f, 5f); reflectiveCurveToRelative(-2.24f, 5f, -5f, 5f); close()
    moveTo(12f, 9f); curveToRelative(-1.66f, 0f, -3f, 1.34f, -3f, 3f); reflectiveCurveToRelative(1.34f, 3f, 3f, 3f)
    reflectiveCurveToRelative(3f, -1.34f, 3f, -3f); reflectiveCurveToRelative(-1.34f, -3f, -3f, -3f); close()
  }
}

val EyeOffIcon: ImageVector = materialIcon("EyeOff") {
  materialPath {
    moveTo(12f, 7f); curveToRelative(2.76f, 0f, 5f, 2.24f, 5f, 5f); curveToRelative(0f, 0.65f, -0.13f, 1.26f, -0.36f, 1.83f)
    lineToRelative(2.92f, 2.92f); curveToRelative(1.51f, -1.26f, 2.7f, -2.89f, 3.43f, -4.75f)
    curveToRelative(-1.73f, -4.39f, -6f, -7.5f, -11f, -7.5f); curveToRelative(-1.4f, 0f, -2.74f, 0.25f, -3.98f, 0.7f)
    lineToRelative(2.16f, 2.16f); curveTo(10.74f, 7.13f, 11.35f, 7f, 12f, 7f); close()
    moveTo(2f, 4.27f); lineToRelative(2.28f, 2.28f); lineToRelative(0.46f, 0.46f); curveTo(3.08f, 8.3f, 1.78f, 10.02f, 1f, 12f)
    curveToRelative(1.73f, 4.39f, 6f, 7.5f, 11f, 7.5f); curveToRelative(1.55f, 0f, 3.03f, -0.3f, 4.38f, -0.84f)
    lineToRelative(0.42f, 0.42f); lineTo(19.73f, 22f); lineTo(21f, 20.73f); lineTo(3.27f, 3f); lineTo(2f, 4.27f); close()
    moveTo(7.53f, 9.8f); lineToRelative(1.55f, 1.55f); curveToRelative(-0.05f, 0.21f, -0.08f, 0.43f, -0.08f, 0.65f)
    curveToRelative(0f, 1.66f, 1.34f, 3f, 3f, 3f); curveToRelative(0.22f, 0f, 0.44f, -0.03f, 0.65f, -0.08f)
    lineToRelative(1.55f, 1.55f); curveToRelative(-0.67f, 0.33f, -1.41f, 0.53f, -2.2f, 0.53f)
    curveToRelative(-2.76f, 0f, -5f, -2.24f, -5f, -5f); curveToRelative(0f, -0.79f, 0.2f, -1.53f, 0.53f, -2.2f); close()
  }
}

/** a globe: direct access */
val LanIcon: ImageVector = materialIcon("Lan") {
  materialPath {
    moveTo(12f, 2f); curveTo(6.48f, 2f, 2f, 6.48f, 2f, 12f); reflectiveCurveToRelative(4.48f, 10f, 10f, 10f)
    reflectiveCurveToRelative(10f, -4.48f, 10f, -10f); reflectiveCurveTo(17.52f, 2f, 12f, 2f); close()
    moveTo(19.93f, 11f); horizontalLineToRelative(-3.02f); curveToRelative(-0.1f, -2.13f, -0.52f, -4.1f, -1.18f, -5.6f)
    curveToRelative(2.21f, 1.03f, 3.84f, 3.12f, 4.2f, 5.6f); close()
    moveTo(12f, 4.04f); curveToRelative(0.83f, 1.2f, 1.75f, 3.68f, 1.9f, 6.96f); horizontalLineToRelative(-3.8f)
    curveToRelative(0.15f, -3.28f, 1.07f, -5.76f, 1.9f, -6.96f); close()
    moveTo(8.27f, 5.4f); curveTo(7.61f, 6.9f, 7.19f, 8.87f, 7.09f, 11f); horizontalLineTo(4.07f)
    curveToRelative(0.36f, -2.48f, 1.99f, -4.57f, 4.2f, -5.6f); close()
    moveTo(4.07f, 13f); horizontalLineToRelative(3.02f); curveToRelative(0.1f, 2.13f, 0.52f, 4.1f, 1.18f, 5.6f)
    curveToRelative(-2.21f, -1.03f, -3.84f, -3.12f, -4.2f, -5.6f); close()
    moveTo(12f, 19.96f); curveToRelative(-0.83f, -1.2f, -1.75f, -3.68f, -1.9f, -6.96f); horizontalLineToRelative(3.8f)
    curveToRelative(-0.15f, 3.28f, -1.07f, 5.76f, -1.9f, 6.96f); close()
    moveTo(15.73f, 18.6f); curveToRelative(0.66f, -1.5f, 1.08f, -3.47f, 1.18f, -5.6f); horizontalLineToRelative(3.02f)
    curveToRelative(-0.36f, 2.48f, -1.99f, 4.57f, -4.2f, 5.6f); close()
  }
}

/** a terminal prompt in a box: SSH */
val TerminalIcon: ImageVector = materialIcon("Terminal") {
  materialPath {
    moveTo(20f, 4f); horizontalLineTo(4f); curveToRelative(-1.11f, 0f, -2f, 0.9f, -2f, 2f); verticalLineToRelative(12f)
    curveToRelative(0f, 1.1f, 0.89f, 2f, 2f, 2f); horizontalLineToRelative(16f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f)
    verticalLineTo(6f); curveToRelative(0f, -1.1f, -0.89f, -2f, -2f, -2f); close()
    moveTo(20f, 18f); horizontalLineTo(4f); verticalLineTo(8f); horizontalLineToRelative(16f); verticalLineToRelative(10f); close()
    moveTo(18f, 17f); horizontalLineToRelative(-6f); verticalLineToRelative(-2f); horizontalLineToRelative(6f); verticalLineToRelative(2f); close()
    moveTo(7.5f, 17f); lineToRelative(-1.41f, -1.41f); lineTo(8.67f, 13f); lineToRelative(-2.59f, -2.59f)
    lineTo(7.5f, 9f); lineToRelative(4f, 4f); lineToRelative(-4f, 4f); close()
  }
}

/** a server rack: the empty home screen */
val DnsIcon: ImageVector = materialIcon("Dns") {
  materialPath {
    moveTo(20f, 13f); horizontalLineTo(4f); curveToRelative(-0.55f, 0f, -1f, 0.45f, -1f, 1f); verticalLineToRelative(6f)
    curveToRelative(0f, 0.55f, 0.45f, 1f, 1f, 1f); horizontalLineToRelative(16f); curveToRelative(0.55f, 0f, 1f, -0.45f, 1f, -1f)
    verticalLineToRelative(-6f); curveToRelative(0f, -0.55f, -0.45f, -1f, -1f, -1f); close()
    moveTo(7f, 19f); curveToRelative(-1.1f, 0f, -2f, -0.9f, -2f, -2f); reflectiveCurveToRelative(0.9f, -2f, 2f, -2f)
    reflectiveCurveToRelative(2f, 0.9f, 2f, 2f); reflectiveCurveToRelative(-0.9f, 2f, -2f, 2f); close()
    moveTo(20f, 3f); horizontalLineTo(4f); curveToRelative(-0.55f, 0f, -1f, 0.45f, -1f, 1f); verticalLineToRelative(6f)
    curveToRelative(0f, 0.55f, 0.45f, 1f, 1f, 1f); horizontalLineToRelative(16f); curveToRelative(0.55f, 0f, 1f, -0.45f, 1f, -1f)
    verticalLineTo(4f); curveToRelative(0f, -0.55f, -0.45f, -1f, -1f, -1f); close()
    moveTo(7f, 9f); curveToRelative(-1.1f, 0f, -2f, -0.9f, -2f, -2f); reflectiveCurveToRelative(0.9f, -2f, 2f, -2f)
    reflectiveCurveToRelative(2f, 0.9f, 2f, 2f); reflectiveCurveToRelative(-0.9f, 2f, -2f, 2f); close()
  }
}

/** a key: the private key field */
val KeyIcon: ImageVector = materialIcon("Key") {
  materialPath {
    moveTo(12.65f, 10f); curveTo(11.83f, 7.67f, 9.61f, 6f, 7f, 6f); curveToRelative(-3.31f, 0f, -6f, 2.69f, -6f, 6f)
    reflectiveCurveToRelative(2.69f, 6f, 6f, 6f); curveToRelative(2.61f, 0f, 4.83f, -1.67f, 5.65f, -4f)
    horizontalLineTo(17f); verticalLineToRelative(4f); horizontalLineToRelative(4f); verticalLineToRelative(-4f)
    horizontalLineToRelative(2f); verticalLineToRelative(-4f); horizontalLineTo(12.65f); close()
    moveTo(7f, 14f); curveToRelative(-1.1f, 0f, -2f, -0.9f, -2f, -2f); reflectiveCurveToRelative(0.9f, -2f, 2f, -2f)
    reflectiveCurveToRelative(2f, 0.9f, 2f, 2f); reflectiveCurveToRelative(-0.9f, 2f, -2f, 2f); close()
  }
}

/** a 24×24 icon from an SVG path (Material's own shapes) */
fun pathIcon(name: String, d: String): ImageVector =
  ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black))
    .build()

val CopyIcon = pathIcon("Copy", "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z")
val LinkOffIcon = pathIcon("LinkOff", "M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16zM2 4.27l3.11 3.11C3.29 8.12 2 9.91 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z")
val UpdateIcon = pathIcon("Update", "M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.53-9.11-.02-12.58s9.14-3.47 12.65 0L21 3v7.12z")
val UploadFileIcon = pathIcon("FileOpen", "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 15.01l1.41 1.41L11 14.84V19h2v-4.16l1.59 1.59L16 15.01 12.01 11z")
val NetworkCheckIcon = pathIcon("NetworkCheck", "M15.9 5c-.17 0-.32.09-.41.23l-.07.15-5.18 11.65c-.16.29-.26.61-.26.96 0 1.11.9 2.01 2.01 2.01.96 0 1.77-.68 1.96-1.59l.01-.03L16.4 5.5c0-.28-.22-.5-.5-.5zM1 9l2 2c2.88-2.88 6.79-4.08 10.53-3.62l1.19-2.68C9.89 3.84 4.74 5.27 1 9zm20 2l2-2c-1.64-1.64-3.55-2.82-5.59-3.57l-.53 2.82c1.5.62 2.9 1.53 4.12 2.75zm-4 4l2-2c-.8-.8-1.7-1.42-2.66-1.89l-.55 2.92c.42.27.83.59 1.21.97zM5 13l2 2c1.13-1.13 2.56-1.79 4.03-2l1.28-2.88c-2.63-.08-5.3.87-7.31 2.88z")
val ShareIcon = pathIcon("Share", "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z")
