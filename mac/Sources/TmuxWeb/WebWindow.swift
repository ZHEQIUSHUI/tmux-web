import AppKit
import SwiftUI
import UserNotifications
import WebKit

/// What covers the page: home, or the connecting screen of the server in front (nothing once its
/// page is up).
struct RootView: View {
  @ObservedObject var model: AppModel
  @ObservedObject var store = ProfileStore.shared

  var body: some View {
    if model.showHome {
      HomeView(model: model)
    } else if let id = model.activeID, let p = store.profiles.first(where: { $0.id == id }), let info = model.conns[id], !info.live {
      ConnectingView(profile: p, info: info, actions: model.actions)
    } else {
      Color.clear
    }
  }
}

/// The note over a page whose connection is coming back.
struct BannerView: View {
  @ObservedObject var model: AppModel
  var body: some View {
    if !model.showHome, case .reconnecting(let text)? = model.active?.state {
      ReconnectingBanner(text: text)
    }
  }
}

/// The servers in use, a tab each in the toolbar (no menu to open): a click brings one to the
/// front, a right click edits or disconnects it.
struct ServerTabs: View {
  @ObservedObject var model: AppModel
  @ObservedObject var store = ProfileStore.shared

  var body: some View {
    HStack(spacing: 4) {
      ForEach(model.order.compactMap { id in store.profiles.first { $0.id == id } }) { p in
        ServerTab(title: p.title, info: model.conns[p.id], selected: !model.showHome && model.activeID == p.id) {
          model.actions.connect(p)
        }
        .contextMenu {
          Button("编辑此服务器…") { model.actions.edit(p, nil) }
          Button("断开") { model.actions.disconnect(p.id) }
        }
      }
    }
    .fixedSize()
  }
}

private struct ServerTab: View {
  let title: String
  let info: ConnInfo?
  let selected: Bool
  let action: () -> Void
  @State private var hover = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Circle().fill(Color(nsColor: WebWindow.color(info))).frame(width: 7, height: 7)
        Text(title).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
      }
      .font(.system(size: 12, weight: selected ? .semibold : .regular))
      .foregroundStyle(selected ? Color.primary : Color.secondary)
      .padding(.horizontal, 10).frame(height: 24)
      .background(
        RoundedRectangle(cornerRadius: 6)
          .fill(selected ? Color.primary.opacity(0.1) : hover ? Color.primary.opacity(0.05) : .clear)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .help(title)
  }
}

/// What happened to a page.
enum PageEvent {
  case loaded
  case failed(String)
  case crashed
}

/// The main window: the pages of the servers in use (one shows), home and the connecting screens
/// over them, a toolbar to switch.
final class WebWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate, NSToolbarDelegate, NSMenuDelegate {
  let window: NSWindow
  let model: AppModel
  private let pages = NSView()
  private var overlay: NSView!
  private var popups: [NSWindow] = []

  // the app's side of things
  var connection: (WKWebView) -> Connection? = { _ in nil }
  var pageEvent: (Connection, PageEvent) -> Void = { _, _ in }
  var moreMenu: () -> NSMenu = { NSMenu() }

  init(model: AppModel) {
    self.model = model
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "tmux-web"
    window.setFrameAutosaveName("main")
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 560, height: 420)
    super.init()
    window.delegate = self

    let overlay = NSHostingView(rootView: RootView(model: model))
    // the overlay must not size the window: empty once connected, it shrank it to nothing
    overlay.sizingOptions = []
    self.overlay = overlay
    let banner = NSHostingView(rootView: BannerView(model: model))
    banner.sizingOptions = []
    let box = NSView()
    for v in [pages, overlay] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(v)
      NSLayoutConstraint.activate([
        v.leadingAnchor.constraint(equalTo: box.leadingAnchor), v.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        v.topAnchor.constraint(equalTo: box.topAnchor), v.bottomAnchor.constraint(equalTo: box.bottomAnchor),
      ])
    }
    // the banner: a strip at the top, so the page under the rest of it still takes clicks
    banner.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(banner)
    NSLayoutConstraint.activate([
      banner.centerXAnchor.constraint(equalTo: box.centerXAnchor), banner.topAnchor.constraint(equalTo: box.topAnchor),
      banner.widthAnchor.constraint(equalToConstant: 360), banner.heightAnchor.constraint(equalToConstant: 60),
    ])
    window.contentView = box

    let bar = NSToolbar(identifier: "main2")
    bar.delegate = self
    bar.displayMode = .iconOnly
    bar.allowsUserCustomization = false
    window.toolbar = bar
    window.toolbarStyle = .unified
    window.titleVisibility = .hidden
    if window.frame.origin == .zero { window.center() }
    fixSize()
    // a double click on the title bar does what System Settings says, every time (the toolbar in
    // the title bar let some double clicks through to nowhere)
    NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
      guard let self, e.clickCount == 2, e.window === self.window, self.inTitleBar(e) else { return e }
      self.titleBarDoubleClick()
      return nil
    }
    refresh()
  }

  /// A page for a server: logins and settings persist, the page's alerts reach us.
  func makeWebView() -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.userContentController.add(self, name: "twNotify")
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    let web = WKWebView(frame: .zero, configuration: config)
    web.allowsBackForwardNavigationGestures = false
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self
    web.uiDelegate = self
    web.isHidden = true
    web.translatesAutoresizingMaskIntoConstraints = false
    pages.addSubview(web)
    NSLayoutConstraint.activate([
      web.leadingAnchor.constraint(equalTo: pages.leadingAnchor), web.trailingAnchor.constraint(equalTo: pages.trailingAnchor),
      web.topAnchor.constraint(equalTo: pages.topAnchor), web.bottomAnchor.constraint(equalTo: pages.bottomAnchor),
    ])
    return web
  }

  func dropWebView(_ web: WKWebView) {
    web.configuration.userContentController.removeScriptMessageHandler(forName: "twNotify")
    web.removeFromSuperview()
  }

  /// the page in front: the active server's
  var front: WKWebView? { model.showHome ? nil : pages.subviews.first { !$0.isHidden } as? WKWebView }

  /// After any change of the model: which page shows, the overlay, the toolbar.
  func refresh(page: WKWebView? = nil) {
    if let page { for v in pages.subviews { v.isHidden = v !== page } }
    let live = !model.showHome && (model.active?.live ?? false)
    overlay.isHidden = live
    if model.showHome { for v in pages.subviews { v.isHidden = true } }
    let p = model.activeID.flatMap { id in ProfileStore.shared.profiles.first { $0.id == id } }
    window.title = model.showHome || p == nil ? "tmux-web" : "tmux-web · \(p!.title)"
    reloadItem?.isEnabled = live
  }

  // MARK: toolbar: 首页, the tabs of the servers in use … ⟳ ⋯

  private static let homeID = NSToolbarItem.Identifier("home")
  private static let tabsID = NSToolbarItem.Identifier("tabs")
  private static let reloadID = NSToolbarItem.Identifier("reload")
  private static let moreID = NSToolbarItem.Identifier("more")
  private weak var reloadItem: NSToolbarItem?

  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [Self.homeID, Self.tabsID, .flexibleSpace, Self.reloadID, Self.moreID] }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(t) }

  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
    switch id {
    case Self.homeID:
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "首页"
      item.toolTip = "全部服务器（⌘L）"
      item.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: "首页")
      item.target = self
      item.action = #selector(homeAction)
      item.isBordered = true
      return item
    case Self.tabsID:
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "服务器"
      item.view = NSHostingView(rootView: ServerTabs(model: model))
      return item
    case Self.reloadID:
      let item = NSToolbarItem(itemIdentifier: id)
      item.label = "刷新"
      item.toolTip = "重新载入网页（⌘R）"
      item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")
      item.target = self
      item.action = #selector(reloadAction)
      item.isBordered = true
      item.autovalidates = false
      reloadItem = item
      return item
    case Self.moreID:
      let item = NSMenuToolbarItem(itemIdentifier: id)
      item.label = "更多"
      item.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "更多")
      item.showsIndicator = false
      let menu = NSMenu()
      menu.delegate = self
      item.menu = menu
      return item
    default:
      return nil
    }
  }

  var homeTapped: () -> Void = {}
  @objc private func homeAction() { homeTapped() }
  @objc private func reloadAction() { reload() }

  /// the ⋯ menu, made fresh as it opens
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let fresh = moreMenu()
    let items = fresh.items
    fresh.removeAllItems()
    items.forEach(menu.addItem)
  }

  /// the colored dot of a connection's state (gray: none)
  static func color(_ info: ConnInfo?) -> NSColor {
    guard let info else { return .tertiaryLabelColor }
    switch info.state {
    case .ready: return info.pageLoaded ? .systemGreen : .systemOrange
    case .reconnecting, .connecting, .idle: return .systemOrange
    case .failed: return .systemRed
    }
  }

  static func dot(_ info: ConnInfo?) -> NSImage {
    let color = Self.color(info)
    let image = NSImage(size: NSSize(width: 9, height: 9), flipped: false) { r in
      color.setFill()
      NSBezierPath(ovalIn: r.insetBy(dx: 0.5, dy: 0.5)).fill()
      return true
    }
    image.isTemplate = false
    return image
  }

  /// ⟳ / ⌘R: the page in front again, fresh from the server
  func reload() {
    guard let web = front, let c = connection(web), let base = c.loadedBase else { return }
    if web.url == nil || web.url?.absoluteString == "about:blank" || (!web.isLoading && web.title?.isEmpty != false) {
      web.load(URLRequest(url: URL(string: base + "/")!, cachePolicy: .reloadIgnoringLocalCacheData))
    } else {
      web.reloadFromOrigin()
    }
  }

  // MARK: the window itself

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

  /// A window too small to use (a size saved by an older version that shrank it): normal size, centered.
  private func fixSize() {
    if window.frame.width >= window.minSize.width && window.frame.height >= window.minSize.height { return }
    let s = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    window.setFrame(NSRect(x: 0, y: 0, width: min(1280, s.width - 40), height: min(820, s.height - 40)), display: true)
    window.center()
  }

  /// The window in front, whatever happened to it: closed (ordered out), minimized, under other
  /// windows, or off every screen (a display that is gone).
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
  }

  func describe() -> String {
    "visible=\(window.isVisible) mini=\(window.isMiniaturized) key=\(window.isKeyWindow) frame=\(NSStringFromRect(window.frame)) screens=\(NSScreen.screens.map { NSStringFromRect($0.frame) })"
  }

  // MARK: the pages' troubles: a blank window is never left behind

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    guard let c = connection(w), let base = c.loadedBase, w.url?.absoluteString.hasPrefix(base) == true else { return }
    Log.write("page loaded \(w.url?.absoluteString ?? "")")
    pageEvent(c, .loaded)
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { pageFailed(w, e) }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { pageFailed(w, e) }

  private func pageFailed(_ w: WKWebView, _ e: Error) {
    let ns = e as NSError
    Log.write("page failed \(ns.domain) \(ns.code) \(ns.localizedDescription)")
    // replaced by another load (a reload, a link) or turned into a download: not a failure
    if ns.code == NSURLErrorCancelled || (ns.domain == "WebKitErrorDomain" && ns.code == 102) { return }
    guard let c = connection(w), c.loadedBase != nil else { return }
    pageEvent(c, .failed("网页加载失败：\(ns.localizedDescription)"))
  }

  /// WebKit's page process died (memory, a crash): it would stay blank — load the page again
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    Log.write("web content process terminated")
    if let c = connection(w) { pageEvent(c, .crashed) }
  }

  // MARK: page → notifications

  func userContentController(_ uc: WKUserContentController, didReceive m: WKScriptMessage) {
    guard m.name == "twNotify", let n = m.body as? [String: Any], let web = m.webView, let c = connection(web) else { return }
    // only when you aren't looking at that page (it shows its own alert then)
    if NSApp.isActive && window.isKeyWindow && !window.isMiniaturized && front === web { return }
    let content = UNMutableNotificationContent()
    content.title = (n["title"] as? String) ?? "tmux-web"
    content.body = (n["text"] as? String) ?? ""
    let session = (n["session"] as? String) ?? ""
    // with several servers, which one it's from
    let several = model.conns.count > 1
    content.subtitle = [several ? c.profile.title : "", session].filter { !$0.isEmpty }.joined(separator: " · ")
    var info: [String: Any] = ["server": c.profile.id.uuidString]
    if let id = n["sessionId"] as? Int { info["sessionId"] = id }
    content.userInfo = info
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
    let own = connection(w)?.loadedBase.flatMap { URL(string: $0)?.host }
    if let url = a.request.url, let host = url.host, host != "127.0.0.1", host != own, ["http", "https"].contains(url.scheme ?? "") {
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
    a.beginSheetModal(for: w.window ?? window) { _ in completionHandler() }
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: w.window ?? window) { r in completionHandler(r == .alertFirstButtonReturn) }
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
    a.beginSheetModal(for: w.window ?? window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  /// <input type=file> (attachments, uploads)
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = p.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.beginSheetModal(for: w.window ?? window) { r in completionHandler(r == .OK ? panel.urls : nil) }
  }

  // closing the window keeps the app (and its connections, and notifications) running; the Dock icon brings it back
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }
}
