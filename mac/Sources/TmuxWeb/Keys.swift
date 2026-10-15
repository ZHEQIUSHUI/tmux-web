import AppKit
import SwiftUI

/// What a key file is (kind, fingerprint) and its public half, from the system's ssh-keygen.
enum KeyInfo {
  struct Info: Equatable {
    var type = ""
    var fingerprint = ""
    var problem: String?
  }

  private static var cache: [String: Info] = [:]
  private static let lock = NSLock()

  /// Slow (a process): off the main thread. A .pub next to the key is read when there is one,
  /// so a key with a passphrase needn't be opened.
  static func info(_ k: SSHKey) -> Info {
    let file = k.file
    if let p = KeyFile.problem(file) { return Info(problem: p) }
    let mtime = ((try? FileManager.default.attributesOfItem(atPath: file))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let id = "\(file)|\(mtime)"
    lock.lock()
    if let hit = cache[id] { lock.unlock(); return hit }
    lock.unlock()
    let pub = file + ".pub"
    let target = FileManager.default.fileExists(atPath: pub) ? pub : file
    let r: Info
    if let out = keygen(["-l", "-f", target]), let fp = out.split(separator: " ").first(where: { $0.hasPrefix("SHA256:") }) {
      // "256 SHA256:… comment (ED25519)"
      var type = out.components(separatedBy: "(").last?.components(separatedBy: ")").first ?? ""
      if type == "RSA", let bits = out.split(separator: " ").first { type = "RSA \(bits)" }
      r = Info(type: type, fingerprint: String(fp))
    } else {
      r = Info(problem: "有口令，旁边也没有 .pub 文件，看不了指纹（登录不受影响）")
    }
    lock.lock()
    cache[id] = r
    lock.unlock()
    return r
  }

  /// The line for the server's ~/.ssh/authorized_keys, or why there is none.
  static func publicKey(_ k: SSHKey) -> Result<String, KeyFile.Problem> {
    let pub = k.file + ".pub"
    if let text = try? String(contentsOfFile: pub, encoding: .utf8), text.hasPrefix("ssh-") || text.hasPrefix("ecdsa-") || text.hasPrefix("sk-") {
      return .success(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    if let out = keygen(["-y", "-f", k.file]), out.hasPrefix("ssh-") || out.hasPrefix("ecdsa-") || out.hasPrefix("sk-") {
      return .success(out.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return .failure(KeyFile.Problem(message: "这把私钥有口令，旁边也没有 .pub 文件，取不出公钥。可以在终端运行：ssh-keygen -y -f \(k.path)"))
  }

  /// ssh-keygen's output; nil when it fails or takes too long (it never gets a terminal to ask on)
  private static func keygen(_ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-keygen")
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env.removeValue(forKey: "SSH_ASKPASS")
    env.removeValue(forKey: "DISPLAY")
    p.environment = env
    p.standardInput = FileHandle.nullDevice
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: killer)
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    killer.cancel()
    guard p.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

/// Picks a private key file (a .pub works too).
func pickKeyFile(_ message: String = "选择 SSH 私钥（选公钥 .pub 也可以）") -> String? {
  let panel = NSOpenPanel()
  panel.directoryURL = URL(fileURLWithPath: ("~/.ssh" as NSString).expandingTildeInPath)
  panel.showsHiddenFiles = true
  panel.canChooseDirectories = false
  panel.message = message
  return panel.runModal() == .OK ? panel.url?.path : nil
}

/// A key's kind and fingerprint, read in the background.
struct KeyLine: View {
  let key: SSHKey
  @State private var info: KeyInfo.Info?

  var body: some View {
    Group {
      if !key.exists {
        Label("找不到文件 \(key.path)", systemImage: "exclamationmark.circle.fill").foregroundStyle(.red)
      } else if let info {
        if let p = info.problem { Text(p).foregroundStyle(.secondary) } else { Text("\(info.type) · \(info.fingerprint)").textSelection(.enabled) }
      } else {
        Text("正在读取…").foregroundStyle(.tertiary)
      }
    }
    .font(.caption.monospaced())
    .lineLimit(1).truncationMode(.middle)
    .task(id: key) {
      let k = key
      info = nil
      info = await Task.detached { KeyInfo.info(k) }.value
    }
  }
}

/// The private keys, each kept once; any number of servers log in with the same one. In a sheet.
struct KeysView: View {
  @ObservedObject var store = ProfileStore.shared
  var onClose: () -> Void
  @State private var deleting: SSHKey?
  @State private var message: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Image(systemName: "key.fill").font(.system(size: 18)).foregroundStyle(.white)
          .frame(width: 38, height: 38).background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.gradient))
        VStack(alignment: .leading, spacing: 2) {
          Text("私钥").font(.title3.weight(.semibold))
          Text("登记一次，编辑服务器时选它；多台服务器可以共用，在这里改了都跟着变").font(.callout).foregroundStyle(.secondary)
        }
        Spacer()
      }
      .padding(.horizontal, 22).padding(.vertical, 16)
      Divider()
      if store.keys.isEmpty {
        VStack(spacing: 10) {
          Image(systemName: "key").font(.system(size: 36)).foregroundStyle(.tertiary)
          Text("还没有私钥").font(.headline)
          Text("不登记也行：不选私钥的服务器照常用 ~/.ssh/config 和默认密钥。").font(.callout).foregroundStyle(.secondary)
          Button { add() } label: { Label("添加私钥…", systemImage: "plus") }.padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          VStack(spacing: 10) {
            ForEach($store.keys) { $k in row($k) }
          }
          .padding(22)
        }
      }
      Divider()
      HStack {
        if !store.keys.isEmpty { Button { add() } label: { Label("添加私钥…", systemImage: "plus") } }
        if let message { Text(message).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
        Spacer()
        Button("完成") { onClose() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
      }
      .controlSize(.large)
      .padding(.horizontal, 22).padding(.vertical, 14)
    }
    .frame(width: 620, height: 520)
    .alert(deleting.map { "删除「\($0.name)」？" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { k in
      Button("删除", role: .destructive) { store.removeKey(k.id) }
      Button("取消", role: .cancel) {}
    } message: { k in
      let used = store.users(of: k.id)
      Text(
        (used.isEmpty ? "" : "\(used.map { "「\($0.title)」" }.joined(separator: "、"))正在用它，删掉后\(used.count == 1 ? "这台服务器" : "这些服务器")改用 ~/.ssh/config 和默认密钥。")
          + "只是从列表里去掉，文件本身不会删除。"
      )
    }
  }

  private func row(_ k: Binding<SSHKey>) -> some View {
    let key = k.wrappedValue
    let used = store.users(of: key.id)
    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: "key.fill").foregroundStyle(.orange).frame(width: 28, height: 28)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.orange.opacity(0.14)))
      VStack(alignment: .leading, spacing: 3) {
        TextField("名称", text: k.name).textFieldStyle(.plain).font(.headline)
        Text(key.path).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        KeyLine(key: key)
        Text(used.isEmpty ? "还没有服务器在用" : "\(used.count) 台在用：\(used.map(\.title).joined(separator: "、"))")
          .font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 8)
      Menu {
        Button("复制公钥") { copyPublic(key) }
        Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: key.file)]) }.disabled(!key.exists)
        Button("更换文件…") {
          guard let path = pickKeyFile("为「\(key.name)」选择新的私钥文件") else { return }
          if let p = KeyFile.problem(SSHKey.of(path).file) { message = p; return }
          k.wrappedValue.path = (path as NSString).abbreviatingWithTildeInPath
          message = "已更换，用它的服务器下次连接时生效"
        }
        Divider()
        Button("删除…", role: .destructive) { deleting = key }
      } label: { Image(systemName: "ellipsis.circle").font(.system(size: 16)) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
  }

  private func add() {
    guard let path = pickKeyFile() else { return }
    let k = SSHKey.of(path)
    if let p = KeyFile.problem(k.file) { message = p; return }
    if let same = store.keys.first(where: { $0.file == k.file }) {
      message = "这个文件已经登记过了：「\(same.name)」"
      return
    }
    store.upsertKey(k)
    message = nil
  }

  private func copyPublic(_ k: SSHKey) {
    switch KeyInfo.publicKey(k) {
    case .success(let line):
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(line, forType: .string)
      message = "公钥已复制，加到服务器的 ~/.ssh/authorized_keys 里"
    case .failure(let e):
      message = e.message
    }
  }
}
