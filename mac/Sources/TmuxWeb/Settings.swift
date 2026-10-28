import AppKit
import SwiftUI

/// One server's settings, in a sheet over the window: new, edited or copied.
struct SettingsView: View {
  @State var draft: Profile
  let isNew: Bool
  @State var password: String
  /// local ports the other SSH servers here use → their names
  let takenPorts: [Int: String]
  /// the server, its password, and whether to connect now
  var onDone: (Profile, String, Bool) -> Void
  var onCancel: () -> Void
  var onDelete: (() -> Void)?

  @ObservedObject private var store = ProfileStore.shared
  /// what 添加… did, shown while that key stays picked
  @State private var keyMessage: (id: UUID, text: String)?
  @State private var showPassword = false
  @State private var showEasyTierSecret = false
  @State private var advanced = false
  @State private var test: Probe?
  @State private var testing = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Avatar(profile: draft, size: 38)
        VStack(alignment: .leading, spacing: 2) {
          Text(isNew ? "新建服务器" : "编辑服务器").font(.title3.weight(.semibold))
          Text(draft.title.isEmpty ? "选好连接方式，填上地址" : draft.title).font(.callout).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
      }
      .padding(.horizontal, 22).padding(.vertical, 16)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          HStack(spacing: 10) {
            ModeChoice(icon: "network", color: .teal, title: "直接访问", text: "局域网、公网，或已经连上的 EasyTier 地址", selected: draft.isDirect) { setMode("direct") }
            ModeChoice(icon: "link.circle.fill", color: .blue, title: "内置 EasyTier", text: "App 自己加入网络，不用另开 EasyTier", selected: draft.isEasyTier) { setMode("easytier") }
            ModeChoice(icon: "lock.shield", color: .indigo, title: "SSH 转发", text: "通过 SSH 端口转发，不用开放端口", selected: draft.mode == "ssh") { setMode("ssh") }
          }
          Card("服务器") {
            Row("名称", note: draft.name.isEmpty ? "不填就用地址" : nil) {
              TextField("", text: $draft.name, prompt: Text("比如「工作站」"))
            }
            if draft.isDirect {
              Divider()
              Row("网址", error: urlError) {
                TextField("", text: $draft.directURL, prompt: Text("http://10.126.126.2:8080"))
              }
            } else if draft.isEasyTier {
              Divider()
              Row("服务器虚拟 IP", note: "tmux-web 这台机器在 EasyTier 网络里的 IPv4 地址", error: serverIPError) {
                TextField("", text: $draft.easyTierServerIP, prompt: Text("10.144.144.30"))
              }
              Divider()
              Row("tmux-web 端口", note: "服务器上 tmux-web 监听的端口", error: portError(draft.remotePort)) { number($draft.remotePort) }
            } else {
              Divider()
              Row("SSH 目标", note: "user@host，或 ~/.ssh/config 里的别名", error: targetError) {
                TextField("", text: $draft.target, prompt: Text("user@host"))
              }
              Divider()
              Row("SSH 端口", error: portError(draft.sshPort)) { number($draft.sshPort) }
              Divider()
              Row("tmux-web 端口", note: "服务器上 tmux-web 监听的端口", error: portError(draft.remotePort)) { number($draft.remotePort) }
            }
          }
          if draft.isEasyTier {
            Card("EasyTier 网络") {
              Row("网络名称", note: "和 EasyTier 客户端里填的 Network Name 一致", error: networkError) {
                TextField("", text: $draft.easyTierNetwork, prompt: Text("my-network"))
              }
              Divider()
              Row("网络密钥", note: "只写入权限 0600 的临时配置，不出现在进程参数里") {
                HStack(spacing: 6) {
                  if showEasyTierSecret {
                    TextField("", text: $draft.easyTierSecret, prompt: Text("可留空"))
                  } else {
                    SecureField("", text: $draft.easyTierSecret, prompt: Text("可留空"))
                  }
                  Button { showEasyTierSecret.toggle() } label: { Image(systemName: showEasyTierSecret ? "eye.slash" : "eye").frame(width: 18) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .help(showEasyTierSecret ? "隐藏网络密钥" : "显示网络密钥")
                }
              }
              Divider()
              Row("公共节点", note: "一个或多个，用逗号或换行分隔", error: peerError) {
                TextField("", text: $draft.easyTierPeers, prompt: Text("tcp://public.example.com:11010"))
              }
            }
            VStack(alignment: .leading, spacing: 10) {
              Button { withAnimation(.easeOut(duration: 0.15)) { advanced.toggle() } } label: {
                Label("高级", systemImage: advanced ? "chevron.down" : "chevron.right").font(.subheadline.weight(.semibold))
              }
              .buttonStyle(.plain).foregroundStyle(.secondary)
              if advanced || portTaken != nil {
                Card(nil) {
                  Row("本地端口", note: "网页登录状态属于这个端口；换一台服务器就用另一个端口", error: portTaken ?? portError(draft.localPort)) { number($draft.localPort) }
                }
              }
            }
          } else if draft.mode == "ssh" {
            Card("登录") {
              Row("私钥", note: keyNote, error: keyError) {
                HStack(spacing: 6) {
                  Picker("", selection: $draft.keyID) {
                    Text("不指定（用 ~/.ssh/config 和默认密钥）").tag(UUID?.none)
                    if !store.keys.isEmpty { Divider() }
                    ForEach(store.keys) { k in Text(k.name).tag(UUID?.some(k.id)) }
                  }
                  .labelsHidden()
                  Button("添加…") { addKey() }.controlSize(.small).help("登记一个私钥文件，并给这台服务器用")
                }
              }
              Divider()
              Row("密码", note: "可选，加密保存在本机；不填则需要时弹框输入") {
                HStack(spacing: 6) {
                  if showPassword {
                    TextField("", text: $password, prompt: Text("可选"))
                  } else {
                    SecureField("", text: $password, prompt: Text("可选"))
                  }
                  Button { showPassword.toggle() } label: { Image(systemName: showPassword ? "eye.slash" : "eye").frame(width: 18) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .help(showPassword ? "隐藏密码" : "显示密码")
                }
              }
            }
            VStack(alignment: .leading, spacing: 10) {
              Button { withAnimation(.easeOut(duration: 0.15)) { advanced.toggle() } } label: {
                Label("高级", systemImage: advanced ? "chevron.down" : "chevron.right").font(.subheadline.weight(.semibold))
              }
              .buttonStyle(.plain).foregroundStyle(.secondary)
              if advanced || portTaken != nil {
                Card(nil) {
                  Row("本地端口", note: "每台服务器一个固定端口，网页的登录状态才能保留", error: portTaken ?? portError(draft.localPort)) { number($draft.localPort) }
                  Divider()
                  Row("远端地址", note: "tmux-web 在服务器看来的地址，一般不用改") {
                    TextField("", text: $draft.remoteHost, prompt: Text("127.0.0.1"))
                  }
                  Divider()
                  Row("其他 ssh 参数", note: "比如 -J 跳板机") {
                    TextField("", text: $draft.extraArgs, prompt: Text("可选"))
                  }
                }
              }
            }
          }
          HStack(spacing: 12) {
            Button {
              testing = true
              test = .checking
              let p = draft
              Task {
                let r = await Prober.check(p)
                await MainActor.run {
                  test = r
                  testing = false
                }
              }
            } label: { Label("测试连接", systemImage: "bolt.horizontal") }
              .disabled(testing || !draft.isComplete)
            if let test { TestResult(probe: test, direct: draft.isDirect) }
            Spacer()
          }
        }
        .padding(22)
      }
      Divider()
      HStack {
        if let onDelete {
          Button(role: .destructive) { onDelete() } label: { Label("删除服务器…", systemImage: "trash") }
            .buttonStyle(.borderless).foregroundStyle(.red)
        }
        Spacer()
        Button("取消") { onCancel() }.keyboardShortcut(.cancelAction)
        Button("保存") { onDone(cleaned, password, false) }.disabled(!canSave)
        Button("保存并连接") { onDone(cleaned, password, true) }
          .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
          .disabled(!canSave)
      }
      .controlSize(.large)
      .padding(.horizontal, 22).padding(.vertical, 14)
    }
    // direct needs much less room than a forwarded connection
    .frame(width: 700, height: draft.isDirect ? 560 : 760)
    .onChange(of: draft.mode) { _ in test = nil }
  }

  private func setMode(_ m: String) {
    withAnimation(.easeOut(duration: 0.15)) { draft.mode = m }
  }

  private func number(_ v: Binding<Int>) -> some View {
    TextField("", value: v, format: .number.grouping(.never)).frame(width: 90)
  }

  // MARK: checks as you type

  private var cleaned: Profile {
    var p = draft
    p.name = p.name.trimmingCharacters(in: .whitespaces)
    p.target = p.target.trimmingCharacters(in: .whitespaces)
    p.directURL = p.directURL.trimmingCharacters(in: .whitespaces)
    p.easyTierNetwork = p.easyTierNetwork.trimmingCharacters(in: .whitespaces)
    p.easyTierPeers = p.easyTierPeers.trimmingCharacters(in: .whitespacesAndNewlines)
    p.easyTierServerIP = p.easyTierServerIP.trimmingCharacters(in: .whitespaces)
    return p
  }

  private var urlError: String? {
    draft.directURL.trimmingCharacters(in: .whitespaces).isEmpty || draft.directBase != nil ? nil : "网址不对，比如 http://10.126.126.2:8080"
  }
  private var targetError: String? {
    draft.target.trimmingCharacters(in: .whitespaces).contains(" ") ? "不能有空格；端口填在下面" : nil
  }
  private var networkError: String? {
    draft.easyTierNetwork.trimmingCharacters(in: .whitespaces).isEmpty ? "填写 EasyTier 网络名称" : nil
  }
  private var serverIPError: String? {
    let ip = draft.easyTierServerIP.trimmingCharacters(in: .whitespaces)
    if ip.isEmpty { return "填写服务器的 EasyTier 虚拟 IP" }
    return EasyTierConfig.validIPv4(ip) ? nil : "要填 IPv4 地址，比如 10.144.144.30"
  }
  private var peerError: String? {
    let peers = EasyTierConfig.peers(from: draft.easyTierPeers)
    if peers.isEmpty { return "至少填一个公共节点" }
    if let bad = peers.first(where: { !EasyTierConfig.validPeer($0) }) { return "格式不对：\(bad)" }
    return nil
  }
  private func portError(_ p: Int) -> String? { (1...65535).contains(p) ? nil : "端口在 1–65535 之间" }
  private var portTaken: String? {
    guard !draft.isDirect, let other = takenPorts[draft.localPort] else { return nil }
    return "「\(other)」也用这个本地端口，换一个"
  }
  private var key: SSHKey? { store.key(draft.keyID) }
  private var keyNote: String? {
    if let m = keyMessage, m.id == draft.keyID { return m.text }
    guard let key else { return "私钥统一登记在「私钥」里，多台服务器可以共用" }
    return "\(key.path) · 在「私钥」里统一管理"
  }
  private var keyError: String? {
    guard let key, !key.exists else { return nil }
    return "找不到私钥文件 \(key.path)，在「私钥」里更换"
  }
  private var canSave: Bool {
    guard draft.isComplete else { return false }
    if draft.isDirect { return urlError == nil }
    if draft.isEasyTier { return EasyTierConfig.problem(draft) == nil && portTaken == nil }
    return targetError == nil && keyError == nil && portTaken == nil && [draft.sshPort, draft.remotePort, draft.localPort].allSatisfy { portError($0) == nil }
  }

  /// a key file picked here: into the key list (the one there is, if it's there already), and this server's
  private func addKey() {
    guard let path = pickKeyFile() else { return }
    if let p = KeyFile.problem(SSHKey.of(path).file) {
      keyMessage = nil
      let a = NSAlert()
      a.messageText = "不能用这个文件"
      a.informativeText = p
      a.runModal()
      return
    }
    let known = store.keys.count
    let k = store.addKey(path)
    draft.keyID = k.id
    keyMessage = (k.id, store.keys.count == known ? "这个文件已经登记过，选的是「\(k.name)」" : "已登记为「\(k.name)」，别的服务器也可以选它")
  }
}

/// A titled group of rows on a card.
private struct Card<Content: View>: View {
  let title: String?
  @ViewBuilder let content: Content
  init(_ title: String?, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let title { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
      VStack(spacing: 0) { content }
        .padding(.horizontal, 14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
    }
  }
}

/// label · field, with a note or an error under the field
private struct Row<Content: View>: View {
  let label: String
  var note: String?
  var error: String?
  @ViewBuilder let content: Content
  init(_ label: String, note: String? = nil, error: String? = nil, @ViewBuilder content: () -> Content) {
    self.label = label
    self.note = note
    self.error = error
    self.content = content()
  }
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label).frame(width: 110, alignment: .leading)
      VStack(alignment: .leading, spacing: 4) {
        content.textFieldStyle(.roundedBorder)
        if let error {
          Label(error, systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
        } else if let note {
          Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 10)
  }
}

private struct TestResult: View {
  let probe: Probe
  let direct: Bool
  var body: some View {
    switch probe {
    case .checking:
      HStack(spacing: 6) {
        ProgressView().controlSize(.small)
        Text("测试中…")
      }
      .foregroundStyle(.secondary)
    case .online(let ms):
      Label(direct ? "tmux-web 有响应 · \(ms) ms" : "SSH 端口能连上 · \(ms) ms（登录在连接时验证）", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
    case .offline(let why):
      Label("连不上：\(why)", systemImage: "xmark.circle.fill").foregroundStyle(.red)
    case .unknown(let why):
      Label("\(why)，没法提前测试，连接时就知道了", systemImage: "questionmark.circle").foregroundStyle(.secondary)
    }
  }
}
