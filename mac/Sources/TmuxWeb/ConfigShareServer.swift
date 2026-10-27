import Darwin
import Foundation
import Network

struct ShareRunningInfo {
  let port: Int
  let addresses: [String]
  let profileCount: Int
  let keyCount: Int
}

/// A tiny HTTP server for one encrypted bundle. It binds every interface, but only answers with
/// the bundle after the password is checked; repeated guesses from one address are paused.
final class ConfigShareServer {
  private let sealed: ShareProtocol.Sealed
  private let profileCount: Int
  private let keyCount: Int
  private let port: UInt16
  private let queue = DispatchQueue(label: "tmux-web.config-share")
  private let attemptsLock = NSLock()
  private var attempts: [String: Attempt] = [:]
  private var listener: NWListener?
  private var reported = false

  var onReady: ((ShareRunningInfo) -> Void)?
  var onFailure: ((String) -> Void)?

  private struct Attempt { var count = 0; var until: TimeInterval = 0 }

  init(sealed: ShareProtocol.Sealed, profileCount: Int, keyCount: Int, port: Int) {
    self.sealed = sealed
    self.profileCount = profileCount
    self.keyCount = keyCount
    self.port = UInt16(port)
  }

  func start() throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw ShareError("端口不对") }
    let listener = try NWListener(using: params, on: nwPort)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.stateUpdateHandler = { [weak self] state in
      guard let self, !self.reported else { return }
      switch state {
      case .ready:
        self.reported = true
        let info = ShareRunningInfo(port: Int(self.port), addresses: localIPv4Addresses(), profileCount: self.profileCount, keyCount: self.keyCount)
        DispatchQueue.main.async { self.onReady?(info) }
      case .failed(let error):
        self.reported = true
        DispatchQueue.main.async { self.onFailure?(error.localizedDescription) }
      default:
        break
      }
    }
    listener.start(queue: queue)
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private struct Request {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
  }

  private enum Parsed {
    case more
    case bad
    case request(Request)
  }

  private struct Response {
    let status: Int
    let type: String
    let body: String
    var extra: [String: String] = [:]
  }

  private func accept(_ connection: NWConnection) {
    var buffer = Data()
    var finished = false
    let timeout = DispatchWorkItem {
      if !finished { connection.cancel() }
    }
    queue.asyncAfter(deadline: .now() + 10, execute: timeout)
    connection.stateUpdateHandler = { state in
      if case .failed = state { connection.cancel() }
    }
    connection.start(queue: queue)

    func receive() {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
        guard let self, !finished else { return }
        if let data { buffer.append(data) }
        if buffer.count > 128 * 1024 {
          finished = true
          timeout.cancel()
          self.send(Response(status: 400, type: "text/plain; charset=utf-8", body: "请求太大"), on: connection)
          return
        }
        if let response = self.route(buffer, ip: connection.endpoint.debugDescription) {
          finished = true
          timeout.cancel()
          self.send(response, on: connection)
          return
        }
        if error != nil || complete {
          finished = true
          timeout.cancel()
          connection.cancel()
          return
        }
        receive()
      }
    }
    receive()
  }

  private func parse(_ data: Data) -> Parsed {
    let separator = Data("\r\n\r\n".utf8)
    guard let headerEnd = data.range(of: separator) else {
      return data.count > 32 * 1024 ? .bad : .more
    }
    guard let text = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return .bad }
    let lines = text.components(separatedBy: "\r\n")
    let first = lines.first?.split(separator: " ") ?? []
    guard first.count >= 2 else { return .bad }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let i = line.firstIndex(of: ":") else { continue }
      headers[line[..<i].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
    }
    let length = Int(headers["content-length"] ?? "0") ?? 0
    guard (0...16 * 1024).contains(length) else { return .bad }
    let bodyStart = headerEnd.upperBound
    guard data.count >= bodyStart + length else { return .more }
    let body = data.subdata(in: bodyStart..<(bodyStart + length))
    return .request(Request(method: String(first[0]).uppercased(), path: String(first[1]).split(separator: "?").first.map(String.init) ?? "/", headers: headers, body: body))
  }

  private func route(_ data: Data, ip: String) -> Response? {
    let request: Request
    switch parse(data) {
    case .more: return nil
    case .bad: return Response(status: 400, type: "text/plain; charset=utf-8", body: "请求不完整")
    case .request(let r): request = r
    }
    if request.method == "GET", request.path == "/" || request.path == "/index.html" {
      return Response(status: 200, type: "text/html; charset=utf-8", body: page())
    }
    if request.method == "GET", request.path == "/api/info" {
      let info = ["format": ShareProtocol.format, "version": String(ShareProtocol.version), "service": "tmux-web"]
      let body = String(decoding: try! JSONSerialization.data(withJSONObject: info), as: UTF8.self)
      return Response(status: 200, type: "application/json; charset=utf-8", body: body)
    }
    if request.method == "GET", request.path == "/api/bundle" {
      guard let header = request.headers["x-share-password-b64"], let raw = Data(base64Encoded: header), let password = String(data: raw, encoding: .utf8) else {
        return Response(status: 401, type: "application/json; charset=utf-8", body: errorJSON("需要密码"))
      }
      return authorized(password, ip: ip, download: false)
    }
    if request.method == "POST", request.path == "/download" {
      guard let password = formValue(request.body, "password") else {
        return Response(status: 400, type: "application/json; charset=utf-8", body: errorJSON("需要密码"))
      }
      return authorized(password, ip: ip, download: true)
    }
    return Response(status: 404, type: "text/plain; charset=utf-8", body: "没有这个页面")
  }

  private func authorized(_ password: String, ip: String, download: Bool) -> Response {
    if blocked(ip) { return Response(status: 429, type: "application/json; charset=utf-8", body: errorJSON("尝试次数太多，请稍后再试")) }
    if !ShareProtocol.verify(password: password, salt: sealed.salt, iterations: sealed.iterations, expected: sealed.authCode) {
      recordFailure(ip)
      if blocked(ip) { return Response(status: 429, type: "application/json; charset=utf-8", body: errorJSON("尝试次数太多，请稍后再试")) }
      return Response(status: 401, type: "application/json; charset=utf-8", body: errorJSON("密码不对"))
    }
    attemptsLock.lock()
    attempts.removeValue(forKey: ip)
    attemptsLock.unlock()
    return Response(
      status: 200, type: "application/json; charset=utf-8", body: sealed.envelopeJson,
      extra: download ? ["Content-Disposition": "attachment; filename=\"tmux-web-config-share.json\""] : [:]
    )
  }

  private func blocked(_ ip: String) -> Bool {
    attemptsLock.lock()
    defer { attemptsLock.unlock() }
    return (attempts[ip]?.until ?? 0) > Date().timeIntervalSince1970
  }

  private func recordFailure(_ ip: String) {
    attemptsLock.lock()
    defer { attemptsLock.unlock() }
    var a = attempts[ip] ?? Attempt()
    a.count += 1
    if a.count >= 5 {
      a.count = 0
      a.until = Date().timeIntervalSince1970 + 60
    }
    attempts[ip] = a
  }

  private func formValue(_ body: Data, _ name: String) -> String? {
    guard let text = String(data: body, encoding: .utf8) else { return nil }
    for part in text.split(separator: "&") {
      let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard pair.count == 2, pair[0] == Substring(name) else { continue }
      let value = String(pair[1]).replacingOccurrences(of: "+", with: " ")
      return value.removingPercentEncoding ?? value
    }
    return nil
  }

  private func send(_ response: Response, on connection: NWConnection) {
    let body = Data(response.body.utf8)
    let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests"][response.status] ?? "Error"
    var head = "HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: \(response.type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n"
    for (k, v) in response.extra { head += "\(k): \(v)\r\n" }
    head += "\r\n"
    var data = Data(head.utf8)
    data.append(body)
    connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
  }

  private func errorJSON(_ message: String) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: ["error": message]), as: UTF8.self)
  }

  private func page() -> String {
    """
    <!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>tmux-web 共享配置</title>
    <style>body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#202124}code{background:#f1f3f4;padding:2px 5px;border-radius:4px}input,button{font:inherit;padding:10px}input{width:100%;box-sizing:border-box;margin:8px 0 14px;border:1px solid #bbb;border-radius:8px}button{border:0;border-radius:8px;background:#2f6fde;color:#fff;padding:11px 20px}.note{color:#5f6368;font-size:14px}</style></head>
    <body><h2>tmux-web 共享配置</h2>
    <p>这台设备正在共享 <b>\(profileCount)</b> 个服务器配置。请在另一台设备打开 tmux-web App，进入「共享配置 → 接收」，填入本页地址、端口和密码。</p>
    <p class="note">也可以在下面输入密码下载加密的共享文件。文件里的私钥和密码只有密码正确时才能解开。</p>
    <form method="post" action="/download"><label for="password">访问密码</label><input id="password" name="password" type="password" required><button type="submit">下载加密配置</button></form>
    <p class="note">只在你信任的局域网里使用。关闭共享后这个页面就不能访问了。</p></body></html>
    """
  }
}

/// Every non-loopback IPv4 address: Wi-Fi, Ethernet, and VPN interfaces when they are up.
func localIPv4Addresses() -> [String] {
  var list: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&list) == 0, let first = list else { return [] }
  defer { freeifaddrs(list) }
  var result = Set<String>()
  var pointer: UnsafeMutablePointer<ifaddrs>? = first
  while let item = pointer {
    defer { pointer = item.pointee.ifa_next }
    guard let address = item.pointee.ifa_addr else { continue }
    let flags = Int32(item.pointee.ifa_flags)
    guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, address.pointee.sa_family == UInt8(AF_INET) else { continue }
    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    let length = socklen_t(address.pointee.sa_len)
    guard getnameinfo(address, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
    let value = String(cString: host)
    if !value.isEmpty { result.insert(value) }
  }
  return result.sorted()
}
