import AppKit
import SwiftUI

/// One server's settings, in a sheet over the window: new, edited or copied from the server list.
struct SettingsView: View {
  @State var draft: Profile
  let isNew: Bool
  @State var password: String
  @State private var showPassword = false
  /// the server, its password, and whether to connect now
  var onDone: (Profile, String, Bool) -> Void
  var onCancel: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(isNew ? "新建服务器" : "编辑服务器").font(.title3.weight(.semibold))
      Form {
        TextField("名称", text: $draft.name, prompt: Text("可选，比如「工作站」"))
        Picker("连接方式", selection: $draft.mode) {
          Text("直接访问").tag("direct")
          Text("SSH 转发").tag("ssh")
        }
        .pickerStyle(.segmented)
        if draft.isDirect {
          TextField("网址", text: $draft.directURL, prompt: Text("比如 http://10.126.126.2:8080"))
        } else {
          TextField("SSH 目标", text: $draft.target, prompt: Text("user@host，或 ~/.ssh/config 里的别名"))
          TextField("SSH 端口", value: $draft.sshPort, format: .number.grouping(.never))
          TextField("服务器上 tmux-web 的端口", value: $draft.remotePort, format: .number.grouping(.never))
          TextField("本地端口", value: $draft.localPort, format: .number.grouping(.never))
          HStack {
            TextField("SSH 私钥", text: $draft.keyPath, prompt: Text("可选，留空用 ~/.ssh/config 和默认密钥"))
            Button("选择…") { pickKey() }
          }
          HStack(spacing: 6) {
            if showPassword {
              TextField("SSH 密码", text: $password, prompt: Text("可选，加密保存在本机；留空则需要时弹框输入"))
            } else {
              SecureField("SSH 密码", text: $password, prompt: Text("可选，加密保存在本机；留空则需要时弹框输入"))
            }
            Button { showPassword.toggle() } label: { Image(systemName: showPassword ? "eye.slash" : "eye").frame(width: 18) }
              .buttonStyle(.borderless)
              .help(showPassword ? "隐藏密码" : "显示密码")
          }
          TextField("其他 ssh 参数", text: $draft.extraArgs, prompt: Text("可选，比如 -J 跳板机"))
        }
      }
      Text(draft.isDirect
        ? "已经能直接访问服务器时用（比如在 EasyTier、局域网里），不经过 SSH。"
        : "选了公钥（.pub）也没关系，会自动用同名的私钥。填了密码就自动登录；验证码等其他提问会弹框输入。每台服务器用自己固定的本地端口，网页的登录状态才能保留。")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("取消") { onCancel() }.keyboardShortcut(.cancelAction)
        Button("保存") { onDone(draft, password, false) }.disabled(!draft.isComplete)
        Button("保存并连接") { onDone(draft, password, true) }
          .keyboardShortcut(.defaultAction)
          .disabled(!draft.isComplete)
      }
    }
    .padding(20)
    .frame(width: 520)
  }

  private func pickKey() {
    let panel = NSOpenPanel()
    panel.directoryURL = URL(fileURLWithPath: ("~/.ssh" as NSString).expandingTildeInPath)
    panel.showsHiddenFiles = true
    panel.canChooseDirectories = false
    panel.message = "选择 SSH 私钥（选公钥 .pub 也可以）"
    if panel.runModal() == .OK, let url = panel.url {
      draft.keyPath = (url.path as NSString).abbreviatingWithTildeInPath
    }
  }
}
