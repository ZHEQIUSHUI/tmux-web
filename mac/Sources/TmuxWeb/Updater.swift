import AppKit
import CryptoKit
import Foundation

/// Updates: version.json of the latest release, through our own server (the forward is there, and
/// GitHub may be slow) or else from GitHub; then the new app replaces this one and starts.
enum Updater {
  private static let github = "https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/"
  private static let every: TimeInterval = 6 * 3600
  static var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

  /// Look for a new version (at most every 6 hours unless asked); `quiet` = say nothing if none.
  static func check(base: String, window: NSWindow, asked: Bool = false) {
    let d = UserDefaults.standard
    if !asked, Date().timeIntervalSince1970 - d.double(forKey: "updateChecked") < every { return }
    Task {
      var found = await json("\(base)/_tw/api/app/version.json")
      if found == nil { found = await json(github + "version.json") }
      guard let info = found else {
        if asked { await alert(window, "检查更新失败", "服务器和 GitHub 都没取到版本信息，稍后再试。") }
        return
      }
      d.set(Date().timeIntervalSince1970, forKey: "updateChecked")
      let version = info["version"] as? String ?? ""
      guard newer(version, than: current), let mac = info["mac"] as? [String: Any] else {
        if asked { await alert(window, "已是最新版本", "当前版本 \(current)。") }
        return
      }
      if !asked, d.string(forKey: "updateSkipped") == version { return }
      await MainActor.run {
        let a = NSAlert()
        a.messageText = "发现新版本 \(version)"
        a.informativeText = (info["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "当前版本 \(current)"
        a.addButton(withTitle: "更新")
        a.addButton(withTitle: "以后")
        a.addButton(withTitle: "跳过这个版本")
        a.beginSheetModal(for: window) { r in
          if r == .alertFirstButtonReturn { Task { await install(base: base, mac: mac, window: window) } }
          if r == .alertThirdButtonReturn { UserDefaults.standard.set(version, forKey: "updateSkipped") }
        }
      }
    }
  }

  private static func install(base: String, mac: [String: Any], window: NSWindow) async {
    let app = Bundle.main.bundlePath
    // started from Downloads without moving it: macOS runs a read-only copy we can't replace
    if app.contains("/AppTranslocation/") || !FileManager.default.isWritableFile(atPath: (app as NSString).deletingLastPathComponent) {
      await alert(window, "请先把 App 移到「应用程序」", "现在运行的是系统临时复制的一份，没法原地更新。把 tmux-web.app 拖进「应用程序」，在终端执行 xattr -c /Applications/tmux-web.app，再从那里打开。")
      return
    }
    let name = mac["file"] as? String ?? "tmux-web-mac.zip"
    let sha = (mac["sha256"] as? String ?? "").lowercased()
    await MainActor.run { window.title = "tmux-web · 正在下载更新…" }
    var data: Data?
    for url in ["\(base)/_tw/api/app/download/\(name)", github + name] {
      if let d = await fetch(url), sha.isEmpty || SHA256.hash(data: d).map({ String(format: "%02x", $0) }).joined() == sha {
        data = d
        break
      }
    }
    guard let data else {
      await MainActor.run { window.title = "tmux-web" }
      await alert(window, "下载更新失败", "稍后再试。")
      return
    }
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("tmux-web-update-\(UUID().uuidString)")
    let zip = tmp.appendingPathComponent(name)
    do {
      try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
      try data.write(to: zip)
      try run("/usr/bin/ditto", ["-x", "-k", zip.path, tmp.path])
    } catch {
      await alert(window, "更新失败", "解压出错：\(error.localizedDescription)")
      return
    }
    let fresh = tmp.appendingPathComponent("tmux-web.app").path
    // after we quit: swap the app, clear the quarantine flag, start the new one
    let script = """
      while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done
      rm -rf "$1" && mv "$2" "$1" && xattr -cr "$1"
      open "$1"
      rm -rf "$3"
      """
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", script, "sh", app, fresh, tmp.path]
    try? p.run()
    await MainActor.run { NSApp.terminate(nil) }
  }

  /// "1.10.0" > "1.9.2"
  static func newer(_ a: String, than b: String) -> Bool {
    let x = a.split(separator: ".").map { Int($0) ?? 0 }, y = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<max(x.count, y.count) {
      let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
      if l != r { return l > r }
    }
    return false
  }

  private static func json(_ url: String) async -> [String: Any]? {
    guard let d = await fetch(url, timeout: 15) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  private static func fetch(_ url: String, timeout: TimeInterval = 300) async -> Data? {
    guard let u = URL(string: url) else { return nil }
    var req = URLRequest(url: u)
    req.timeoutInterval = timeout
    guard let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return d
  }

  private static func run(_ path: String, _ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { throw NSError(domain: "tmux-web", code: Int(p.terminationStatus)) }
  }

  @MainActor private static func alert(_ w: NSWindow, _ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.beginSheetModal(for: w)
  }
}
