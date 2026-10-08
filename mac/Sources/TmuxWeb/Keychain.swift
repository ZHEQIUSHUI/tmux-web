import Foundation
import Security

/// SSH passwords, one per server, in the login keychain (never in the settings file).
enum Keychain {
  private static let service = "tmux-web ssh"

  static func password(for id: UUID) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString, kSecReturnData as String: true]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  /// nil or "" removes it
  static func setPassword(_ pw: String?, for id: UUID) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString]
    SecItemDelete(q as CFDictionary)
    guard let pw, !pw.isEmpty else { return }
    var add = q
    add[kSecValueData as String] = Data(pw.utf8)
    add[kSecAttrLabel as String] = "tmux-web SSH 密码"
    SecItemAdd(add as CFDictionary, nil)
  }
}
