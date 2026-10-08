import CryptoKit
import Foundation
import Security

// Secrets live in a file only this user can read, not in the keychain: an app without a developer
// signature counts as a different app after every update, and the keychain then asks for the
// login password again and again.

/// The key the settings and passwords are encrypted with: random, made once, in a 0600 file.
enum LocalKey {
  private static let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("TmuxWeb/settings.key")

  static let key: SymmetricKey = {
    let fm = FileManager.default
    if let d = fm.contents(atPath: url.path), d.count == 32 { return SymmetricKey(data: d) }
    let k = SymmetricKey(size: .bits256)
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    fm.createFile(atPath: url.path, contents: k.withUnsafeBytes { Data($0) }, attributes: [.posixPermissions: 0o600])
    return k
  }()
}

/// SSH passwords, one per server, encrypted in the settings (never in plain text).
enum Keychain {
  private static let defaultsKey = "secrets.enc"

  private static func all() -> [String: String] {
    guard let enc = UserDefaults.standard.data(forKey: defaultsKey), let d = Sealed.open(enc), let m = try? JSONDecoder().decode([String: String].self, from: d) else { return [:] }
    return m
  }

  static func password(for id: UUID) -> String? { all()[id.uuidString] }

  /// nil or "" removes it
  static func setPassword(_ pw: String?, for id: UUID) {
    var m = all()
    m[id.uuidString] = (pw?.isEmpty ?? true) ? nil : pw
    if let d = try? JSONEncoder().encode(m), let enc = Sealed.seal(d) { UserDefaults.standard.set(enc, forKey: defaultsKey) }
  }
}

/// What versions up to 1.0.0 kept in the keychain: read once to move it over (this may ask for
/// the login password one last time), never written.
enum LegacyKeychain {
  static func configKey() -> SymmetricKey? {
    guard let d = read(service: "tmux-web config", account: "key"), d.count == 32 else { return nil }
    return SymmetricKey(data: d)
  }

  static func password(for id: UUID) -> String? {
    read(service: "tmux-web ssh", account: id.uuidString).flatMap { String(data: $0, encoding: .utf8) }
  }

  private static func read(service: String, account: String) -> Data? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
    return out as? Data
  }
}
