import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
  private let model = AppModel()
  private var main: WebWindow!
  /// the servers in use, each with its forward and its page
  private var conns: [UUID: Connection] = [:]
  private var editor: NSWindow?
  private let serverMenu = NSMenu(title: "服务器")
  private var probeTimer: Timer?
  private var store: ProfileStore { .shared }
  /// the server in front
  private var active: Connection? { model.activeID.flatMap { conns[$0] } }

  func applicationDidFinishLaunching(_ n: Notification) {
    EasyTierFiles.removeStale()
    main = WebWindow(model: model)
    main.connection = { [weak self] w in self?.conns.values.first { $0.web === w } }
    main.pageEvent = { [weak self] c, e in self?.page(c, e) }
    main.moreMenu = { [weak self] in self?.moreMenu() ?? NSMenu() }
    main.homeTapped = { [weak self] in self?.goHome() }
    model.actions = ServerActions(
      connect: { [weak self] p in self?.open(p) },
      edit: { [weak self] p, mode in self?.openEditor(p, mode: mode) },
      duplicate: { [weak self] p in self?.duplicate(p) },
      remove: { [weak self] p in self?.remove(p) },
      disconnect: { [weak self] id in self?.disconnect(id) },
      retry: { [weak self] in self?.reconnect() },
      editActive: { [weak self] in self?.editCurrent() },
      home: { [weak self] in self?.goHome() },
      checkUpdates: { [weak self] in self?.checkUpdates() },
      keys: { [weak self] in self?.openKeys() },
      share: { [weak self] in self?.openShare() }
    )
    UNUserNotificationCenter.current().delegate = self
    buildMenu()
    main.window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // always home first
    goHome()
  }

  func applicationWillTerminate(_ n: Notification) { conns.values.forEach { $0.tunnel.stop() } }

  // the Dock icon always brings the window back (closed, minimized, behind others, off screen)
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    Log.write("reopen visible=\(hasVisibleWindows) \(main.describe())")
    main.bringBack()
    return false
  }

  /// right-click on the Dock icon: home, and the servers in use
  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let m = NSMenu()
    m.addItem(withTitle: "全部服务器", action: #selector(homeAction), keyEquivalent: "")
    let used = store.sorted.filter { conns[$0.id] != nil }
    if !used.isEmpty { m.addItem(.separator()) }
    for p in used { m.addItem(serverItem(p)) }
    return m
  }

  // MARK: servers

  /// Its page: one already in use just comes to the front; otherwise it connects (others stay up).
  private func open(_ p: Profile) {
    guard p.isComplete else { return openEditor(p, mode: nil) }
    store.touch(p.id)
    let c: Connection
    if let existing = conns[p.id] {
      c = existing
      if case .failed = c.state { c.start(p) }
      if case .idle = c.state { c.start(p) }
    } else {
      c = Connection(profile: p, web: main.makeWebView())
      c.tunnel.onState = { [weak self, weak c] s in
        guard let self, let c else { return }
        self.tunnelChanged(c, s)
      }
      conns[p.id] = c
      model.order.append(p.id)
      c.start(p)
    }
    model.activeID = p.id
    model.showHome = false
    stopProbing()
    publish(c)
    main.refresh(page: c.web)
  }

  private func tunnelChanged(_ c: Connection, _ s: Tunnel.State) {
    // a stopped connection's last word
    guard conns[c.profile.id] === c else { return }
    Log.write("state \(c.profile.title) \(s)")
    c.state = s
    if case .ready(let base) = s, c.loadedBase != base || c.web.url == nil || c.web.url?.absoluteString == "about:blank" {
      // after a reconnect the page reconnects its own streams: only load when it isn't there yet
      c.loadedBase = base
      c.pageLoaded = false
      c.web.load(URLRequest(url: URL(string: base + "/")!))
      Updater.check(base: base, window: main.window)
      // a password dialog (another process) may have taken the focus
      if model.activeID == c.profile.id && !model.showHome { main.bringBack() }
    }
    if case .failed = s {
      c.loadedBase = nil
      c.pageLoaded = false
    }
    publish(c)
  }

  private func page(_ c: Connection, _ e: PageEvent) {
    switch e {
    case .loaded:
      c.pageLoaded = true
      if let sid = c.pendingSession {
        c.pendingSession = nil
        c.web.evaluateJavaScript("location.hash = '#/s/\(sid)'")
      }
    case .failed(let why):
      c.state = .failed(why)
      c.loadedBase = nil
      c.pageLoaded = false
    case .crashed:
      if let base = c.loadedBase { c.web.load(URLRequest(url: URL(string: base + "/")!)) }
    }
    publish(c)
  }

  private func publish(_ c: Connection) {
    model.conns[c.profile.id] = c.info
    main.refresh()
  }

  /// the server in front again from the start (重试 / 重新连接)
  @objc private func reconnect() {
    guard let c = active, let p = store.profiles.first(where: { $0.id == c.profile.id }) else { return }
    c.start(p)
    model.showHome = false
    publish(c)
    main.refresh(page: c.web)
  }

  private func disconnect(_ id: UUID) {
    guard let c = conns.removeValue(forKey: id) else { return }
    c.tunnel.onState = nil
    c.stop()
    main.dropWebView(c.web)
    model.conns[id] = nil
    model.order.removeAll { $0 == id }
    if model.activeID == id {
      model.activeID = nil
      goHome()
    } else {
      main.refresh()
    }
  }

  /// Home; the servers in use stay connected (their cards say so, a click goes back).
  private func goHome() {
    model.showHome = true
    main.refresh()
    main.bringBack()
    startProbing()
  }

  @objc private func homeAction() { goHome() }
  @objc private func newServer() { openEditor(nil, mode: nil) }
  @objc private func editCurrent() {
    guard let id = model.activeID, !model.showHome, let p = store.profiles.first(where: { $0.id == id }) else { return }
    openEditor(p, mode: nil)
  }
  @objc private func disconnectCurrent() { if let id = model.activeID, !model.showHome { disconnect(id) } }
  @objc private func disconnectAll() { conns.keys.forEach(disconnect) }
  @objc private func openInBrowser() {
    if let base = active?.loadedBase, let url = URL(string: base + "/") { NSWorkspace.shared.open(url) }
  }

  @objc private func pickServer(_ item: NSMenuItem) {
    guard let id = item.representedObject as? UUID, let p = store.profiles.first(where: { $0.id == id }) else { return }
    main.bringBack()
    open(p)
  }

  // MARK: is it up? (the cards' dots)

  private func startProbing() {
    probeAll()
    probeTimer?.invalidate()
    probeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.probeAll() }
  }

  private func stopProbing() {
    probeTimer?.invalidate()
    probeTimer = nil
  }

  private func probeAll() {
    for p in store.profiles { probe(p) }
  }

  private func probe(_ p: Profile) {
    // the last answer stays shown while asking again
    if model.probes[p.id] == nil { model.probes[p.id] = .checking }
    Task {
      let r = await Prober.check(p)
      await MainActor.run { self.model.probes[p.id] = r }
    }
  }

  // MARK: add, edit, copy, delete

  private func duplicate(_ p: Profile) {
    var c = p
    c.id = UUID()
    c.name = "\(p.title) 副本"
    c.lastUsed = nil
    if !c.isDirect { c.localPort = store.freeLocalPort() }
    openEditor(c, mode: nil, password: Keychain.password(for: p.id))
  }

  private func remove(_ p: Profile) {
    let a = NSAlert()
    a.messageText = "删除「\(p.title)」？"
    a.informativeText = conns[p.id] != nil ? "它会先断开。设置和保存的密码都会删掉。" : "它的设置和保存的密码都会删掉。"
    a.addButton(withTitle: "删除").hasDestructiveAction = true
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: main.window) { [weak self] r in
      guard let self, r == .alertFirstButtonReturn else { return }
      self.disconnect(p.id)
      self.store.remove(p.id)
      self.model.probes[p.id] = nil
    }
  }

  /// The form in a sheet: nil makes a new server (of `mode`, if given).
  private func openEditor(_ p: Profile?, mode: String?, password: String? = nil) {
    main.bringBack()
    if let e = editor { return e.makeKeyAndOrderFront(nil) }
    var draft = p ?? Profile()
    if p == nil {
      draft.localPort = store.freeLocalPort()
      if let mode { draft.mode = mode }
    }
    let isNew = !store.profiles.contains { $0.id == draft.id }
    var taken: [Int: String] = [:]
    for o in store.profiles where !o.isDirect && o.id != draft.id { taken[o.localPort] = o.title }
    let id = draft.id
    let view = SettingsView(
      draft: draft, isNew: isNew, password: password ?? Keychain.password(for: draft.id) ?? "", takenPorts: taken,
      onDone: { [weak self] p, pw, go in self?.saved(p, pw, connect: go) },
      onCancel: { [weak self] in self?.closeEditor() },
      onDelete: isNew ? nil : { [weak self] in
        guard let self, let p = self.store.profiles.first(where: { $0.id == id }) else { return }
        self.closeEditor()
        self.remove(p)
      }
    )
    let w = NSWindow(contentViewController: NSHostingController(rootView: view))
    w.styleMask = [.titled]
    w.isReleasedWhenClosed = false
    editor = w
    main.window.beginSheet(w)
  }

  /// The key list in a sheet.
  @objc private func openKeys() {
    main.bringBack()
    if let e = editor { return e.makeKeyAndOrderFront(nil) }
    let w = NSWindow(contentViewController: NSHostingController(rootView: KeysView(onClose: { [weak self] in self?.closeEditor() })))
    w.styleMask = [.titled]
    w.isReleasedWhenClosed = false
    editor = w
    main.window.beginSheet(w)
  }

  /// The LAN sharing sheet: send and receive in one place.
  @objc private func openShare() {
    main.bringBack()
    if let e = editor { return e.makeKeyAndOrderFront(nil) }
    let view = ConfigShareView(onClose: { [weak self] in self?.closeEditor() })
    let w = NSWindow(contentViewController: NSHostingController(rootView: view))
    w.styleMask = [.titled]
    w.isReleasedWhenClosed = false
    editor = w
    main.window.beginSheet(w)
  }

  private func closeEditor() {
    if let e = editor { main.window.endSheet(e) }
    editor = nil
  }

  private func saved(_ p: Profile, _ pw: String, connect go: Bool) {
    let before = store.profiles.first { $0.id == p.id }
    let pwBefore = Keychain.password(for: p.id) ?? ""
    store.upsert(p)
    Keychain.setPassword(pw, for: p.id)
    closeEditor()
    model.probes[p.id] = nil
    if model.showHome { probe(p) }
    // in use: new connection settings mean connecting again, where you are (home or its page)
    if let c = conns[p.id] {
      if !sameConnection(before, p) || pwBefore != pw {
        c.start(p)
        publish(c)
      } else {
        c.profile = p
        main.refresh()
      }
    }
    if go { open(p) }
  }

  /// the same as far as connecting goes (a new name doesn't need a new connection)
  private func sameConnection(_ a: Profile?, _ b: Profile) -> Bool {
    guard var a else { return false }
    a.name = b.name
    a.lastUsed = b.lastUsed
    return a == b
  }

  @objc private func checkUpdates() {
    Updater.check(base: active?.loadedBase ?? conns.values.compactMap(\.loadedBase).first, window: main.window, asked: true)
  }
  @objc private func reloadPage() { main.reload() }
  @objc private func showMain() { main.bringBack() }

  // MARK: notifications: a click opens the server and the session

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let info = r.notification.request.content.userInfo
    if let sid = (info["server"] as? String).flatMap(UUID.init(uuidString:)), let p = store.profiles.first(where: { $0.id == sid }) {
      main.bringBack()
      open(p)
      if let session = info["sessionId"] as? Int, let conn = conns[sid] {
        if conn.pageLoaded { conn.web.evaluateJavaScript("location.hash = '#/s/\(session)'") } else { conn.pendingSession = session }
      }
    }
    done()
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  // MARK: menus (the Edit menu also makes ⌘C / ⌘V work in the page)

  private func serverItem(_ p: Profile) -> NSMenuItem {
    let item = NSMenuItem(title: p.title, action: #selector(pickServer(_:)), keyEquivalent: "")
    item.target = self
    item.representedObject = p.id
    item.image = WebWindow.dot(conns[p.id]?.info)
    item.state = p.id == model.activeID && !model.showHome ? .on : .off
    return item
  }

  /// the title bar's ⋯
  private func moreMenu() -> NSMenu {
    let m = NSMenu()
    m.autoenablesItems = false
    let onServer = !model.showHome && active != nil
    m.addItem(item("编辑此服务器…", #selector(editCurrent), enabled: onServer))
    m.addItem(item("在浏览器中打开", #selector(openInBrowser), enabled: onServer && active?.loadedBase != nil))
    m.addItem(item("断开此服务器", #selector(disconnectCurrent), enabled: onServer))
    if conns.count > 1 { m.addItem(item("断开全部（\(conns.count) 台）", #selector(disconnectAll))) }
    m.addItem(.separator())
    m.addItem(item("私钥…", #selector(openKeys)))
    m.addItem(item("共享配置…", #selector(openShare)))
    m.addItem(item("检查更新…", #selector(checkUpdates)))
    return m
  }

  /// a small gray title over a group of items
  private func header(_ title: String) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    i.isEnabled = false
    i.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
    return i
  }

  private func item(_ title: String, _ action: Selector, _ key: String = "", enabled: Bool = true) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.target = self
    i.isEnabled = enabled
    return i
  }

  private func buildMenu() {
    let bar = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "关于 tmux-web", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(withTitle: "检查更新…", action: #selector(checkUpdates), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "全部服务器", action: #selector(homeAction), keyEquivalent: ",")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "隐藏 tmux-web", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "退出 tmux-web", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    bar.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "编辑")
    edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    bar.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "显示")
    view.addItem(withTitle: "重新载入网页", action: #selector(reloadPage), keyEquivalent: "r")
    view.addItem(withTitle: "显示主窗口", action: #selector(showMain), keyEquivalent: "0")
    viewItem.submenu = view
    bar.addItem(viewItem)

    let serverItem = NSMenuItem()
    serverMenu.delegate = self
    serverItem.submenu = serverMenu
    bar.addItem(serverItem)

    let winItem = NSMenuItem()
    let win = NSMenu(title: "窗口")
    win.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = win
    bar.addItem(winItem)
    NSApp.windowsMenu = win
    NSApp.mainMenu = bar
  }

  /// 服务器: home, new, every server (the ones in use with their state), and the one in front.
  func menuNeedsUpdate(_ menu: NSMenu) {
    guard menu === serverMenu else { return }
    menu.removeAllItems()
    menu.autoenablesItems = false
    menu.addItem(item("全部服务器", #selector(homeAction), "l"))
    menu.addItem(item("新建服务器…", #selector(newServer), "n"))
    menu.addItem(item("私钥…", #selector(openKeys)))
    menu.addItem(item("共享配置…", #selector(openShare)))
    if !store.profiles.isEmpty { menu.addItem(.separator()) }
    store.sorted.forEach { menu.addItem(serverItem($0)) }
    let onServer = !model.showHome && active != nil
    menu.addItem(.separator())
    let again = item("重新连接", #selector(reconnect), "R", enabled: onServer)
    menu.addItem(again)
    menu.addItem(item("编辑当前服务器…", #selector(editCurrent), enabled: onServer))
    menu.addItem(item("断开当前服务器", #selector(disconnectCurrent), enabled: onServer))
    if conns.count > 1 { menu.addItem(item("断开全部", #selector(disconnectAll))) }
  }
}
