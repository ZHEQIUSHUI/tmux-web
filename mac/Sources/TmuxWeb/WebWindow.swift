import AppKit
import SwiftUI
import UserNotifications
import WebKit

/// What the overlay over the page shows: the server list, or the connection while it isn't up.
final class Status: ObservableObject {
  @Published var state: Tunnel.State = .idle
  @Published var title = ""
  /// the server list in front of the page
  @Published var showList = true
  /// the server connected (or connecting) now
  @Published var activeID: UUID?
  var actions = ServerActions()
  var retry: () -> Void = {}
  var edit: () -> Void = {}
  var list: () -> Void = {}
}

struct StatusView: View {
  @ObservedObject var status: Status
  var body: some View {
    if status.showList {
      ServerListView(status: status)
    } else {
      connection
    }
  }

  @ViewBuilder private var connection: some View {
    switch status.state {
    case .ready:
      EmptyView()
    case .idle, .connecting:
      card {
        ProgressView().controlSize(.large)
        Text("正在连接 \(status.title)…").font(.headline)
        Text("需要验证码或密码时会弹出对话框").font(.callout).foregroundStyle(.secondary)
        Button("取消") { status.list() }.keyboardShortcut(.cancelAction)
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
          Button("服务器列表") { status.list() }
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
  private var loadedBase: String?
  /// the page's address while connected
  var base: String? { loadedBase }
  private var popups: [NSWindow] = []
  private var overlay: NSView?

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
    // the overlay must not size the window: empty once connected, it shrank it to nothing
    overlay.sizingOptions = []
    self.overlay = overlay
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
    fixSize()
    // a double click on the title bar does what System Settings says, every time (the toolbar in
    // the title bar let some double clicks through to nowhere)
    NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
      guard let self, e.clickCount == 2, e.window === self.window, self.inTitleBar(e) else { return e }
      self.titleBarDoubleClick()
      return nil
    }
  }

  /// on the title bar, not on one of its buttons
  private func inTitleBar(_ e: NSEvent) -> Bool {
    let p = e.locationInWindow
    guard p.y > window.contentLayoutRect.maxY, let frame = window.contentView?.superview else { return false }
    var v = frame.hitTest(frame.convert(p, from: nil))
    while let x = v {
      if let c = x as? NSControl, !(c is NSTextField) || (c as? NSTextField)?.isEditable == true { return false }
      v = x.superview
    }
    return true
  }

  private var unzoomedFrame: NSRect?

  private func titleBarDoubleClick() {
    let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
    switch action {
    case "Minimize": window.miniaturize(nil)
    case "None": break
    default:
      // fill the screen, or back to the size before
      guard let screen = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
      let filled = abs(window.frame.width - screen.width) < 4 && abs(window.frame.height - screen.height) < 4
      if filled {
        let back = unzoomedFrame ?? NSRect(x: 0, y: 0, width: min(1280, screen.width - 80), height: min(820, screen.height - 80))
        window.setFrame(back, display: true, animate: true)
        if unzoomedFrame == nil { window.center() }
        unzoomedFrame = nil
      } else {
        unzoomedFrame = window.frame
        window.setFrame(screen, display: true, animate: true)
      }
    }
  }

  private static let reloadItem = NSToolbarItem.Identifier("reload")
  private static let listItem = NSToolbarItem.Identifier("servers")
  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [Self.listItem, .flexibleSpace, Self.reloadItem] }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [Self.listItem, .flexibleSpace, Self.reloadItem] }
  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
    if id == Self.listItem {
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "服务器"
      item.toolTip = "服务器列表（⌘L）"
      item.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: "服务器列表")
      item.target = self
      item.action = #selector(listAction)
      item.isBordered = true
      return item
    }
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
  /// the list, or back to the page of the server in use
  @objc private func listAction() {
    if status.showList, status.activeID != nil { showList(false) } else { status.list() }
  }

  func showList(_ on: Bool) {
    status.showList = on
    updateOverlay()
    window.title = on || status.title.isEmpty ? "tmux-web" : "tmux-web · \(status.title)"
  }

  /// the page shows only while connected and the list is away
  private func updateOverlay() {
    if case .ready = status.state, !status.showList { overlay?.isHidden = true } else { overlay?.isHidden = false }
  }

  /// another server (or none): the old one's page goes, so it never shows under the new one's name
  func reset() {
    loadedBase = nil
    web.load(URLRequest(url: URL(string: "about:blank")!))
  }

  func show(_ s: Tunnel.State, title: String) {
    status.title = title
    status.state = s
    // connected: nothing to show over the page (and nothing to catch clicks)
    updateOverlay()
    window.title = title.isEmpty || status.showList ? "tmux-web" : "tmux-web · \(title)"
    if case .ready(let base) = s {
      // the password / code dialog (another process) took the focus: come back to the front
      if loadedBase != base { bringBack() }
      // after a reconnect the page reconnects its own streams: only load when it isn't there yet
      if loadedBase != base || web.url == nil {
        loadedBase = base
        web.load(URLRequest(url: URL(string: base + "/")!))
        Updater.check(base: base, window: window)
      }
    }
    if case .failed = s { loadedBase = nil }
  }

  /// ⟳ / ⌘R: the page again, fresh from the server (and if it never came up, load it anew)
  func reload() {
    guard let base = loadedBase else { return }
    if web.url == nil || web.isLoading == false && web.title?.isEmpty != false {
      web.load(URLRequest(url: URL(string: base + "/")!, cachePolicy: .reloadIgnoringLocalCacheData))
    } else {
      web.reloadFromOrigin()
    }
  }

  // MARK: the page's own troubles: a blank window is never left behind

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    if w === web { Log.write("page loaded \(w.url?.absoluteString ?? "")") }
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { pageFailed(w, e) }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { pageFailed(w, e) }

  private func pageFailed(_ w: WKWebView, _ e: Error) {
    let ns = e as NSError
    Log.write("page failed \(ns.domain) \(ns.code) \(ns.localizedDescription)")
    // replaced by another load (a reload, a link) or turned into a download: not a failure
    if w !== web || ns.code == NSURLErrorCancelled || (ns.domain == "WebKitErrorDomain" && ns.code == 102) { return }
    status.state = .failed("网页加载失败：\(ns.localizedDescription)")
    updateOverlay()
    loadedBase = nil
  }

  /// WebKit's page process died (memory, a crash): it would stay blank — load the page again
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    Log.write("web content process terminated")
    guard w === web, let base = loadedBase else { return }
    web.load(URLRequest(url: URL(string: base + "/")!))
  }

  /// The window in front, whatever happened to it: closed (ordered out), minimized, under other
  /// windows, or off every screen (a display that is gone).
  /// A window too small to use (a size saved by an older version that shrank it): normal size, centered.
  private func fixSize() {
    if window.frame.width >= window.minSize.width && window.frame.height >= window.minSize.height { return }
    let s = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    window.setFrame(NSRect(x: 0, y: 0, width: min(1280, s.width - 40), height: min(820, s.height - 40)), display: true)
    window.center()
  }

  func bringBack() {
    if window.isMiniaturized { window.deminiaturize(nil) }
    fixSize()
    if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) {
      if let s = NSScreen.main?.visibleFrame {
        let size = NSSize(width: min(window.frame.width, s.width - 40), height: min(window.frame.height, s.height - 40))
        window.setFrame(NSRect(origin: .zero, size: size), display: false)
      }
      window.center()
    }
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    NSApp.activate(ignoringOtherApps: true)
    Log.write("bringBack \(describe())")
  }

  func describe() -> String {
    "visible=\(window.isVisible) mini=\(window.isMiniaturized) key=\(window.isKeyWindow) frame=\(NSStringFromRect(window.frame)) screens=\(NSScreen.screens.map { NSStringFromRect($0.frame) })"
  }

  func open(session id: Int) {
    if status.activeID != nil { showList(false) }
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
    if let url = a.request.url, let host = url.host, host != "127.0.0.1", host != loadedBase.flatMap({ URL(string: $0)?.host }), ["http", "https"].contains(url.scheme ?? "") {
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
