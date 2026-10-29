import Darwin
import Foundation
import Network

/// The EasyTier part of a server: a small generated TOML file for the bundled Core. It runs without
/// a TUN device and forwards one local TCP port to tmux-web's address inside the virtual network.
enum EasyTierConfig {
  static func problem(_ p: Profile) -> String? {
    if p.easyTierNetwork.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "填写 EasyTier 网络名称"
    }
    if !validIPv4(p.easyTierServerIP) {
      return "服务器虚拟 IP 要是 IPv4 地址，比如 10.144.144.30"
    }
    if !(1...65535).contains(p.remotePort) { return "tmux-web 端口在 1–65535 之间" }
    if !(1...65535).contains(p.localPort) { return "本地端口在 1–65535 之间" }
    let peers = peers(from: p.easyTierPeers)
    if peers.isEmpty { return "至少填一个 EasyTier 公共节点" }
    if let bad = peers.first(where: { !validPeer($0) }) {
      return "公共节点格式不对：\(bad)。比如 tcp://public.example.com:11010"
    }
    return nil
  }

  /// what may separate nodes: commas and semicolons (also full-width ones), spaces, line breaks
  static let peerSeparators = CharacterSet(charactersIn: ",，;；").union(.whitespacesAndNewlines)

  static func peers(from text: String) -> [String] {
    text.components(separatedBy: peerSeparators).filter { !$0.isEmpty }
  }

  /// The node list as the editor's rows, one node a line (empty lines are rows being typed);
  /// always at least one row.
  static func peerRows(_ text: String) -> [String] {
    let rows = text.components(separatedBy: "\n")
    return rows.isEmpty ? [""] : rows
  }

  /// Row `i` set to `value`. A pasted or typed list ("a, b") becomes a row per node there.
  static func peerText(_ text: String, row i: Int, value: String) -> String {
    var rows = peerRows(text)
    guard rows.indices.contains(i) else { return text }
    let parts = value.components(separatedBy: peerSeparators)
    if parts.count > 1 {
      // the nodes, and an empty row after a trailing separator for the next one
      var nodes = parts.filter { !$0.isEmpty }
      if parts.last == "" || nodes.isEmpty { nodes.append("") }
      rows.replaceSubrange(i...i, with: nodes)
    } else {
      rows[i] = value
    }
    return rows.joined(separator: "\n")
  }

  static func validIPv4(_ text: String) -> Bool {
    IPv4Address(text.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
  }

  static func validPeer(_ text: String) -> Bool {
    guard let u = URLComponents(string: text), let scheme = u.scheme, !scheme.isEmpty else { return false }
    guard u.host?.isEmpty == false, let port = u.port, (1...65535).contains(port) else { return false }
    return true
  }

  /// A complete no-TUN configuration. Secrets are TOML strings here; `EasyTierFiles` is the only
  /// thing that writes it, with 0600 permissions. The node needs a virtual IP (dhcp): without one
  /// EasyTier has no userspace stack for the forward and dials the server IP directly, outside the
  /// network.
  static func make(for p: Profile) throws -> String {
    if let problem = problem(p) { throw EasyTierError(problem) }
    let peers = peers(from: p.easyTierPeers)
    let serverIP = p.easyTierServerIP.trimmingCharacters(in: .whitespacesAndNewlines)
    let instance = "tmux-web-\(p.id.uuidString.prefix(8).lowercased())"
    var text = """
      instance_name = \(string(instance))
      dhcp = true
      listeners = []
      mapped_listeners = []
      exit_nodes = []
      rpc_portal = "127.0.0.1:0"

      [network_identity]
      network_name = \(string(p.easyTierNetwork.trimmingCharacters(in: .whitespacesAndNewlines)))
      network_secret = \(string(p.easyTierSecret))

      """
    for peer in peers {
      text += """
        [[peer]]
        uri = \(string(peer))

        """
    }
    text += """
      [flags]
      default_protocol = "tcp"
      enable_encryption = true
      enable_ipv6 = true
      mtu = 1380
      latency_first = false
      enable_exit_node = false
      no_tun = true
      use_smoltcp = false
      relay_network_whitelist = "*"
      disable_p2p = false
      relay_all_peer_rpc = false
      disable_udp_hole_punching = false
      disable_tcp_hole_punching = false

      [[port_forward]]
      proto = "tcp"
      bind_addr = "127.0.0.1:\(p.localPort)"
      dst_addr = "\(serverIP):\(p.remotePort)"
      """
    return text + "\n"
  }

  /// A TOML basic string. Network secrets can contain quotes, backslashes and control characters.
  static func string(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x08: out += "\\b"
      case 0x09: out += "\\t"
      case 0x0A: out += "\\n"
      case 0x0C: out += "\\f"
      case 0x0D: out += "\\r"
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x00...0x1F, 0x7F:
        out += String(format: "\\u%04X", scalar.value)
      default:
        out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }
}

struct EasyTierError: LocalizedError, Equatable {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// EasyTier echoes its whole config at info level, including `network_secret`. We quiet its console
/// and still scrub anything that reaches the failure details.
enum EasyTierLog {
  static func redact(_ text: String, secret: String) -> String {
    var out = text.components(separatedBy: "\n").map { line -> String in
      line.range(of: "network_secret", options: .caseInsensitive) == nil ? line : "network_secret = \"<已隐藏>\""
    }.joined(separator: "\n")
    guard !secret.isEmpty else { return out }
    out = out.replacingOccurrences(of: EasyTierConfig.string(secret), with: "\"<已隐藏>\"")
    if secret.count >= 3 { out = out.replacingOccurrences(of: secret, with: "<已隐藏>") }
    return out
  }
}

/// The Core executable packaged next to the app, selected for the architecture this slice runs as.
enum EasyTierCore {
  static var executable: String? {
    #if arch(arm64)
    let arch = "arm64"
    #else
    let arch = "x86_64"
    #endif
    var candidates: [String] = []
    if let override = ProcessInfo.processInfo.environment["TMUX_WEB_EASYTIER_CORE"], !override.isEmpty {
      candidates.append(override)
    }
    if let resources = Bundle.main.resourceURL {
      candidates.append(resources.appendingPathComponent("EasyTier/\(arch)/easytier-core").path)
    }
    candidates += ["/opt/homebrew/bin/easytier-core", "/usr/local/bin/easytier-core", "/usr/bin/easytier-core"]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
  }
}

/// The generated config lives in Application Support, is readable only by this user, and is removed
/// when its connection stops.
enum EasyTierFiles {
  static let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("TmuxWeb/easytier")

  static func path(for id: UUID) -> String {
    directory.appendingPathComponent("\(id.uuidString.lowercased()).toml").path
  }

  static func write(_ text: String, for id: UUID) throws -> String {
    let fm = FileManager.default
    try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let path = path(for: id)
    let file = URL(fileURLWithPath: path)
    try? fm.removeItem(at: file)
    guard fm.createFile(atPath: file.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
      throw EasyTierError("无法保存 EasyTier 临时配置")
    }
    chmod(file.path, 0o600)
    return file.path
  }

  static func remove(_ path: String?) {
    guard let path else { return }
    try? FileManager.default.removeItem(atPath: path)
  }

  /// A crash can leave a config behind even though its process is gone by now. Remove those at
  /// launch; the secret shouldn't outlive the connection that needed it.
  static func removeStale() {
    let fm = FileManager.default
    let files = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
    for name in files where name.hasSuffix(".toml") {
      try? fm.removeItem(at: directory.appendingPathComponent(name))
    }
  }
}
