import Foundation
import Network

/// Whether a server answers, as the home screen and 测试连接 show it.
enum Probe: Equatable {
  case checking
  /// round trip in milliseconds
  case online(Int)
  case offline(String)
  /// can't tell from here (e.g. reached through a jump host)
  case unknown(String)
}

enum Prober {
  /// direct: tmux-web itself answers (any HTTP status: 401 means it's there); SSH: the SSH port
  /// takes a connection (logging in is left to connecting).
  static func check(_ p: Profile) async -> Probe {
    if p.isDirect {
      guard let base = p.directBase, let url = URL(string: base + "/_tw/api/me") else { return .offline("网址不对") }
      return await http(url)
    }
    let target = p.target.trimmingCharacters(in: .whitespaces)
    if target.isEmpty { return .offline("没填 SSH 目标") }
    let (host, port, jump) = await sshDestination(target, port: p.sshPort)
    if jump || p.extraArgs.contains("-J") || p.extraArgs.contains("ProxyJump") || p.extraArgs.contains("ProxyCommand") { return .unknown("经跳板机连接") }
    return await tcp(host, port)
  }

  static func http(_ url: URL) async -> Probe {
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
    req.httpMethod = "GET"
    let start = Date()
    do {
      let (_, r) = try await session.data(for: req)
      guard r is HTTPURLResponse else { return .offline("没有响应") }
      return .online(ms(since: start))
    } catch {
      return .offline(reason(error))
    }
  }

  private static let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 5
    c.timeoutIntervalForResource = 6
    return URLSession(configuration: c)
  }()

  /// where ssh would really go: ~/.ssh/config may rename the host, change the port or jump
  static func sshDestination(_ target: String, port: Int) async -> (host: String, port: Int, jump: Bool) {
    let fallbackHost = String(target.split(separator: "@").last ?? Substring(target))
    return await withCheckedContinuation { done in
      DispatchQueue.global().async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        p.arguments = ["-G", "-p", String(port), target]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        var host = fallbackHost, prt = port, jump = false
        if (try? p.run()) != nil {
          let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
          p.waitUntilExit()
          for line in text.split(separator: "\n") {
            let kv = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard kv.count == 2 else { continue }
            switch kv[0] {
            case "hostname": host = kv[1]
            case "port": prt = Int(kv[1]) ?? port
            case "proxyjump", "proxycommand": if kv[1] != "none" { jump = true }
            default: break
            }
          }
        }
        done.resume(returning: (host, prt, jump))
      }
    }
  }

  static func tcp(_ host: String, _ port: Int) async -> Probe {
    guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return .offline("端口不对") }
    let conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
    let start = Date()
    return await withCheckedContinuation { done in
      let once = Once()
      let finish = { (r: Probe) in
        if once.take() {
          conn.cancel()
          done.resume(returning: r)
        }
      }
      conn.stateUpdateHandler = { s in
        switch s {
        case .ready: finish(.online(ms(since: start)))
        case .failed(let e): finish(.offline(reason(e)))
        case .waiting(let e): finish(.offline(reason(e)))
        default: break
        }
      }
      conn.start(queue: .global())
      DispatchQueue.global().asyncAfter(deadline: .now() + 4) { finish(.offline("连接超时")) }
    }
  }

  private static func ms(since d: Date) -> Int { max(1, Int(Date().timeIntervalSince(d) * 1000)) }

  private static func reason(_ e: Error) -> String {
    let ns = e as NSError
    switch ns.code {
    case NSURLErrorTimedOut, Int(ETIMEDOUT): return "连接超时"
    case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "找不到主机"
    case NSURLErrorCannotConnectToHost, Int(ECONNREFUSED): return "拒绝连接"
    case NSURLErrorNotConnectedToInternet: return "没有网络"
    default: break
    }
    switch e as? NWError {
    case .dns: return "找不到主机"
    case .posix(.ECONNREFUSED): return "拒绝连接"
    case .posix(.ETIMEDOUT): return "连接超时"
    case .posix(.EHOSTUNREACH), .posix(.ENETUNREACH): return "网络不可达"
    default: return "连不上"
    }
  }
}

/// true the first time only (a continuation may be resumed once)
private final class Once: @unchecked Sendable {
  private var done = false
  private let lock = NSLock()
  func take() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}

/// "刚刚", "5 分钟前", "3 小时前", "2 天前", then the date
func relativeTime(_ d: Date) -> String {
  let s = Date().timeIntervalSince(d)
  if s < 60 { return "刚刚" }
  if s < 3600 { return "\(Int(s / 60)) 分钟前" }
  if s < 86400 { return "\(Int(s / 3600)) 小时前" }
  if s < 86400 * 7 { return "\(Int(s / 86400)) 天前" }
  let f = DateFormatter()
  f.dateFormat = "M 月 d 日"
  return f.string(from: d)
}
