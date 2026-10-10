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

  @State private var showPassword = false
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
          HStack(spacing: 12) {
            ModeChoice(icon: "network", color: .teal, title: "直接访问", text: "EasyTier、局域网等能直接打开的地址", selected: draft.isDirect) { setMode("direct") }
            ModeChoice(icon: "lock.shield", color: .indigo, title: "SSH 转发", text: "通过 SSH 端口转发，不用开放端口", selected: !draft.isDirect) { setMode("ssh") }
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
          if !draft.isDirect {
            Card("登录") {
              Row("私钥", note: draft.keyPath.isEmpty ? "不选就用 ~/.ssh/config 和默认密钥；选了 .pub 也行" : nil, error: keyError) {
                HStack(spacing: 6) {
                  TextField("", text: $draft.keyPath, prompt: Text("可选"))
                  if !draft.keyPath.isEmpty {
                    Button { draft.keyPath = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }.buttonStyle(.plain).help("不用私钥")
                  }
                  Button("选择…") { pickKey() }.controlSize(.small)
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
    // direct needs much less room than SSH
    .frame(width: 620, height: draft.isDirect ? 560 : 720)
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
    return p
  }

  private var urlError: String? {
    draft.directURL.trimmingCharacters(in: .whitespaces).isEmpty || draft.directBase != nil ? nil : "网址不对，比如 http://10.126.126.2:8080"
  }
  private var targetError: String? {
    draft.target.trimmingCharacters(in: .whitespaces).contains(" ") ? "不能有空格；端口填在下面" : nil
  }
  private func portError(_ p: Int) -> String? { (1...65535).contains(p) ? nil : "端口在 1–65535 之间" }
  private var portTaken: String? {
    guard !draft.isDirect, let other = takenPorts[draft.localPort] else { return nil }
    return "「\(other)」也用这个本地端口，换一个"
  }
  private var keyError: String? {
    let path = (draft.keyPath.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
    return path.isEmpty || FileManager.default.fileExists(atPath: path) ? nil : "找不到这个文件"
  }
  private var canSave: Bool {
    guard draft.isComplete else { return false }
    if draft.isDirect { return urlError == nil }
    return targetError == nil && keyError == nil && portTaken == nil && [draft.sshPort, draft.remotePort, draft.localPort].allSatisfy { portError($0) == nil }
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
