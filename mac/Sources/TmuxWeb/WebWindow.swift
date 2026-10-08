import AppKit
import SwiftUI
import UserNotifications
import WebKit

/// What the overlay over the page shows while the forward isn't up.
final class Status: ObservableObject {
  @Published var state: Tunnel.State = .idle
  @Published var title = ""
  var retry: () -> Void = {}
  var edit: () -> Void = {}
}

struct StatusView: View {
  @ObservedObject var status: Status
  var body: some View {
    switch status.state {
    case .ready:
      EmptyView()
    case .idle, .connecting:
      card {
        ProgressView().controlSize(.large)
        Text("正在连接 \(status.title)…").font(.headline)
        Text("需要验证码或密码时会弹出对话框").font(.callout).foregroundStyle(.secondary)
      }
    case .reconnecting(let msg):
      VStack {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(msg).font(.callout)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .padding(.top, 10)
        Spacer()
      }
    case .failed(let msg):
      card {
        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 34)).foregroundStyle(.orange)
        Text("连不上 \(status.title)").font(.headline)
        Text(msg).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).textSelection(.enabled).frame(maxWidth: 420)
        HStack {
          Button("编辑服务器…") { status.edit() }
          Button("重试") { status.retry() }.keyboardShortcut(.defaultAction)
        }
      }
    }
  }

  private func card<C: View>(@ViewBuilder _ c: () -> C) -> some View {
    ZStack {
      Rectangle().fill(.background)
      VStack(spacing: 14, content: c).padding(30)
    }
  }
}

/// The main window: the page in a web view, the status on top of it.
final class WebWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate, NSToolbarDelegate {
  let window: NSWindow
  let web: WKWebView
  let status = Status()
  private var loadedPort: Int?
  private var popups: [NSWindow] = []

  override init() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default() // logins and settings persist
    let user = WKUserContentController()
    config.userContentController = user
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: .zero, configuration: config)
    web.allowsBackForwardNavigationGestures = false
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "tmux-web"
    window.setFrameAutosaveName("main")
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 480, height: 400)

    super.init()
    // the page tells us about its alerts (waiting / done …) → system notifications
    user.add(self, name: "twNotify")
    web.navigationDelegate = self
    web.uiDelegate = self
    window.delegate = self

    let overlay = NSHostingView(rootView: StatusView(status: status))
    let box = NSView()
    for v in [web, overlay] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(v)
      NSLayoutConstraint.activate([
        v.leadingAnchor.constraint(equalTo: box.leadingAnchor), v.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        v.topAnchor.constraint(equalTo: box.topAnchor), v.bottomAnchor.constraint(equalTo: box.bottomAnchor),
      ])
    }
    window.contentView = box
    // ⟳ in the title bar: the page again, fresh from the server (after tmux-web was updated)
    let bar = NSToolbar(identifier: "main")
    bar.delegate = self
    bar.displayMode = .iconOnly
    window.toolbar = bar
    window.toolbarStyle = .unifiedCompact
    if window.frame.origin == .zero { window.center() }
  }

  private static let reloadItem = NSToolbarItem.Identifier("reload")
  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.reloadItem] }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.reloadItem] }
  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
    guard id == Self.reloadItem else { return nil }
    let item = NSToolbarItem(itemIdentifier: id)
    item.label = "刷新"
    item.toolTip = "重新载入网页（⌘R）"
    item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")
    item.target = self
    item.action = #selector(reloadAction)
    item.isBordered = true
    return item
  }
  @objc private func reloadAction() { reload() }

  func show(_ s: Tunnel.State, title: String) {
    status.title = title
    status.state = s
    window.title = title.isEmpty ? "tmux-web" : "tmux-web · \(title)"
    if case .ready(let port) = s {
      // after a reconnect the page reconnects its own streams: only load when it isn't there yet
      if loadedPort != port || web.url == nil {
        loadedPort = port
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
      }
    }
    if case .failed = s { loadedPort = nil }
  }

  func reload() { web.reloadFromOrigin() }

  func open(session id: Int) {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.evaluateJavaScript("location.hash = '#/s/\(id)'")
  }

  // MARK: page → notifications

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard m.name == "twNotify", let n = m.body as? [String: Any] else { return }
    // only when you aren't looking at the window (the page shows its own alert then)
    if NSApp.isActive && window.isKeyWindow && !window.isMiniaturized { return }
    let content = UNMutableNotificationContent()
    content.title = (n["title"] as? String) ?? "tmux-web"
    content.body = (n["text"] as? String) ?? ""
    if let s = n["session"] as? String, !s.isEmpty { content.subtitle = s }
    if let id = n["sessionId"] as? Int { content.userInfo = ["sessionId": id] }
    content.sound = (n["kind"] as? String) == "waiting" ? .default : nil
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
      guard ok else { return }
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
  }

  // MARK: links, dialogs, files

  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if a.shouldPerformDownload { return decisionHandler(.download) }
    // other sites open in the browser
    if let url = a.request.url, let host = url.host, host != "127.0.0.1", ["http", "https"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disposition = (r.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(disposition.lowercased().hasPrefix("attachment") || !r.canShowMIMEType ? .download : .allow)
  }

  func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
  func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }

  func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var url = dir.appendingPathComponent(name)
    var n = 1
    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    while FileManager.default.fileExists(atPath: url.path) {
      n += 1
      url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
    }
    completionHandler(url)
  }

  func downloadDidFinish(_ d: WKDownload) {
    NSSound(named: "Glass")?.play()
  }

  /// target=_blank (an original image…): a window of its own, same login
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    let v = WKWebView(frame: .zero, configuration: c)
    v.uiDelegate = self
    v.navigationDelegate = self
    let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    win.isReleasedWhenClosed = false
    win.contentView = v
    win.title = a.request.url?.lastPathComponent ?? "tmux-web"
    win.center()
    win.makeKeyAndOrderFront(nil)
    popups.append(win)
    return v
  }

  func webViewDidClose(_ w: WKWebView) {
    popups.removeAll { win in
      if win.contentView === w { win.close(); return true }
      return false
    }
  }

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = p
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    a.window.initialFirstResponder = field
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  /// <input type=file> (attachments, uploads)
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = p.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
  }

  // closing the window keeps the app (and its forward, and notifications) running; the Dock icon brings it back
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }
}
