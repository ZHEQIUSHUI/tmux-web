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
import java.util.UUID

/**
 * One server's settings, from the server list: a new one, an edit ("id"), or a copy ("copy").
 * Saving hands back the server's id and whether to connect now.
 */
class SettingsActivity : Activity() {
  private lateinit var store: ProfileStore
  private lateinit var draft: Profile
  private var original: Profile? = null
  private var mode = "direct"
  private val fields = mutableMapOf<String, EditText>()

  private val number = InputType.TYPE_CLASS_NUMBER
  private val secret = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    store = ProfileStore(this)
    original = intent.getStringExtra("id")?.let { id -> store.profiles.firstOrNull { it.id == id } }
    val copyOf = intent.getStringExtra("copy")?.let { id -> store.profiles.firstOrNull { it.id == id } }
    draft = original
      ?: copyOf?.let { it.copy(id = UUID.randomUUID().toString(), name = "${it.title} 副本", localPort = if (it.isDirect) it.localPort else store.freeLocalPort()) }
      ?: Profile(localPort = store.freeLocalPort())
    mode = draft.mode
    title = if (original == null) "新建服务器" else "编辑服务器"

    val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(24)) }
    // the fields of each way to connect; only the chosen one shows
    val directBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    val sshBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    var into = form
    fun field(key: String, label: String, value: String, hint: String, type: Int = InputType.TYPE_CLASS_TEXT, lines: Int = 1) {
      val form = into
      form.addView(TextView(this).apply { text = label; textSize = 13f; setPadding(0, dp(12), 0, dp(2)) })
      val e = EditText(this).apply {
        setText(value)
        this.hint = hint
        inputType = type
        if (lines > 1) { minLines = lines; maxLines = lines + 4; isSingleLine = false; textSize = 11f } else isSingleLine = true
      }
      fields[key] = e
      // passwords: dots, or the text after a tap on the eye
      if (type == secret) form.addView(withEye(this, e), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      else form.addView(e, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }
    field("name", "名称", draft.name, "可选，比如「工作站」")
    form.addView(TextView(this).apply { text = "连接方式"; textSize = 13f; setPadding(0, dp(12), 0, dp(2)) })
    val modes = android.widget.RadioGroup(this).apply { orientation = LinearLayout.HORIZONTAL }
    val directBtn = android.widget.RadioButton(this).apply { text = "直接访问"; id = android.view.View.generateViewId() }
    val sshBtn = android.widget.RadioButton(this).apply { text = "SSH 转发"; id = android.view.View.generateViewId() }
    modes.addView(directBtn)
    modes.addView(sshBtn)
    form.addView(modes)
    form.addView(directBox)
    form.addView(sshBox)
    val showMode = { direct: Boolean ->
      directBox.visibility = if (direct) android.view.View.VISIBLE else android.view.View.GONE
      sshBox.visibility = if (direct) android.view.View.GONE else android.view.View.VISIBLE
    }
    modes.setOnCheckedChangeListener { _, id -> mode = if (id == directBtn.id) "direct" else "ssh"; showMode(mode == "direct") }
    modes.check(if (draft.isDirect) directBtn.id else sshBtn.id)
    showMode(draft.isDirect)

    into = directBox
    field("directUrl", "网址", draft.directUrl, "比如 http://10.126.126.2:8080", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
    directBox.addView(TextView(this).apply { text = "已经能直接访问服务器时用（比如在 EasyTier、局域网里），不经过 SSH。"; textSize = 12f; alpha = 0.7f; setPadding(0, dp(8), 0, 0) })

    into = sshBox
    field("target", "SSH 目标", draft.target, "user@host", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
    field("sshPort", "SSH 端口", draft.sshPort.toString(), "22", number)
    field("remotePort", "服务器上 tmux-web 的端口", draft.remotePort.toString(), "8080", number)
    field("localPort", "本地端口", draft.localPort.toString(), "18080", number)
    field("password", "SSH 密码", draft.password, "可选，留空则需要时弹框输入", secret)
    field("privateKey", "SSH 私钥", draft.privateKey, "可选：粘贴私钥内容（-----BEGIN … PRIVATE KEY-----），或从文件导入", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 3)
    sshBox.addView(Button(this).apply { text = "从文件导入私钥…"; setOnClickListener { pickKey() } })
    field("keyPassphrase", "私钥口令", draft.keyPassphrase, "私钥有口令才填", secret)
    into = form
    sshBox.addView(TextView(this).apply {
      text = "配置（包括密码和私钥）加密保存在手机里。每台服务器用自己固定的本地端口，网页的登录状态才能保留。"
      textSize = 12f
      alpha = 0.7f
      setPadding(0, dp(12), 0, dp(12))
    })

    val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    buttons.addView(Button(this).apply { text = "保存"; setOnClickListener { save(false) } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    buttons.addView(Button(this).apply { text = "保存并连接"; setOnClickListener { save(true) } }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    form.addView(buttons)
    sshBox.addView(Button(this).apply {
      text = "忘记主机密钥"
      setOnClickListener {
        val p = collect() ?: return@setOnClickListener
        if (p.isDirect) return@setOnClickListener
        KnownHosts(this@SettingsActivity).forget(p.host, p.sshPort)
        Toast.makeText(this@SettingsActivity, "已忘记 ${p.host} 的主机密钥，下次连接时重新记录", Toast.LENGTH_SHORT).show()
      }
    })
    form.addView(TextView(this).apply { text = "tmux-web ${BuildConfig.VERSION_NAME}"; textSize = 12f; alpha = 0.5f; setPadding(0, dp(16), 0, 0) })
    setContentView(ScrollView(this).apply { addView(form) })
  }

  private fun collect(): Profile? {
    fun t(k: String) = fields[k]!!.text.toString().trim()
    fun n(k: String, d: Int) = t(k).toIntOrNull() ?: d
    val p = draft.copy(
      name = t("name"), mode = mode, directUrl = t("directUrl"), target = t("target"), sshPort = n("sshPort", 22), remotePort = n("remotePort", 8080), localPort = n("localPort", 18080),
      password = fields["password"]!!.text.toString(), privateKey = t("privateKey"), keyPassphrase = fields["keyPassphrase"]!!.text.toString(),
    )
    if (!p.isComplete) {
      Toast.makeText(this, if (p.isDirect) "请填写网址，比如 http://10.126.126.2:8080" else "请填写 SSH 目标（user@host）和端口", Toast.LENGTH_LONG).show()
      return null
    }
    val key = p.privateKey
    if (key.isNotEmpty() && (key.startsWith("ssh-") || key.startsWith("ecdsa-") || key.startsWith("sk-"))) {
      AlertDialog.Builder(this).setMessage("填的是公钥。登录需要私钥：内容以「-----BEGIN … PRIVATE KEY-----」开头的那个文件。").setPositiveButton("知道了", null).show()
      return null
    }
    return p
  }

  private fun save(connect: Boolean) {
    val p = collect() ?: return
    store.upsert(p)
    setResult(RESULT_OK, Intent().putExtra("id", p.id).putExtra("connect", connect).putExtra("changed", original != p))
    finish()
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
