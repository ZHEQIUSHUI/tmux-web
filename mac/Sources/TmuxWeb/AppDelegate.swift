import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSMenuDelegate {
  private let tunnel = Tunnel()
  private var main: WebWindow!
  private var settings: NSWindow?
  private let serverMenu = NSMenu(title: "服务器")

  func applicationDidFinishLaunching(_ n: Notification) {
    main = WebWindow()
    main.status.retry = { [weak self] in self?.connect() }
    main.status.edit = { [weak self] in self?.openSettings() }
    tunnel.onState = { [weak self] s in
      guard let self else { return }
      Log.write("state \(s)")
      self.main.show(s, title: ProfileStore.shared.current?.title ?? "")
    }
    UNUserNotificationCenter.current().delegate = self
    buildMenu()
    main.window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    if let p = ProfileStore.shared.current, p.isComplete {
      connect()
    } else {
      main.show(.failed("还没有设置服务器。"), title: "")
      openSettings()
    }
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
    m.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "")
    m.addItem(withTitle: "服务器设置…", action: #selector(openSettings), keyEquivalent: "")
    return m
  }

  private func connect() {
    guard let p = ProfileStore.shared.current, p.isComplete else { return openSettings() }
    main.show(.connecting, title: p.title)
    tunnel.start(p)
  }

  @objc private func reconnect() { connect() }
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

  @objc func openSettings() {
    if let s = settings {
      s.makeKeyAndOrderFront(nil)
      return
    }
    let view = SettingsView(
      draft: ProfileStore.shared.current ?? Profile(),
      onConnect: { [weak self] _ in
        self?.settings?.close()
        self?.connect()
      },
      onCancel: { [weak self] in self?.settings?.close() }
    )
    let w = NSWindow(contentViewController: NSHostingController(rootView: view))
    w.title = "服务器设置"
    w.styleMask = [.titled, .closable]
    w.isReleasedWhenClosed = false
    NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in self?.settings = nil }
    settings = w
    w.center()
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func pickServer(_ item: NSMenuItem) {
    guard let id = item.representedObject as? UUID else { return }
    ProfileStore.shared.currentID = id
    connect()
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
    appMenu.addItem(withTitle: "服务器设置…", action: #selector(openSettings), keyEquivalent: ",")
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

  /// 服务器: the list (one for now) with the current one checked, reconnect, edit.
  func menuNeedsUpdate(_ menu: NSMenu) {
    guard menu === serverMenu else { return }
    menu.removeAllItems()
    let store = ProfileStore.shared
    for p in store.profiles {
      let item = NSMenuItem(title: p.title, action: #selector(pickServer(_:)), keyEquivalent: "")
      item.representedObject = p.id
      item.state = p.id == store.current?.id ? .on : .off
      menu.addItem(item)
    }
    if !store.profiles.isEmpty { menu.addItem(.separator()) }
    menu.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "R")
    menu.addItem(withTitle: "编辑服务器…", action: #selector(openSettings), keyEquivalent: "")
  }
}
