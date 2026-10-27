import AppKit
import SwiftUI

/// Share selected servers and keys over the LAN, or receive them from another device.
struct ConfigShareView: View {
  var onClose: () -> Void
  @ObservedObject private var store = ProfileStore.shared
  @ObservedObject private var service = ConfigShareService.shared
  @State private var tab = 0

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Image(systemName: "square.and.arrow.up").font(.system(size: 18)).foregroundStyle(.white)
          .frame(width: 38, height: 38).background(RoundedRectangle(cornerRadius: 10).fill(Color.blue.gradient))
        VStack(alignment: .leading, spacing: 2) {
          Text("共享配置").font(.title3.weight(.semibold))
          Text("在局域网里把服务器和私钥安全地交给另一台设备").font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
      }
      .padding(.horizontal, 22).padding(.vertical, 16)
      Divider()
      Picker("", selection: $tab) {
        Text("共享给其他设备").tag(0)
        Text("从其他设备获取").tag(1)
      }
      .pickerStyle(.segmented).labelsHidden().padding(.horizontal, 22).padding(.vertical, 12)
      Divider()
      if tab == 0 { sender } else { receiver }
      Divider()
      HStack {
        Text("共享内容用密码加密；密码不会保存在发送设备上。")
          .font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("完成") { onClose() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
      }
      .controlSize(.large).padding(.horizontal, 22).padding(.vertical, 13)
    }
    .frame(width: 720, height: 700)
  }

  // MARK: - send

  @State private var selectedProfiles: Set<UUID> = []
  @State private var selectedKeys: Set<UUID> = []
  @State private var initialized = false
  @State private var port = String(ShareProtocol.defaultPort)
  @State private var password = ""
  @State private var keyPassphrase = ""
  @State private var sendError: String?

  @ViewBuilder private var sender: some View {
    if let running = service.running {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          HStack(spacing: 9) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            Text("共享已开始").font(.headline)
            Spacer()
            Text("\(running.profileCount) 个服务器 · \(running.keyCount) 把私钥").font(.callout).foregroundStyle(.secondary)
          }
          Text("在另一台设备打开 tmux-web App → 共享配置 → 从其他设备获取，填入地址、端口和刚才设置的密码。")
            .font(.callout)
          VStack(alignment: .leading, spacing: 7) {
            Text("本机地址").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if running.addresses.isEmpty {
              Text("没有找到局域网 IPv4 地址，确认这台 Mac 已连接网络。").foregroundStyle(.red)
            } else {
              ForEach(running.addresses, id: \.self) { ip in
                HStack {
                  Text("\(ip):\(running.port)").font(.system(size: 15, design: .monospaced)).textSelection(.enabled)
                  Spacer()
                  Button("复制") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("\(ip):\(running.port)", forType: .string)
                  }
                  .controlSize(.small)
                }
              }
            }
          }
          .padding(12)
          .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.045)))
          Text("离开这个窗口后共享仍会继续，直到点「停止共享」或退出 App。只在你信任的局域网里使用。")
            .font(.caption).foregroundStyle(.secondary)
          Button("停止共享", role: .destructive) { service.stop() }
            .controlSize(.large)
        }
        .padding(22)
      }
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          card {
            HStack {
              VStack(alignment: .leading, spacing: 3) {
                Text("选择要共享的服务器").font(.headline)
                Text("会带上连接地址、账号、密码和所选的私钥。接收方会跳过完全相同的配置。")
                  .font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Button("全选") { selectAll() }.controlSize(.small)
              Button("全不选") { selectedProfiles = []; selectedKeys = [] }.controlSize(.small)
            }
            Divider()
            if store.profiles.isEmpty {
              Text("还没有服务器配置。").foregroundStyle(.secondary).padding(.vertical, 10)
            } else {
              ForEach(store.profiles) { p in
                selectRow(selected: selectedProfiles.contains(p.id), title: p.title, subtitle: p.address, icon: p.isDirect ? "network" : "lock.shield") {
                  toggleProfile(p)
                }
                if p.id != store.profiles.last?.id { Divider() }
              }
            }
          }

          if !store.keys.isEmpty {
            card {
              Text("SSH 私钥").font(.headline)
              Text("选中的服务器会尽量自动选上它使用的私钥；相同的私钥在接收端只保留一份。")
                .font(.caption).foregroundStyle(.secondary)
              Divider()
              ForEach(store.keys) { k in
                selectRow(selected: selectedKeys.contains(k.id), title: k.name, subtitle: k.path, icon: "key.fill") {
                  if selectedKeys.contains(k.id) { selectedKeys.remove(k.id) } else { selectedKeys.insert(k.id) }
                }
                if k.id != store.keys.last?.id { Divider() }
              }
              Divider()
              HStack {
                Text("私钥口令（可选）").frame(width: 120, alignment: .leading)
                SecureField("", text: $keyPassphrase, prompt: Text("加密私钥的口令，随本次共享发送"))
              }
              .font(.callout)
              Text("Mac 平时不保存私钥口令。如果共享的是加密私钥，可以在这里填上，Android 接收后会直接使用；不填则接收端连接时再问。")
                .font(.caption).foregroundStyle(.secondary)
            }
          }

          card {
            Text("连接方式").font(.headline)
            HStack {
              Text("端口").frame(width: 120, alignment: .leading)
              TextField("", text: $port).frame(width: 100).textFieldStyle(.roundedBorder)
              Text("另一台设备用这个端口连接").font(.caption).foregroundStyle(.secondary)
              Spacer()
            }
            HStack {
              Text("访问密码").frame(width: 120, alignment: .leading)
              SecureField("", text: $password, prompt: Text("至少 \(ShareProtocol.minPassword) 位"))
                .textFieldStyle(.roundedBorder)
              Button("随机") { password = randomPassword() }.controlSize(.small)
            }
            if let message = sendError ?? service.error {
              Label(message, systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
            }
            HStack {
              Spacer()
              if service.starting {
                ProgressView().controlSize(.small)
                Text("正在启动…").font(.callout).foregroundStyle(.secondary)
              }
              Button("开始共享") { start() }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(service.starting || selectedProfiles.isEmpty || password.count < ShareProtocol.minPassword || !validPort)
            }
          }
        }
        .padding(22)
      }
      .onAppear {
        guard !initialized else { return }
        initialized = true
        selectedProfiles = Set(store.profiles.map(\.id))
        selectedKeys = Set(store.keys.map(\.id))
      }
    }
  }

  private var validPort: Bool { Int(port).map { (1024...65535).contains($0) } ?? false }

  private func toggleProfile(_ p: Profile) {
    if selectedProfiles.contains(p.id) {
      selectedProfiles.remove(p.id)
    } else {
      selectedProfiles.insert(p.id)
      if let key = p.keyID { selectedKeys.insert(key) }
    }
  }

  private func selectAll() {
    selectedProfiles = Set(store.profiles.map(\.id))
    selectedKeys = Set(store.keys.map(\.id))
  }

  private func start() {
    sendError = nil
    do {
      let payload = try makePayload()
      service.start(payload: payload, password: password, port: Int(port) ?? ShareProtocol.defaultPort)
    } catch {
      sendError = error.localizedDescription
    }
  }

  private func makePayload() throws -> SharedPayload {
    var sharedKeys: [SharedKey] = []
    for key in store.keys where selectedKeys.contains(key.id) {
      guard let text = try? String(contentsOfFile: key.file, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw ShareError("读不到私钥文件：\(key.path)")
      }
      sharedKeys.append(SharedKey(id: key.id.uuidString, name: key.name, privateKey: text, passphrase: keyPassphrase))
    }
    let sharedKeyIDs = Set(sharedKeys.map(\.id))
    let sharedProfiles = store.profiles.filter { selectedProfiles.contains($0.id) }.map { p -> SharedProfile in
      let keyID = p.keyID.flatMap { sharedKeyIDs.contains($0.uuidString) ? $0.uuidString : nil } ?? ""
      return SharedProfile(p, password: Keychain.password(for: p.id) ?? "", keyId: keyID)
    }
    return SharedPayload(keys: sharedKeys, profiles: sharedProfiles)
  }

  // MARK: - receive

  @State private var host = ""
  @State private var receivePort = String(ShareProtocol.defaultPort)
  @State private var receivePassword = ""
  @State private var busy = false
  @State private var receiveError: String?
  @State private var imported: ShareImportSummary?

  @ViewBuilder private var receiver: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let imported {
          card {
            Label("导入完成", systemImage: "checkmark.circle.fill").font(.headline).foregroundStyle(.green)
            Text(imported.text).font(.body)
            Button("再接收一份") { self.imported = nil; receivePassword = ""; receiveError = nil }
              .controlSize(.large)
          }
        } else {
          card {
            Text("从另一台设备获取").font(.headline)
            Text("让对方开始共享，把显示的 IP 和端口填在这里，再输入对方设置的密码。")
              .font(.caption).foregroundStyle(.secondary)
            HStack {
              Text("对方 IP").frame(width: 120, alignment: .leading)
              TextField("", text: $host, prompt: Text("比如 192.168.1.23")).textFieldStyle(.roundedBorder)
            }
            HStack {
              Text("端口").frame(width: 120, alignment: .leading)
              TextField("", text: $receivePort).frame(width: 100).textFieldStyle(.roundedBorder)
              Text("1024–65535").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
              Text("访问密码").frame(width: 120, alignment: .leading)
              SecureField("", text: $receivePassword).textFieldStyle(.roundedBorder)
            }
            if let message = receiveError {
              Label(message, systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
            }
            HStack {
              Spacer()
              if busy { ProgressView().controlSize(.small) }
              Button(busy ? "正在获取…" : "获取并导入") { receive() }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(busy || host.trimmingCharacters(in: .whitespaces).isEmpty || !validReceivePort || receivePassword.isEmpty)
            }
          }
          card {
            Text("查重规则").font(.headline)
            Text("服务器按连接方式、账号、地址、端口、密码和私钥判断。完全相同的配置会跳过；同一台服务器但密码或私钥不同，会作为另一个配置导入。相同的私钥只保留一份，导入的服务器会复用它。")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      .padding(22)
    }
  }

  private var validReceivePort: Bool { Int(receivePort).map { (1024...65535).contains($0) } ?? false }

  private func receive() {
    receiveError = nil
    busy = true
    Task {
      do {
        let payload = try await fetchShared()
        let summary = store.importShared(payload)
        imported = summary
        receivePassword = ""
      } catch {
        receiveError = error.localizedDescription
      }
      busy = false
    }
  }

  private func fetchShared() async throws -> SharedPayload {
    let (target, targetPort) = parseTarget(host, fallback: Int(receivePort) ?? ShareProtocol.defaultPort)
    guard let url = URL(string: "http://\(target):\(targetPort)/api/bundle") else { throw ShareError("地址不对") }
    var request = URLRequest(url: url)
    request.timeoutInterval = 12
    request.setValue(Data(receivePassword.utf8).base64EncodedString(), forHTTPHeaderField: "X-Share-Password-B64")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw ShareError("对方没有返回配置") }
    if http.statusCode == 401 { throw ShareError("密码不对") }
    if http.statusCode == 429 { throw ShareError("尝试次数太多，请等一分钟再试") }
    guard (200..<300).contains(http.statusCode) else { throw ShareError("对方拒绝连接（HTTP \(http.statusCode)）") }
    guard data.count <= 8 * 1024 * 1024 else { throw ShareError("共享配置太大") }
    return try ShareProtocol.open(String(decoding: data, as: UTF8.self), password: receivePassword)
  }

  private func parseTarget(_ input: String, fallback: Int) -> (String, Int) {
    let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.contains("://"), let c = URLComponents(string: s), let host = c.host { return (host, c.port ?? fallback) }
    let clean = s.split(separator: "/").first.map(String.init) ?? s
    let parts = clean.split(separator: ":", omittingEmptySubsequences: false)
    if parts.count == 2, let p = Int(parts[1]), !parts[0].isEmpty { return (String(parts[0]), p) }
    return (clean, fallback)
  }

  // MARK: - pieces

  private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 9, content: content)
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
  }

  private func selectRow(selected: Bool, title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 11) {
        Image(systemName: selected ? "checkmark.square.fill" : "square")
          .foregroundStyle(selected ? Color.accentColor : Color.secondary).font(.system(size: 16))
        Image(systemName: icon).foregroundStyle(selected ? Color.accentColor : Color.secondary).frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.callout.weight(.medium)).foregroundStyle(.primary)
          Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer()
      }
      .contentShape(Rectangle())
      .padding(.vertical, 5)
    }
    .buttonStyle(.plain)
  }
}

private func randomPassword() -> String {
  let alphabet = Array("abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
  return String((0..<12).map { _ in alphabet.randomElement()! })
}
