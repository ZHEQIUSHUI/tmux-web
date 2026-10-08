import CryptoKit
import Foundation

/// One server: where to SSH to, and which port of it serves tmux-web.
struct Profile: Codable, Identifiable, Equatable, Hashable {
  var id = UUID()
  var name = ""
  /// "ssh": through an SSH port forward; "direct": open `directURL` as it is (EasyTier, LAN…)
  var mode = "direct"
  var directURL = ""
  /// user@host, or a Host alias from ~/.ssh/config
  var target = ""
  var sshPort = 22
  /// where tmux-web listens, as seen from the SSH server
  var remoteHost = "127.0.0.1"
  var remotePort = 8080
  /// fixed, so the page keeps its login and settings (they belong to http://127.0.0.1:<port>)
  var localPort = 18080
  /// a private key; a .pub picked by mistake means the key next to it. Empty: ~/.ssh/config decides
  var keyPath = ""
  /// more ssh options, e.g. "-J jump-host"
  var extraArgs = ""

  var isDirect: Bool { mode == "direct" }
  var title: String {
    let n = name.trimmingCharacters(in: .whitespaces)
    return !n.isEmpty ? n : isDirect ? (URL(string: directBase ?? "")?.host ?? directURL) : target
  }
  var isComplete: Bool {
    isDirect ? directBase != nil : !target.trimmingCharacters(in: .whitespaces).isEmpty && remotePort > 0 && localPort > 0
  }
  /// The direct address as http(s)://host[:port], or nil when it isn't one ("10.0.0.2:8080" gets http://).
  var directBase: String? {
    var s = directURL.trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return nil }
    if !s.contains("://") { s = "http://" + s }
    while s.hasSuffix("/") { s.removeLast() }
    guard let u = URL(string: s), let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != nil else { return nil }
    return s
  }

  init() {}

  // settings saved by older versions lack the newer fields
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    let fresh = Profile()
    id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? fresh.id
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "ssh"
    directURL = try c.decodeIfPresent(String.self, forKey: .directURL) ?? ""
    target = try c.decodeIfPresent(String.self, forKey: .target) ?? ""
    sshPort = try c.decodeIfPresent(Int.self, forKey: .sshPort) ?? 22
    remoteHost = try c.decodeIfPresent(String.self, forKey: .remoteHost) ?? "127.0.0.1"
    remotePort = try c.decodeIfPresent(Int.self, forKey: .remotePort) ?? 8080
    localPort = try c.decodeIfPresent(Int.self, forKey: .localPort) ?? 18080
    keyPath = try c.decodeIfPresent(String.self, forKey: .keyPath) ?? ""
    extraArgs = try c.decodeIfPresent(String.self, forKey: .extraArgs) ?? ""
  }

  /// The private key to use, if any.
  var privateKey: String? {
    var p = (keyPath.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
    if p.isEmpty { return nil }
    if p.hasSuffix(".pub") {
      let priv = String(p.dropLast(4))
      if FileManager.default.fileExists(atPath: priv) { p = priv }
    }
    return p
  }
}

/// The servers (one for now; the list is there for later) and which one is in use.
final class ProfileStore: ObservableObject {
  static let shared = ProfileStore()
  private let defaults = UserDefaults.standard

  @Published var profiles: [Profile] { didSet { save() } }
  @Published var currentID: UUID? { didSet { save() } }

  private init() {
    // the settings file holds them encrypted (the key is in the keychain); an older version's
    // plain list is read once and saved encrypted
    var plain = false
    if let enc = defaults.data(forKey: "profiles.enc"), let data = Sealed.open(enc), let list = try? JSONDecoder().decode([Profile].self, from: data) {
      profiles = list
    } else if let data = defaults.data(forKey: "profiles"), let list = try? JSONDecoder().decode([Profile].self, from: data) {
      profiles = list
      plain = true
    } else {
      profiles = []
    }
    currentID = defaults.string(forKey: "current").flatMap(UUID.init(uuidString:))
    if plain { save() }
  }

  var current: Profile? { profiles.first { $0.id == currentID } ?? profiles.first }

  func upsert(_ p: Profile) {
    if let i = profiles.firstIndex(where: { $0.id == p.id }) { profiles[i] = p } else { profiles.append(p) }
    currentID = p.id
  }

  func remove(_ id: UUID) {
    Keychain.setPassword(nil, for: id)
    profiles.removeAll { $0.id == id }
    if currentID == id { currentID = profiles.first?.id }
  }

  private func save() {
    guard let data = try? JSONEncoder().encode(profiles) else { return }
    if let enc = Sealed.seal(data) {
      defaults.set(enc, forKey: "profiles.enc")
      defaults.removeObject(forKey: "profiles")
    } else {
      // no keychain to hold the key (very unusual): better kept plain than lost
      Log.write("keychain unavailable: settings saved unencrypted")
      defaults.set(data, forKey: "profiles")
    }
    defaults.set(currentID?.uuidString, forKey: "current")
  }
}

/// AES-GCM with a random key kept in the keychain: what the settings file stores.
enum Sealed {
  static func seal(_ data: Data) -> Data? {
    guard let key = Keychain.configKey() else { return nil }
    return try? AES.GCM.seal(data, using: key).combined
  }

  static func open(_ data: Data) -> Data? {
    guard let key = Keychain.configKey(), let box = try? AES.GCM.SealedBox(combined: data) else { return nil }
    return try? AES.GCM.open(box, using: key)
  }
}

/// A small log for looking into problems: ~/Library/Logs/tmux-web.log (kept short).
enum Log {
  private static let url = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/tmux-web.log")
  private static let queue = DispatchQueue(label: "log")

  static func write(_ line: String) {
    let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
    queue.async {
      let fm = FileManager.default
      if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 512 * 1024 { try? fm.removeItem(at: url) }
      if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile()
        h.write(Data(text.utf8))
        try? h.close()
      } else {
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(text.utf8).write(to: url)
      }
    }
  }
}
