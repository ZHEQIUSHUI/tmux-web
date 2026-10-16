import AppKit
import CryptoKit
import Foundation
import SwiftUI

/// Updates: version.json of the latest release, through our own server (the forward is there, and
/// GitHub may be slow) or else from the mirrors; then the new app replaces this one and starts.
enum Updater {
  private static let github = "https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/"
  // Besides our server: GitHub, GitHub's download proxies in mainland China, and the release in
  // GHCR (CI puts it there too) through Nanjing University's mirror. Whoever serves a file, it's
  // checked against version.json's SHA-256.
  private static let proxies = ["https://ghfast.top/", "https://gh-proxy.com/", "https://gh.llkk.cc/", "https://ghproxy.net/"]
  private static let image = "zheqiushui/tmux-web-app"

  /// A place the release can be had: its version.json, and how to ask it for a file.
  private struct Mirror {
    let version: () async -> [String: Any]?
    let file: (_ name: String, _ sha: String) async -> URLRequest?
  }

  /// in the order they're tried for a file when none is known to be quicker
  private static let mirrors: [Mirror] = {
    func ghcr(_ host: String) -> Mirror {
      Mirror(version: { await ghcrVersion(host) }, file: { _, sha in await ghcrBlob(host, sha) })
    }
    func web(_ prefix: String) -> Mirror {
      Mirror(version: { await json(prefix + github + "version.json") }, file: { name, _ in URLRequest(url: URL(string: prefix + github + name)!, timeoutInterval: 30) })
    }
    return [ghcr("ghcr.nju.edu.cn")] + proxies.map(web) + [web(""), ghcr("ghcr.io")]
  }()

  /// version.json from every mirror at once: the first answer, and which mirror gave it
  private static func raceVersion() async -> ([String: Any], Int)? {
    await withTaskGroup(of: (Int, [String: Any]?).self) { g in
      for (i, m) in mirrors.enumerated() { g.addTask { (i, await m.version()) } }
      for await (i, info) in g where info?["version"] is String {
        g.cancelAll()
        return (info!, i)
      }
      return nil
    }
  }

  private static func ghcrToken() async -> String? {
    guard let d = await fetch("https://ghcr.io/token?service=ghcr.io&scope=repository:\(image):pull", timeout: 10) else { return nil }
    return ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["token"] as? String
  }

  /// CI keeps version.json in the manifest's annotations
  private static func ghcrVersion(_ host: String) async -> [String: Any]? {
    guard let t = await ghcrToken() else { return nil }
    var req = URLRequest(url: URL(string: "https://\(host)/v2/\(image)/manifests/latest")!, timeoutInterval: 15)
    req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    req.setValue("application/vnd.oci.image.manifest.v1+json", forHTTPHeaderField: "Accept")
    guard let d = await fetch(req), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let v = (m["annotations"] as? [String: Any])?["tw.version"] as? String
    else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(v.utf8))) as? [String: Any]
  }

  /// each file is a blob named by its SHA-256
  private static func ghcrBlob(_ host: String, _ sha: String) async -> URLRequest? {
    guard !sha.isEmpty, let t = await ghcrToken() else { return nil }
    var req = URLRequest(url: URL(string: "https://\(host)/v2/\(image)/blobs/sha256:\(sha)")!, timeoutInterval: 30)
    req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    return req
  }
  private static let every: TimeInterval = 6 * 3600
  static var current: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }

  /// Look for a new version (at most every 6 hours unless asked); not asked: say nothing if none.
  /// `base`: a connected server's address (nil: the mirrors only)
  static func check(base: String?, window: NSWindow, asked: Bool = false) {
    Task { @MainActor in start(base: base, window: window, asked: asked) }
  }

  @MainActor private static func start(base: String?, window: NSWindow, asked: Bool) {
    // already updating: bring that back
    if let s = sheet {
      if asked { s.makeKeyAndOrderFront(nil) }
      return
    }
    let d = UserDefaults.standard
    if !asked, Date().timeIntervalSince1970 - d.double(forKey: "updateChecked") < every { return }
    if asked { present(.checking, over: window) }
    Task {
      var found = base == nil ? nil : await json("\(base!)/_tw/api/app/version.json")
      // the mirror that answered first is likely the quickest for the download too
      var quickest: Int?
      if found == nil, let (info, i) = await raceVersion() {
        found = info
        quickest = i
      }
      let quick = quickest
      await MainActor.run {
        // asked: only while its sheet is still up (取消 closes it); not asked: not over another
        guard asked ? model.state == .checking : sheet == nil else { return }
        guard let info = found else {
          if asked { model.state = .failed("检查更新失败", "服务器、GitHub 和镜像都没取到版本信息，稍后再试。", retry: false) }
          return
        }
        d.set(Date().timeIntervalSince1970, forKey: "updateChecked")
        let version = info["version"] as? String ?? ""
        guard newer(version, than: current), let mac = info["mac"] as? [String: Any] else {
          if asked { model.state = .latest }
          return
        }
        if !asked, d.string(forKey: "updateSkipped") == version { return }
        offer = Offer(base: base, mac: mac, version: version, quickest: quick)
        let notes = (info["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? ""
        if asked { model.state = .offer(version, notes) } else { present(.offer(version, notes), over: window) }
      }
    }
  }

  /// what 更新 downloads
  private struct Offer {
    let base: String?
    let mac: [String: Any]
    let version: String
    let quickest: Int?
  }
  @MainActor private static var offer: Offer?
  @MainActor static let model = UpdateModel()
  @MainActor private static var sheet: NSWindow?
  @MainActor private static var job: Task<Void, Never>?

  @MainActor private static func present(_ state: UpdateModel.State, over window: NSWindow) {
    model.state = state
    let w = NSWindow(contentViewController: NSHostingController(rootView: UpdateView(model: model)))
    w.styleMask = [.titled]
    w.isReleasedWhenClosed = false
    sheet = w
    // over a sheet that's open there (a server's settings), or it would wait for that to close
    (window.attachedSheet ?? window).beginSheet(w)
  }

  @MainActor static func close() {
    job?.cancel()
    job = nil
    if let s = sheet { s.sheetParent?.endSheet(s) }
    sheet = nil
  }

  @MainActor static func skip() {
    if let v = offer?.version { UserDefaults.standard.set(v, forKey: "updateSkipped") }
    close()
  }

  /// 更新 / 重试
  @MainActor static func update() {
    guard let o = offer else { return }
    let app = Bundle.main.bundlePath
    // started from Downloads without moving it: macOS runs a read-only copy we can't replace
    if app.contains("/AppTranslocation/") || !FileManager.default.isWritableFile(atPath: (app as NSString).deletingLastPathComponent) {
      model.state = .failed("请先把 App 移到「应用程序」", "现在运行的是系统临时复制的一份，没法原地更新。把 tmux-web.app 拖进「应用程序」，在终端执行 xattr -c /Applications/tmux-web.app，再从那里打开。", retry: false)
      return
    }
    model.state = .downloading(from: "", done: 0, total: -1, speed: 0)
    job = Task { await install(o) }
  }

  private static func install(_ o: Offer) async {
    let name = o.mac["file"] as? String ?? "tmux-web-mac.zip"
    let sha = (o.mac["sha256"] as? String ?? "").lowercased()
    let size = (o.mac["size"] as? NSNumber)?.int64Value ?? -1
    var data: Data?
    // our server (it fetches from the quickest mirror itself), then the mirrors, the quick one first
    var order = Array(mirrors.indices)
    if let q = o.quickest { order = [q] + order.filter { $0 != q } }
    var tries: [() async -> URLRequest?] = []
    if let base = o.base { tries.append { URLRequest(url: URL(string: "\(base)/_tw/api/app/download/\(name)")!, timeoutInterval: 300) } }
    tries += order.map { i in { await mirrors[i].file(name, sha) } }
    for next in tries {
      if Task.isCancelled { return }
      guard let req = await next() else { continue }
      let from = o.base.map { req.url!.absoluteString.hasPrefix($0) } == true ? "服务器" : req.url?.host ?? ""
      await MainActor.run { model.state = .downloading(from: from, done: 0, total: -1, speed: 0) }
      let d = await Download.run(req) { done, total, speed in
        Task { @MainActor in
          if case .downloading = model.state { model.state = .downloading(from: from, done: done, total: total > 0 ? total : size, speed: speed) }
        }
      }
      if let d, sha.isEmpty || SHA256.hash(data: d).map({ String(format: "%02x", $0) }).joined() == sha {
        data = d
        break
      }
    }
    if Task.isCancelled { return }
    guard let data else {
      await MainActor.run { model.state = .failed("下载更新失败", "服务器、GitHub 和各个镜像都没下载成功，稍后再试。", retry: true) }
      return
    }
    await MainActor.run { model.state = .installing }
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("tmux-web-update-\(UUID().uuidString)")
    let zip = tmp.appendingPathComponent(name)
    do {
      try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
      try data.write(to: zip)
      try run("/usr/bin/ditto", ["-x", "-k", zip.path, tmp.path])
    } catch {
      await MainActor.run { model.state = .failed("更新失败", "解压出错：\(error.localizedDescription)", retry: true) }
      return
    }
    if Task.isCancelled { return }
    let app = Bundle.main.bundlePath
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
    return await fetch(URLRequest(url: u, timeoutInterval: timeout))
  }

  private static func fetch(_ req: URLRequest) async -> Data? {
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
}

/// One download, with its progress; nil when it fails or is cancelled (the task it runs in).
private final class Download: NSObject, URLSessionDataDelegate {
  private var data = Data()
  private var total: Int64 = -1
  private var ok = false
  private var lastAt = Date()
  private var lastDone = 0
  private var speed: Int64 = 0
  private let progress: (Int64, Int64, Int64) -> Void
  private var done: ((Data?) -> Void)?

  private init(_ progress: @escaping (Int64, Int64, Int64) -> Void) { self.progress = progress }

  /// `progress`(bytes so far, total or -1, bytes a second), a few times a second
  static func run(_ req: URLRequest, progress: @escaping (Int64, Int64, Int64) -> Void) async -> Data? {
    let d = Download(progress)
    let session = URLSession(configuration: .default, delegate: d, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let task = session.dataTask(with: req)
    return await withTaskCancellationHandler {
      await withCheckedContinuation { c in
        d.done = { c.resume(returning: $0) }
        task.resume()
      }
    } onCancel: { task.cancel() }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    ok = (response as? HTTPURLResponse)?.statusCode == 200
    total = response.expectedContentLength
    if ok { progress(0, total, 0) }
    completionHandler(ok ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    data.append(chunk)
    let now = Date()
    let t = now.timeIntervalSince(lastAt)
    if t > 0.2 {
      let s = Int64(Double(data.count - lastDone) / t)
      speed = speed == 0 ? s : (speed * 2 + s) / 3
      lastAt = now
      lastDone = data.count
      progress(Int64(data.count), total, speed)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let good = ok && error == nil && (total < 0 || Int64(data.count) == total)
    if good { progress(Int64(data.count), total, speed) }
    done?(good ? data : nil)
    done = nil
  }
}

/// What the update sheet shows.
@MainActor final class UpdateModel: ObservableObject {
  enum State: Equatable {
    case checking
    case latest
    case failed(String, String, retry: Bool)
    case offer(String, String)
    /// `total` < 0: not known yet (connecting, or the server is fetching it first)
    case downloading(from: String, done: Int64, total: Int64, speed: Int64)
    case installing
  }
  @Published var state: State = .checking
}

/// The update, from 检查更新 to the restart: what was found, the download's progress, what went wrong.
struct UpdateView: View {
  @ObservedObject var model: UpdateModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        icon
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.title3.weight(.semibold))
          Text("当前版本 \(Updater.current)").font(.callout).foregroundStyle(.secondary)
        }
      }
      content
      HStack {
        if case .offer = model.state { Button("跳过这个版本") { Updater.skip() } }
        Spacer()
        buttons
      }
      .controlSize(.large)
    }
    .padding(22)
    .frame(width: 460)
  }

  private var title: String {
    switch model.state {
    case .checking: return "正在检查更新…"
    case .latest: return "已是最新版本"
    case .failed(let t, _, _): return t
    case .offer(let v, _): return "发现新版本 \(v)"
    case .downloading: return "正在下载更新…"
    case .installing: return "正在安装…"
    }
  }

  @ViewBuilder private var icon: some View {
    switch model.state {
    case .latest: Image(systemName: "checkmark.circle.fill").font(.system(size: 32)).foregroundStyle(.green)
    case .failed: Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 30)).foregroundStyle(.orange)
    default: Image(systemName: "arrow.down.circle.fill").font(.system(size: 32)).foregroundStyle(Color.accentColor)
    }
  }

  @ViewBuilder private var content: some View {
    switch model.state {
    case .checking:
      ProgressView().progressViewStyle(.linear)
    case .latest:
      EmptyView()
    case .failed(_, let text, _):
      Text(text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    case .offer(_, let notes):
      if !notes.isEmpty {
        Text(notes).lineLimit(14).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading).padding(10)
          .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
          .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.08)))
      }
    case .downloading(let from, let done, let total, let speed):
      VStack(alignment: .leading, spacing: 6) {
        if total > 0 {
          let f = min(1, Double(done) / Double(total))
          ProgressView(value: f).progressViewStyle(.linear)
          HStack {
            Text("\(Int(f * 100))%").fontWeight(.semibold).monospacedDigit()
            Spacer()
            Text("\(mb(done)) / \(mb(total))" + (speed > 0 ? " · \(rate(speed))" : "")).monospacedDigit()
          }
        } else {
          ProgressView().progressViewStyle(.linear)
          Text(from.isEmpty ? "正在准备…" : done > 0 ? "已下载 \(mb(done))" : from == "服务器" ? "服务器正在取安装包…" : "正在连接…")
        }
        if !from.isEmpty { Text("来源：\(from)").font(.caption).foregroundStyle(.secondary) }
      }
    case .installing:
      VStack(alignment: .leading, spacing: 6) {
        ProgressView().progressViewStyle(.linear)
        Text("已下载并校验，正在替换，马上重新打开。").foregroundStyle(.secondary)
      }
    }
  }

  @ViewBuilder private var buttons: some View {
    switch model.state {
    case .checking, .downloading:
      Button("取消") { Updater.close() }.keyboardShortcut(.cancelAction)
    case .latest:
      Button("好") { Updater.close() }.keyboardShortcut(.defaultAction)
    case .failed(_, _, let retry):
      if retry {
        Button("关闭") { Updater.close() }.keyboardShortcut(.cancelAction)
        Button("重试") { Updater.update() }.keyboardShortcut(.defaultAction)
      } else {
        Button("好") { Updater.close() }.keyboardShortcut(.defaultAction)
      }
    case .offer:
      Button("以后") { Updater.close() }.keyboardShortcut(.cancelAction)
      Button("更新") { Updater.update() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
    case .installing:
      EmptyView()
    }
  }

  private func mb(_ b: Int64) -> String { String(format: "%.1f MB", Double(b) / 1_048_576) }
  private func rate(_ b: Int64) -> String { b >= 1_048_576 ? String(format: "%.1f MB/s", Double(b) / 1_048_576) : "\(b / 1024) KB/s" }
}
