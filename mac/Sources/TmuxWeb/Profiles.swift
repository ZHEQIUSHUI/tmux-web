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
  /// the private key it logs in with, one of the key list's (`SSHKey`); nil: ~/.ssh/config decides
  var keyID: UUID?
  /// older versions kept the key file here: moved to the key list when read
  var keyPath = ""
  /// more ssh options, e.g. "-J jump-host"
  var extraArgs = ""
  /// when it was last connected (the home screen puts the recent ones first)
  var lastUsed: Date?

  var isDirect: Bool { mode == "direct" }
  var title: String {
    let n = name.trimmingCharacters(in: .whitespaces)
    return !n.isEmpty ? n : isDirect ? (URL(string: directBase ?? "")?.host ?? directURL) : target
  }
  /// what the card shows under the name
  var address: String {
    if isDirect { return directBase ?? directURL }
    let t = target.trimmingCharacters(in: .whitespaces)
    return "\(t)\(sshPort == 22 ? "" : ":\(sshPort)") → \(remotePort)"
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
    keyID = try c.decodeIfPresent(UUID.self, forKey: .keyID)
    keyPath = try c.decodeIfPresent(String.self, forKey: .keyPath) ?? ""
    extraArgs = try c.decodeIfPresent(String.self, forKey: .extraArgs) ?? ""
    lastUsed = try c.decodeIfPresent(Date.self, forKey: .lastUsed)
  }

  /// The private key file to use, if any.
  var privateKey: String? { ProfileStore.shared.key(keyID)?.file }
}

/// A private key file, kept once in a list of its own: any number of servers log in with it.
struct SSHKey: Codable, Identifiable, Equatable, Hashable {
  var id = UUID()
  var name = ""
  /// as picked (~ for the home folder); a .pub picked by mistake means the key next to it
  var path = ""

  /// the file to hand ssh
  var file: String {
    let p = (path.trimmingCharacters(in: .whitespaces) as NSString).expandingTildeInPath
    if p.hasSuffix(".pub") {
      let priv = String(p.dropLast(4))
      if FileManager.default.fileExists(atPath: priv) { return priv }
    }
    return p
  }

  var exists: Bool { FileManager.default.fileExists(atPath: file) }

  /// a new entry for a picked file, named after it
  static func of(_ path: String) -> SSHKey {
    var name = (path as NSString).lastPathComponent
    if name.hasSuffix(".pub") { name.removeLast(4) }
    return SSHKey(name: name, path: (path as NSString).abbreviatingWithTildeInPath)
  }
}

/// The servers, and the one used last.
final class ProfileStore: ObservableObject {
  static let shared = ProfileStore()
  private let defaults = UserDefaults.standard
  /// an import changes keys and servers together; only one write when it is done
  private var importing = false

  @Published var profiles: [Profile] { didSet { save() } }
  @Published var currentID: UUID? { didSet { save() } }
  @Published var keys: [SSHKey] { didSet { save() } }

  private init() {
    // the settings file holds them encrypted (the key is in a file of our own, see LocalKey); an older version's
    // plain list is read once and saved encrypted
    var migrate = false
    if let enc = defaults.data(forKey: "profiles.v2"), let data = Sealed.open(enc), let list = try? JSONDecoder().decode([Profile].self, from: data) {
      profiles = list
    } else if defaults.data(forKey: "profiles.enc") != nil {
      // 1.0.0 kept its key in the keychain: reading it would ask for the login password, so the
      // settings are simply filled in again
      profiles = []
      migrate = true
    } else if let data = defaults.data(forKey: "profiles"), let list = try? JSONDecoder().decode([Profile].self, from: data) {
      profiles = list
      migrate = true
    } else {
      profiles = []
    }
    currentID = defaults.string(forKey: "current").flatMap(UUID.init(uuidString:))
    if let enc = defaults.data(forKey: "keys.v1"), let data = Sealed.open(enc), let list = try? JSONDecoder().decode([SSHKey].self, from: data) {
      keys = list
    } else {
      keys = []
    }
    // older versions kept each server's key file with it: into the key list, the same file only once
    if profiles.contains(where: { !$0.keyPath.trimmingCharacters(in: .whitespaces).isEmpty }) {
      var list = keys
      profiles = profiles.map { p in
        var p = p
        let path = p.keyPath.trimmingCharacters(in: .whitespaces)
        p.keyPath = ""
        if path.isEmpty || (p.keyID != nil && list.contains { $0.id == p.keyID }) { return p }
        let k = SSHKey.of((path as NSString).expandingTildeInPath)
        if let same = list.first(where: { $0.file == k.file }) {
          p.keyID = same.id
        } else {
          list.append(k)
          p.keyID = k.id
        }
        return p
      }
      keys = list
      migrate = true
    }
    if migrate {
      save()
      defaults.removeObject(forKey: "profiles.enc")
    }
  }

  var current: Profile? { profiles.first { $0.id == currentID } ?? profiles.first }

  /// the most recently used first, then by name
  var sorted: [Profile] {
    profiles.sorted { a, b in
      switch (a.lastUsed, b.lastUsed) {
      case let (x?, y?): return x > y
      case (.some, nil): return true
      case (nil, .some): return false
      default: return a.title.localizedStandardCompare(b.title) == .orderedAscending
      }
    }
  }

  func touch(_ id: UUID) {
    guard let i = profiles.firstIndex(where: { $0.id == id }) else { return }
    profiles[i].lastUsed = Date()
    currentID = id
  }

  func upsert(_ p: Profile) {
    if let i = profiles.firstIndex(where: { $0.id == p.id }) { profiles[i] = p } else { profiles.append(p) }
    if currentID == nil { currentID = p.id }
  }

  /// A local port no other SSH server here uses: each keeps its own page login (they belong to the port).
  func freeLocalPort(except id: UUID? = nil) -> Int {
    let used = Set(profiles.filter { !$0.isDirect && $0.id != id }.map(\.localPort))
    var port = 18080
    while used.contains(port) { port += 1 }
    return port
  }

  func key(_ id: UUID?) -> SSHKey? { id.flatMap { id in keys.first { $0.id == id } } }

  /// the servers that log in with it
  func users(of keyID: UUID) -> [Profile] { sorted.filter { !$0.isDirect && $0.keyID == keyID } }

  /// The entry for a picked file: the one there is for it, or a new one.
  func addKey(_ path: String) -> SSHKey {
    let k = SSHKey.of(path)
    if let same = keys.first(where: { $0.file == k.file }) { return same }
    keys.append(k)
    return k
  }

  func upsertKey(_ k: SSHKey) {
    if let i = keys.firstIndex(where: { $0.id == k.id }) { keys[i] = k } else { keys.append(k) }
  }

  /// gone from the list; the servers that used it go back to ~/.ssh/config
  func removeKey(_ id: UUID) {
    for i in profiles.indices where profiles[i].keyID == id { profiles[i].keyID = nil }
    keys.removeAll { $0.id == id }
  }

  func remove(_ id: UUID) {
    Keychain.setPassword(nil, for: id)
    profiles.removeAll { $0.id == id }
    if currentID == id { currentID = profiles.first?.id }
  }

  /// replace both lists as one unit after merging a shared bundle
  func applyImport(keys newKeys: [SSHKey], profiles newProfiles: [Profile]) {
    importing = true
    keys = newKeys
    profiles = newProfiles
    importing = false
    if currentID == nil { currentID = profiles.first?.id }
    save()
  }

  private func save() {
    guard !importing else { return }
    guard let data = try? JSONEncoder().encode(profiles) else { return }
    if let enc = Sealed.seal(data) {
      defaults.set(enc, forKey: "profiles.v2")
      defaults.removeObject(forKey: "profiles")
    }
    if let kd = try? JSONEncoder().encode(keys), let enc = Sealed.seal(kd) { defaults.set(enc, forKey: "keys.v1") }
    defaults.set(currentID?.uuidString, forKey: "current")
  }
}

/// AES-GCM with the key from LocalKey: what the settings file stores.
enum Sealed {
  static func seal(_ data: Data) -> Data? {
    try? AES.GCM.seal(data, using: LocalKey.key).combined
  }

  static func open(_ data: Data) -> Data? {
    guard let box = try? AES.GCM.SealedBox(combined: data) else { return nil }
    return try? AES.GCM.open(box, using: LocalKey.key)
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
