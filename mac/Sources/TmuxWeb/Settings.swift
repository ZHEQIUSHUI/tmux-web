import AppKit
import SwiftUI

/// The server settings: filled in on first launch, changed from 服务器 → 编辑服务器….
struct SettingsView: View {
  @ObservedObject var store = ProfileStore.shared
  @State var draft: Profile
  @State private var password = ""
  var onConnect: (Profile) -> Void
  var onCancel: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if store.profiles.count > 1 {
        Picker("服务器", selection: Binding(get: { draft.id }, set: { id in if let p = store.profiles.first(where: { $0.id == id }) { draft = p } })) {
          ForEach(store.profiles) { p in Text(p.title).tag(p.id) }
        }
      }
      Form {
        TextField("名称", text: $draft.name, prompt: Text("可选，比如「工作站」"))
        TextField("SSH 目标", text: $draft.target, prompt: Text("user@host，或 ~/.ssh/config 里的别名"))
        TextField("SSH 端口", value: $draft.sshPort, format: .number.grouping(.never))
        TextField("服务器上 tmux-web 的端口", value: $draft.remotePort, format: .number.grouping(.never))
        TextField("本地端口", value: $draft.localPort, format: .number.grouping(.never))
        HStack {
          TextField("SSH 私钥", text: $draft.keyPath, prompt: Text("可选，留空用 ~/.ssh/config 和默认密钥"))
          Button("选择…") { pickKey() }
        }
        SecureField("SSH 密码", text: $password, prompt: Text("可选，存在钥匙串里；留空则需要时弹框输入"))
        TextField("其他 ssh 参数", text: $draft.extraArgs, prompt: Text("可选，比如 -J 跳板机"))
      }
      Text("选了公钥（.pub）也没关系，会自动用同名的私钥。填了密码就自动登录；验证码等其他提问会弹框输入。本地端口固定不变，网页的登录状态才能保留。")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("新建服务器") { draft = Profile() }
        if store.profiles.contains(where: { $0.id == draft.id }) && store.profiles.count > 1 {
          Button("删除") {
            store.remove(draft.id)
            draft = store.current ?? Profile()
          }
        }
        Spacer()
        Button("取消") { onCancel() }.keyboardShortcut(.cancelAction)
        Button("保存并连接") {
          store.upsert(draft)
          Keychain.setPassword(password, for: draft.id)
          onConnect(draft)
        }
        .keyboardShortcut(.defaultAction)
        .disabled(!draft.isComplete)
      }
    }
    .padding(20)
    .frame(width: 520)
    .onAppear { password = Keychain.password(for: draft.id) ?? "" }
    .onChange(of: draft.id) { id in password = Keychain.password(for: id) ?? "" }
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
