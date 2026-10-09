import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
  private let tunnel = Tunnel()
  private var main: WebWindow!
  private var editor: NSWindow?
  private let serverMenu = NSMenu(title: "服务器")
  private var store: ProfileStore { .shared }
  /// the server connected (or connecting) now
  private var active: Profile? { main.status.activeID.flatMap { id in store.profiles.first { $0.id == id } } }

  func applicationDidFinishLaunching(_ n: Notification) {
    main = WebWindow()
    main.status.retry = { [weak self] in self?.reconnect() }
    main.status.edit = { [weak self] in self?.editCurrent() }
    main.status.list = { [weak self] in self?.showList() }
    main.status.actions = ServerActions(
      connect: { [weak self] p in self?.connect(p) },
      edit: { [weak self] p in self?.openEditor(p) },
      duplicate: { [weak self] p in self?.duplicate(p) },
      remove: { [weak self] p in self?.remove(p) }
    )
    tunnel.onState = { [weak self] s in
      guard let self else { return }
      Log.write("state \(s)")
      self.main.show(s, title: self.active?.title ?? "")
    }
    UNUserNotificationCenter.current().delegate = self
    buildMenu()
    main.window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // the server list first; nothing there yet: the form for the first one
    if store.profiles.isEmpty { openEditor(nil) }
  }

  func applicationWillTerminate(_ n: Notification) { tunnel.stop() }

  // the Dock icon always brings the window back (closed, minimized, behind others, off screen)
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    Log.write("reopen visible=\(hasVisibleWindows) \(main.describe())")
    main.bringBack()
    return false
  }

  /// right-click on the Dock icon
  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let m = NSMenu()
    m.addItem(withTitle: "显示主窗口", action: #selector(showMain), keyEquivalent: "")
    m.addItem(withTitle: "服务器列表", action: #selector(showListAction), keyEquivalent: "")
    if active != nil { m.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "") }
    return m
  }

  // MARK: servers

  /// Its page: the one already up is just shown again; another one replaces it.
  private func connect(_ p: Profile) {
    guard p.isComplete else { return openEditor(p) }
    store.currentID = p.id
    if main.status.activeID == p.id {
      switch tunnel.state {
      case .ready, .connecting, .reconnecting: return main.showList(false)
      default: break
      }
    } else {
      main.reset()
    }
    main.status.activeID = p.id
    main.showList(false)
    main.show(.connecting, title: p.title)
    tunnel.start(p)
  }

  @objc private func reconnect() {
    guard let p = active else { return showList() }
    main.showList(false)
    main.show(.connecting, title: p.title)
    tunnel.start(p)
  }

  /// the list; the connection stays (its card says so, a click goes back to its page)
  private func showList() {
    // still trying to connect: stop, the list is where you choose again
    switch tunnel.state {
    case .ready, .reconnecting: break
    default: disconnect()
    }
    main.showList(true)
    main.bringBack()
  }

  private func disconnect() {
    tunnel.stop()
    main.status.activeID = nil
    main.reset()
  }

  @objc private func showListAction() { showList() }
  @objc private func newServer() { openEditor(nil) }
  @objc private func editCurrent() { openEditor(active ?? store.current) }

  private func duplicate(_ p: Profile) {
    var c = p
    c.id = UUID()
    c.name = "\(p.title) 副本"
    if !c.isDirect { c.localPort = store.freeLocalPort() }
    openEditor(c, password: Keychain.password(for: p.id))
  }

  private func remove(_ p: Profile) {
    let a = NSAlert()
    a.messageText = "删除「\(p.title)」？"
    a.informativeText = "它的设置和保存的密码都会删掉。"
    a.addButton(withTitle: "删除").hasDestructiveAction = true
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: main.window) { [weak self] r in
      guard let self, r == .alertFirstButtonReturn else { return }
      if self.main.status.activeID == p.id { self.disconnect() }
      self.store.remove(p.id)
    }
  }

  /// The form in a sheet: nil makes a new server.
  private func openEditor(_ p: Profile?, password: String? = nil) {
    main.bringBack()
    if let e = editor { return e.makeKeyAndOrderFront(nil) }
    var draft = p ?? Profile()
    if p == nil { draft.localPort = store.freeLocalPort() }
    let isNew = !store.profiles.contains { $0.id == draft.id }
    let view = SettingsView(
      draft: draft, isNew: isNew, password: password ?? Keychain.password(for: draft.id) ?? "",
      onDone: { [weak self] p, pw, go in self?.saved(p, pw, connect: go) },
      onCancel: { [weak self] in self?.closeEditor() }
    )
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
    let changed = before != p || pwBefore != pw
    if go {
      // the one in use, changed: connect again with the new settings
      if changed && main.status.activeID == p.id { main.status.activeID = nil; main.reset() }
      connect(p)
    } else if changed && main.status.activeID == p.id {
      // the one in use, changed: connect again with the new settings, where you are (list or page)
      main.reset()
      main.show(.connecting, title: p.title)
      tunnel.start(p)
    }
  }

  @objc private func checkUpdates() {
    guard let base = main.base else {
      let a = NSAlert()
      a.messageText = "连上服务器后才能检查更新"
      a.runModal()
      return
    }
    Updater.check(base: base, window: main.window, asked: true)
  }
  @objc private func reloadPage() { main.reload() }
  @objc private func showMain() { main.bringBack() }

  @objc private func pickServer(_ item: NSMenuItem) {
    guard let id = item.representedObject as? UUID, let p = store.profiles.first(where: { $0.id == id }) else { return }
    main.bringBack()
    connect(p)
  }

  // MARK: notifications

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    if let id = r.notification.request.content.userInfo["sessionId"] as? Int { main.open(session: id) }
    done()
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  // MARK: menus (the Edit menu also makes ⌘C / ⌘V work in the page)

  private func buildMenu() {
    let bar = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "关于 tmux-web", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(withTitle: "检查更新…", action: #selector(checkUpdates), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "服务器列表", action: #selector(showListAction), keyEquivalent: ",")
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

  /// 服务器: the list, the servers (the one in use checked), new, reconnect, edit.
  func menuNeedsUpdate(_ menu: NSMenu) {
    guard menu === serverMenu else { return }
    menu.removeAllItems()
    menu.addItem(withTitle: "服务器列表", action: #selector(showListAction), keyEquivalent: "l")
    menu.addItem(withTitle: "新建服务器…", action: #selector(newServer), keyEquivalent: "n")
    if !store.profiles.isEmpty { menu.addItem(.separator()) }
    for p in store.profiles {
      let item = NSMenuItem(title: p.title, action: #selector(pickServer(_:)), keyEquivalent: "")
      item.representedObject = p.id
      item.state = p.id == main.status.activeID ? .on : .off
      menu.addItem(item)
    }
    if active != nil {
      menu.addItem(.separator())
      menu.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "R")
      menu.addItem(withTitle: "编辑当前服务器…", action: #selector(editCurrent), keyEquivalent: "")
    }
  }
}
