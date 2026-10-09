package com.zheqiushui.tmuxweb

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.method.PasswordTransformationMethod
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView

/**
 * The first screen: every server as a card. A tap connects (or goes back to the page of the one
 * already connected); ⋮ or a long press edits, copies, deletes. Phones get one column, tablets more.
 */
class ServerList(private val a: Activity, private val dark: Boolean, private val actions: Actions) {
  interface Actions {
    fun connect(p: Profile)
    /** null: a new one */
    fun edit(p: Profile?)
    fun duplicate(p: Profile)
    fun remove(p: Profile)
    fun disconnect()
  }

  val bg = if (dark) Color.parseColor("#16181d") else Color.parseColor("#f3f4f6")
  private val cardBg = if (dark) Color.parseColor("#20232a") else Color.WHITE
  private val line = if (dark) Color.parseColor("#2e323a") else Color.parseColor("#e2e5e9")
  private val fg = if (dark) Color.parseColor("#d8dce3") else Color.parseColor("#1f2328")
  private val dim = if (dark) Color.parseColor("#8b93a1") else Color.parseColor("#6a737d")
  private val accent = Color.parseColor("#3b82f6")

  val view = ScrollView(a).apply { isFillViewport = true; setBackgroundColor(bg) }

  fun render(profiles: List<Profile>, activeId: String?, state: TunnelState) {
    val col = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(14), dp(16), dp(24)) }
    view.removeAllViews()
    view.addView(col, MATCH_PARENT, WRAP_CONTENT)

    val head = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), 0, 0, dp(12)) }
    head.addView(TextView(a).apply { text = "服务器"; textSize = 22f; setTypeface(typeface, Typeface.BOLD); setTextColor(fg) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    if (activeId != null) head.addView(link("断开") { actions.disconnect() })
    head.addView(link("＋ 新建") { actions.edit(null) })
    col.addView(head)

    if (profiles.isEmpty()) {
      col.addView(TextView(a).apply {
        text = "还没有服务器\n\n添加一台运行 tmux-web 的服务器：能直接访问（EasyTier、局域网）就填网址，否则通过 SSH 转发。"
        textSize = 14f; setTextColor(dim); gravity = Gravity.CENTER; setPadding(dp(24), dp(60), dp(24), dp(20))
      })
      col.addView(addCard())
      return
    }

    // one column on a phone, two or three on a tablet
    val w = a.resources.configuration.screenWidthDp
    val n = if (w >= 900) 3 else if (w >= 600) 2 else 1
    val cards = profiles.map { card(it, if (it.id == activeId) state else null) } + addCard()
    cards.chunked(n).forEach { rowCards ->
      val row = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL }
      for (i in 0 until n) {
        // an empty cell: a Space (a plain View would take all the height there is)
        val c = rowCards.getOrNull(i) ?: Space(a)
        row.addView(c, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f).apply { setMargins(if (i == 0) 0 else dp(6), 0, if (i == n - 1) 0 else dp(6), dp(12)) })
      }
      col.addView(row, MATCH_PARENT, WRAP_CONTENT)
    }
  }

  private fun card(p: Profile, state: TunnelState?): View {
    val c = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(12), dp(6), dp(12)) }
    c.background = surface(state != null)

    val top = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    val badge = TextView(a).apply {
      text = p.title.trim().take(1).uppercase().ifEmpty { "?" }
      textSize = 16f; setTypeface(typeface, Typeface.BOLD); setTextColor(Color.WHITE); gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = dp(9).toFloat(); setColor(Color.parseColor(if (p.isDirect) "#14a3a3" else "#5b5bd6")) }
    }
    top.addView(badge, LinearLayout.LayoutParams(dp(38), dp(38)))
    val names = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, dp(4), 0) }
    names.addView(TextView(a).apply { text = p.title; textSize = 16f; setTypeface(typeface, Typeface.BOLD); setTextColor(fg); isSingleLine = true; ellipsize = TextUtils.TruncateAt.END })
    names.addView(TextView(a).apply { text = p.address; textSize = 13f; setTextColor(dim); isSingleLine = true; ellipsize = TextUtils.TruncateAt.MIDDLE })
    top.addView(names, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    val more = TextView(a).apply {
      text = "⋮"; textSize = 20f; setTextColor(dim); gravity = Gravity.CENTER
      setOnClickListener { menu(it, p) }
    }
    top.addView(more, LinearLayout.LayoutParams(dp(40), dp(40)))
    c.addView(top)

    val bottom = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10), dp(8), 0) }
    bottom.addView(TextView(a).apply {
      text = if (p.isDirect) "直接访问" else "SSH 转发"
      textSize = 12f; setTextColor(dim); setPadding(dp(8), dp(2), dp(8), dp(2))
      background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(if (dark) Color.parseColor("#2a2e36") else Color.parseColor("#eef0f3")) }
    })
    bottom.addView(View(a), LinearLayout.LayoutParams(0, 1, 1f))
    if (state != null) {
      val (label, color) = when (state) {
        is TunnelState.Ready -> "● 已连接" to Color.parseColor("#2f9e5b")
        is TunnelState.Failed -> "● 连接失败" to Color.parseColor("#e0503a")
        is TunnelState.Reconnecting -> "重新连接中…" to Color.parseColor("#d99a17")
        else -> "连接中…" to Color.parseColor("#d99a17")
      }
      bottom.addView(TextView(a).apply { text = label; textSize = 12f; setTextColor(color) })
    }
    c.addView(bottom)

    c.setOnClickListener { actions.connect(p) }
    c.setOnLongClickListener { menu(more, p); true }
    return c
  }

  private fun menu(anchor: View, p: Profile) {
    val m = PopupMenu(a, anchor)
    m.menu.add(0, 1, 0, "连接")
    m.menu.add(0, 2, 1, "编辑")
    m.menu.add(0, 3, 2, "复制一份")
    m.menu.add(0, 4, 3, "删除")
    m.setOnMenuItemClickListener {
      when (it.itemId) {
        1 -> actions.connect(p)
        2 -> actions.edit(p)
        3 -> actions.duplicate(p)
        4 -> actions.remove(p)
      }
      true
    }
    m.show()
  }

  private fun addCard() = TextView(a).apply {
    text = "＋  新建服务器"
    textSize = 15f; setTextColor(dim); gravity = Gravity.CENTER
    minHeight = dp(76)
    val shape = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setStroke(dp(1), dim and 0x66ffffff, dp(6).toFloat(), dp(4).toFloat()) }
    background = RippleDrawable(ColorStateList.valueOf(ripple()), shape, GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(Color.WHITE) })
    setOnClickListener { actions.edit(null) }
  }

  private fun surface(active: Boolean): RippleDrawable {
    val shape = GradientDrawable().apply {
      cornerRadius = dp(12).toFloat()
      setColor(cardBg)
      if (active) setStroke(dp(2), accent) else setStroke(dp(1), line)
    }
    return RippleDrawable(ColorStateList.valueOf(ripple()), shape, null)
  }

  private fun ripple() = if (dark) 0x33ffffff else 0x1f000000

  private fun link(label: String, onClick: () -> Unit) = TextView(a).apply {
    text = label; textSize = 15f; setTextColor(accent); setPadding(dp(12), dp(8), dp(4), dp(8))
    setOnClickListener { onClick() }
  }

  private fun dp(v: Int) = (v * a.resources.displayMetrics.density).toInt()
}

/**
 * Android 15 draws an app under the status and navigation bars (edge to edge), and the keyboard no
 * longer shrinks the window: the content keeps out of the bars and above the keyboard by itself.
 * From Android 11 on it's done this way everywhere, so every version looks the same.
 */
fun keepClearOfBars(a: Activity, root: View) {
  if (Build.VERSION.SDK_INT < 30) return
  a.window.setDecorFitsSystemWindows(false)
  root.setOnApplyWindowInsetsListener { v, insets ->
    val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
    v.setPadding(b.left, b.top, b.right, b.bottom)
    WindowInsets.CONSUMED
  }
  root.requestApplyInsets()
}

/** Under an action bar (it keeps clear of the status bar itself): the sides, the bottom bar, the keyboard. */
fun keepClearOfBottom(root: View) {
  if (Build.VERSION.SDK_INT < 30) return
  root.setOnApplyWindowInsetsListener { v, insets ->
    val b = insets.getInsets(WindowInsets.Type.navigationBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
    v.setPadding(b.left, 0, b.right, b.bottom)
    insets
  }
}

/**
 * A password field with an eye: dots, or the text after a tap. The dots come from the
 * transformation, set here last: setSingleLine() after the input type silently replaced it.
 */
fun withEye(a: Activity, e: EditText): View {
  e.transformationMethod = PasswordTransformationMethod.getInstance()
  val row = LinearLayout(a).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
  row.addView(e, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
  val size = (44 * a.resources.displayMetrics.density).toInt()
  val eye = ImageView(a).apply {
    setImageResource(R.drawable.ic_eye)
    scaleType = ImageView.ScaleType.CENTER
    contentDescription = "显示密码"
    var shown = false
    setOnClickListener {
      shown = !shown
      val at = e.selectionEnd
      e.transformationMethod = if (shown) null else PasswordTransformationMethod.getInstance()
      e.setSelection(at.coerceIn(0, e.length()))
      setImageResource(if (shown) R.drawable.ic_eye_off else R.drawable.ic_eye)
      contentDescription = if (shown) "隐藏密码" else "显示密码"
    }
  }
  row.addView(eye, LinearLayout.LayoutParams(size, size))
  return row
}
