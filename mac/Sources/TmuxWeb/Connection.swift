import Foundation
import WebKit

/// One server in use: its forward (or direct address) and its own page. Several stay up at once;
/// switching between them only changes which page shows.
final class Connection {
  var profile: Profile
  let tunnel = Tunnel()
  let web: WKWebView
  var state: Tunnel.State = .idle
  /// the address the page was loaded from
  var loadedBase: String?
  /// the page has come up (until then the connecting screen stays)
  var pageLoaded = false
  private(set) var started = Date()
  /// a notification's session, opened once the page is up
  var pendingSession: Int?

  init(profile: Profile, web: WKWebView) {
    self.profile = profile
    self.web = web
  }

  var info: ConnInfo { ConnInfo(state: state, pageLoaded: pageLoaded, started: started) }

  func start(_ p: Profile) {
    profile = p
    started = Date()
    // a fresh start: the old page goes, so it never shows under new settings
    loadedBase = nil
    pageLoaded = false
    web.load(URLRequest(url: URL(string: "about:blank")!))
    tunnel.start(p)
  }

  func stop() {
    tunnel.stop()
    web.stopLoading()
    web.load(URLRequest(url: URL(string: "about:blank")!))
  }
}

/// What the screens need to know about a connection.
struct ConnInfo: Equatable {
  var state: Tunnel.State
  var pageLoaded: Bool
  var started: Date

  /// up and its page showing
  var live: Bool {
    if case .ready = state { return pageLoaded }
    if case .reconnecting = state { return pageLoaded }
    return false
  }
}

/// What the screens ask the app to do.
struct ServerActions {
  var connect: (Profile) -> Void = { _ in }
  /// nil: a new one; the mode preset for a new one
  var edit: (Profile?, String?) -> Void = { _, _ in }
  var duplicate: (Profile) -> Void = { _ in }
  var remove: (Profile) -> Void = { _ in }
  var disconnect: (UUID) -> Void = { _ in }
  var retry: () -> Void = {}
  /// the settings of the server in front
  var editActive: () -> Void = {}
  var home: () -> Void = {}
  var checkUpdates: () -> Void = {}
  /// the key list
  var keys: () -> Void = {}
}

/// Everything the window shows: home or a server, every connection's state, the servers' probes.
final class AppModel: ObservableObject {
  @Published var showHome = true
  /// the server whose page (or connecting screen) is in front
  @Published var activeID: UUID?
  @Published var conns: [UUID: ConnInfo] = [:]
  @Published var probes: [UUID: Probe] = [:]
  var actions = ServerActions()

  var active: ConnInfo? { activeID.flatMap { conns[$0] } }
}

/// What a failure means and what to do about it, from ssh's or the network's words.
func explain(_ raw: String, direct: Bool) -> (title: String, hint: String) {
  let t = raw.lowercased()
  if t.contains("permission denied") || t.contains("authentication") {
    return ("SSH 登录被拒绝", "检查用户名、密码或私钥。用私钥的话，确认服务器的 authorized_keys 里有对应的公钥。")
  }
  if t.contains("could not resolve") || t.contains("找不到主机") || t.contains("nodename nor servname") {
    return ("找不到这台主机", "检查地址有没有拼错；用 EasyTier 等组网的话，确认它已经连上。")
  }
  if t.contains("timed out") || t.contains("超时") {
    return ("连接超时", "服务器没有响应：检查网络、地址和端口，或者防火墙是不是挡住了。")
  }
  if t.contains("connection refused") || t.contains("拒绝连接") {
    return (direct ? "服务器拒绝连接" : "SSH 端口拒绝连接", direct ? "确认 tmux-web 正在运行，端口填对了。" : "确认 SSH 端口填对了，sshd 正在运行。")
  }
  if t.contains("host key") || t.contains("identification has changed") {
    return ("服务器的主机密钥变了", "服务器重装过的话，在终端运行 ssh-keygen -R <主机> 删掉旧记录后重试；否则可能有人冒充这台服务器。")
  }
  if t.contains("已被占用") {
    return ("本地端口被占用", "换一个本地端口（编辑服务器 → 高级），或者关掉占用它的程序。")
  }
  if t.contains("forwarding") || t.contains("open failed") || t.contains("administratively prohibited") {
    return ("端口转发失败", "SSH 登录成功了，但转发不到 tmux-web：检查「服务器上 tmux-web 的端口」，以及服务器是否允许端口转发（AllowTcpForwarding）。")
  }
  if t.contains("网页加载失败") {
    return ("网页没有打开", "连接已经建立，但页面加载失败：确认 tmux-web 正在运行，然后重试。")
  }
  if t.contains("私钥") || t.contains("密钥") {
    return ("私钥有问题", "按下面的说明换一个私钥文件。")
  }
  return (direct ? "打不开这个地址" : "连不上服务器", direct ? "检查网址和端口，确认 tmux-web 正在运行。" : "看看下面的详细信息；需要的话编辑服务器设置后重试。")
}
