package com.zheqiushui.tmuxweb

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** The server settings: filled in on first launch, changed from ⚙. */
class SettingsActivity : Activity() {
  private lateinit var store: ProfileStore
  private lateinit var draft: Profile
  private val fields = mutableMapOf<String, EditText>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    store = ProfileStore(this)
    draft = store.current ?: Profile()
    title = "服务器设置"

    val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(24)) }
    fun field(key: String, label: String, value: String, hint: String, type: Int = InputType.TYPE_CLASS_TEXT, lines: Int = 1) {
      form.addView(TextView(this).apply { text = label; textSize = 13f; setPadding(0, dp(12), 0, dp(2)) })
      val e = EditText(this).apply {
        setText(value)
        this.hint = hint
        inputType = type
        if (lines > 1) { minLines = lines; maxLines = lines + 4; isSingleLine = false; textSize = 11f } else isSingleLine = true
      }
      fields[key] = e
      form.addView(e, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }
    val number = InputType.TYPE_CLASS_NUMBER
    val secret = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    field("name", "名称", draft.name, "可选，比如「工作站」")
    field("target", "SSH 目标", draft.target, "user@host", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
    field("sshPort", "SSH 端口", draft.sshPort.toString(), "22", number)
    field("remotePort", "服务器上 tmux-web 的端口", draft.remotePort.toString(), "8080", number)
    field("localPort", "本地端口", draft.localPort.toString(), "18080", number)
    field("password", "SSH 密码", draft.password, "可选，留空则需要时弹框输入", secret)
    field("privateKey", "SSH 私钥", draft.privateKey, "可选：粘贴私钥内容（-----BEGIN … PRIVATE KEY-----），或从文件导入", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 3)
    form.addView(Button(this).apply { text = "从文件导入私钥…"; setOnClickListener { pickKey() } })
    field("keyPassphrase", "私钥口令", draft.keyPassphrase, "私钥有口令才填", secret)
    form.addView(TextView(this).apply {
      text = "配置（包括密码和私钥）加密保存在手机里。本地端口固定不变，网页的登录状态才能保留。"
      textSize = 12f
      alpha = 0.7f
      setPadding(0, dp(12), 0, dp(12))
    })

    val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    buttons.addView(Button(this).apply { text = "保存并连接"; setOnClickListener { save() } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    form.addView(buttons)
    form.addView(Button(this).apply {
      text = "忘记主机密钥"
      setOnClickListener {
        val p = collect() ?: return@setOnClickListener
        KnownHosts(this@SettingsActivity).forget(p.host, p.sshPort)
        Toast.makeText(this@SettingsActivity, "已忘记 ${p.host} 的主机密钥，下次连接时重新记录", Toast.LENGTH_SHORT).show()
      }
    })
    form.addView(Button(this).apply {
      text = "断开并退出"
      setOnClickListener {
        TunnelService.stop(this@SettingsActivity)
        finishAffinity()
      }
    })
    form.addView(TextView(this).apply { text = "tmux-web ${BuildConfig.VERSION_NAME}"; textSize = 12f; alpha = 0.5f; setPadding(0, dp(16), 0, 0) })
    setContentView(ScrollView(this).apply { addView(form) })
  }

  private fun collect(): Profile? {
    fun t(k: String) = fields[k]!!.text.toString().trim()
    fun n(k: String, d: Int) = t(k).toIntOrNull() ?: d
    val p = draft.copy(
      name = t("name"), target = t("target"), sshPort = n("sshPort", 22), remotePort = n("remotePort", 8080), localPort = n("localPort", 18080),
      password = fields["password"]!!.text.toString(), privateKey = t("privateKey"), keyPassphrase = fields["keyPassphrase"]!!.text.toString(),
    )
    if (!p.isComplete) {
      Toast.makeText(this, "请填写 SSH 目标（user@host）和端口", Toast.LENGTH_LONG).show()
      return null
    }
    val key = p.privateKey
    if (key.isNotEmpty() && (key.startsWith("ssh-") || key.startsWith("ecdsa-") || key.startsWith("sk-"))) {
      AlertDialog.Builder(this).setMessage("填的是公钥。登录需要私钥：内容以「-----BEGIN … PRIVATE KEY-----」开头的那个文件。").setPositiveButton("知道了", null).show()
      return null
    }
    return p
  }

  private fun save() {
    val p = collect() ?: return
    store.upsert(p)
    TunnelService.stop(this)
    // a moment for the old forward to let go of the port
    window.decorView.postDelayed({
      TunnelService.start(this)
      finish()
    }, 400)
  }

  private fun pickKey() {
    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), 3)
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    val uri = data?.data ?: return
    if (requestCode != 3 || resultCode != RESULT_OK) return
    val text = try {
      contentResolver.openInputStream(uri)?.use { it.readBytes().take(64 * 1024).toByteArray().toString(Charsets.UTF_8) } ?: ""
    } catch (e: Exception) {
      ""
    }
    if (!text.trimStart().startsWith("-----BEGIN")) {
      AlertDialog.Builder(this).setMessage(if (text.startsWith("ssh-")) "选的是公钥，登录需要对应的私钥（通常是同名、没有 .pub 的那个文件）。" else "这个文件看起来不是 SSH 私钥。").setPositiveButton("知道了", null).show()
      return
    }
    fields["privateKey"]!!.setText(text.trim())
  }

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
