import Foundation

/// One server: where to SSH to, and which port of it serves tmux-web.
struct Profile: Codable, Identifiable, Equatable, Hashable {
  var id = UUID()
  var name = ""
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

  var title: String { name.trimmingCharacters(in: .whitespaces).isEmpty ? target : name }
  var isComplete: Bool { !target.trimmingCharacters(in: .whitespaces).isEmpty && remotePort > 0 && localPort > 0 }

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
    if let data = defaults.data(forKey: "profiles"), let list = try? JSONDecoder().decode([Profile].self, from: data) {
      profiles = list
    } else {
      profiles = []
    }
    currentID = defaults.string(forKey: "current").flatMap(UUID.init(uuidString:))
  }

  var current: Profile? { profiles.first { $0.id == currentID } ?? profiles.first }

  func upsert(_ p: Profile) {
    if let i = profiles.firstIndex(where: { $0.id == p.id }) { profiles[i] = p } else { profiles.append(p) }
    currentID = p.id
  }

  func remove(_ id: UUID) {
    profiles.removeAll { $0.id == id }
    if currentID == id { currentID = profiles.first?.id }
  }

  private func save() {
    if let data = try? JSONEncoder().encode(profiles) { defaults.set(data, forKey: "profiles") }
    defaults.set(currentID?.uuidString, forKey: "current")
  }
}
