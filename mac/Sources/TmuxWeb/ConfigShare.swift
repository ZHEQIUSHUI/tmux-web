import CryptoKit
import Darwin
import Foundation
import Security

struct ShareError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct SharedKey: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var privateKey: String
  var passphrase: String = ""

  init(id: String = UUID().uuidString, name: String, privateKey: String, passphrase: String = "") {
    self.id = id
    self.name = name
    self.privateKey = privateKey
    self.passphrase = passphrase
  }

  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    privateKey = try c.decodeIfPresent(String.self, forKey: .privateKey) ?? ""
    passphrase = try c.decodeIfPresent(String.self, forKey: .passphrase) ?? ""
  }
}

struct SharedProfile: Codable, Equatable {
  var name = ""
  var mode = "ssh"
  var directUrl = ""
  var target = ""
  var sshPort = 22
  var remoteHost = "127.0.0.1"
  var remotePort = 8080
  var keyId = ""
  var password = ""
  var extraArgs = ""

  init() {}

  init(_ p: Profile, password: String, keyId: String) {
    name = p.name
    mode = p.mode
    directUrl = p.directURL
    target = p.target
    sshPort = p.sshPort
    remoteHost = p.remoteHost
    remotePort = p.remotePort
    self.keyId = keyId
    self.password = p.isDirect ? "" : password
    extraArgs = p.isDirect ? "" : p.extraArgs
  }

  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "ssh"
    directUrl = try c.decodeIfPresent(String.self, forKey: .directUrl) ?? ""
    target = try c.decodeIfPresent(String.self, forKey: .target) ?? ""
    sshPort = try c.decodeIfPresent(Int.self, forKey: .sshPort) ?? 22
    remoteHost = try c.decodeIfPresent(String.self, forKey: .remoteHost) ?? "127.0.0.1"
    remotePort = try c.decodeIfPresent(Int.self, forKey: .remotePort) ?? 8080
    keyId = try c.decodeIfPresent(String.self, forKey: .keyId) ?? ""
    password = try c.decodeIfPresent(String.self, forKey: .password) ?? ""
    extraArgs = try c.decodeIfPresent(String.self, forKey: .extraArgs) ?? ""
  }
}

struct SharedPayload: Codable {
  var format = ShareProtocol.format
  var version = ShareProtocol.version
  var exportedAt = Int64(Date().timeIntervalSince1970 * 1000)
  var sender = "tmux-web macOS"
  var keys: [SharedKey]
  var profiles: [SharedProfile]

  init(keys: [SharedKey], profiles: [SharedProfile]) {
    self.keys = keys
    self.profiles = profiles
  }

  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    guard try c.decodeIfPresent(String.self, forKey: .format) == ShareProtocol.format,
          try c.decodeIfPresent(Int.self, forKey: .version) == ShareProtocol.version else {
      throw ShareError("这不是受支持的 tmux-web 共享配置")
    }
    exportedAt = try c.decodeIfPresent(Int64.self, forKey: .exportedAt) ?? 0
    sender = try c.decodeIfPresent(String.self, forKey: .sender) ?? ""
    keys = try c.decodeIfPresent([SharedKey].self, forKey: .keys) ?? []
    profiles = try c.decodeIfPresent([SharedProfile].self, forKey: .profiles) ?? []
  }
}

enum ShareProtocol {
  static let format = "tmux-web-config-share"
  static let version = 1
  static let iterations = 120_000
  static let defaultPort = 48620
  static let minPassword = 6
  static let aad = Data("tmux-web-config-share:v1".utf8)
  private static let authLabel = Data("tmux-web-config-share-auth-v1".utf8)

  struct Sealed {
    let envelopeJson: String
    let salt: Data
    let iterations: Int
    let authCode: Data
  }

  private struct Envelope: Codable {
    struct KDF: Codable { var algorithm = ""; var iterations = 0; var salt = "" }
    struct Cipher: Codable { var algorithm = ""; var nonce = "" }
    var format = ""
    var version = 0
    var kdf = KDF()
    var cipher = Cipher()
    var payload = ""
  }

  static func checkPassword(_ password: String) throws {
    guard password.count >= minPassword else { throw ShareError("密码至少 \(minPassword) 位") }
  }

  static func seal(_ payload: SharedPayload, password: String) throws -> Sealed {
    try checkPassword(password)
    var salt = Data(count: 16)
    var nonce = Data(count: 12)
    salt.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    nonce.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 12, $0.baseAddress!) }
    let keyData = deriveKey(password: password, salt: salt, iterations: iterations)
    let key = SymmetricKey(data: keyData)
    let plain = try JSONEncoder().encode(payload)
    let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
    let encrypted = box.ciphertext + box.tag
    let envelope = Envelope(
      format: format,
      version: version,
      kdf: Envelope.KDF(algorithm: "PBKDF2-HMAC-SHA256", iterations: iterations, salt: salt.base64EncodedString()),
      cipher: Envelope.Cipher(algorithm: "AES-256-GCM", nonce: nonce.base64EncodedString()),
      payload: encrypted.base64EncodedString()
    )
    let json = String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)
    return Sealed(envelopeJson: json, salt: salt, iterations: iterations, authCode: authCode(keyData))
  }

  static func open(_ envelopeJson: String, password: String) throws -> SharedPayload {
    guard envelopeJson.utf8.count <= 8 * 1024 * 1024 else { throw ShareError("共享配置太大") }
    let env: Envelope
    do { env = try JSONDecoder().decode(Envelope.self, from: Data(envelopeJson.utf8)) }
    catch { throw ShareError("共享配置格式不对") }
    guard env.format == format, env.version == version else { throw ShareError("这不是受支持的 tmux-web 共享配置") }
    guard env.kdf.algorithm == "PBKDF2-HMAC-SHA256" else { throw ShareError("不支持的密钥算法") }
    guard (10_000...600_000).contains(env.kdf.iterations) else { throw ShareError("共享配置的密钥参数不对") }
    guard env.cipher.algorithm == "AES-256-GCM" else { throw ShareError("不支持的加密算法") }
    guard let salt = Data(base64Encoded: env.kdf.salt), (16...64).contains(salt.count) else { throw ShareError("共享配置的盐不对") }
    guard let nonceData = Data(base64Encoded: env.cipher.nonce), nonceData.count == 12 else { throw ShareError("共享配置的随机数不对") }
    guard let encrypted = Data(base64Encoded: env.payload), encrypted.count >= 16, encrypted.count <= 8 * 1024 * 1024 else { throw ShareError("共享配置的加密内容不对") }
    let key = SymmetricKey(data: deriveKey(password: password, salt: salt, iterations: env.kdf.iterations))
    do {
      let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonceData), ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
      let plain = try AES.GCM.open(box, using: key, authenticating: aad)
      return try JSONDecoder().decode(SharedPayload.self, from: plain)
    } catch let e as ShareError {
      throw e
    } catch {
      throw ShareError("密码不对，或者共享内容已损坏")
    }
  }

  static func verify(password: String, salt: Data, iterations: Int, expected: Data) -> Bool {
    constantTimeEqual(authCode(deriveKey(password: password, salt: salt, iterations: iterations)), expected)
  }

  static func authCode(_ key: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: authLabel, using: SymmetricKey(data: key)))
  }

  /// PBKDF2-HMAC-SHA256 over the password's UTF-8 bytes, written out so it matches the Android app.
  static func deriveKey(password: String, salt: Data, iterations: Int, length: Int = 32) -> Data {
    let prfKey = SymmetricKey(data: Data(password.utf8))
    func prf(_ data: Data) -> Data { Data(HMAC<SHA256>.authenticationCode(for: data, using: prfKey)) }
    var result = Data()
    var block: UInt32 = 1
    while result.count < length {
      var input = salt
      var be = block.bigEndian
      withUnsafeBytes(of: &be) { input.append(contentsOf: $0) }
      var u = prf(input)
      var acc = [UInt8](u)
      if iterations > 1 {
        for _ in 1..<iterations {
          u = prf(u)
          let next = [UInt8](u)
          for i in acc.indices { acc[i] ^= next[i] }
        }
      }
      result.append(contentsOf: acc)
      block += 1
    }
    return Data(result.prefix(length))
  }

  private static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for i in a.indices { difference |= a[i] ^ b[i] }
    return difference == 0
  }
}

enum ShareIdentity {
  static func canonicalKey(_ text: String) -> String {
    var lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n")
      .map { line in
        var line = line
        while line.last == " " || line.last == "\t" { line.removeLast() }
        return line
      }
    while lines.first?.isEmpty == true { lines.removeFirst() }
    while lines.last?.isEmpty == true { lines.removeLast() }
    return lines.joined(separator: "\n")
  }

  static func keyFingerprint(_ text: String) -> String {
    SHA256.hash(data: Data(canonicalKey(text).utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func directIdentity(_ url: String) -> String {
    var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return "" }
    if !s.contains("://") { s = "http://" + s }
    guard var c = URLComponents(string: s), let host = c.host, let scheme = c.scheme?.lowercased() else { return s.lowercased() }
    c.scheme = scheme
    c.host = host.lowercased()
    if c.port == (scheme == "https" ? 443 : 80) { c.port = nil }
    var path = c.percentEncodedPath
    while path.hasSuffix("/") { path.removeLast() }
    c.percentEncodedPath = path
    c.fragment = nil
    return c.string ?? s.lowercased()
  }

  static func profileIdentity(_ p: Profile, password: String, keyText: String?) -> String {
    if p.isDirect { return "direct|" + directIdentity(p.directURL) }
    return sshIdentity(p.target, sshPort: p.sshPort, remoteHost: p.remoteHost, remotePort: p.remotePort, password: password, keyText: keyText, extraArgs: p.extraArgs)
  }

  static func profileIdentity(_ p: SharedProfile, keyText: String?) -> String {
    if p.mode == "direct" { return "direct|" + directIdentity(p.directUrl) }
    return sshIdentity(p.target, sshPort: p.sshPort, remoteHost: p.remoteHost, remotePort: p.remotePort, password: p.password, keyText: keyText, extraArgs: p.extraArgs)
  }

  private static func sshIdentity(_ target: String, sshPort: Int, remoteHost: String, remotePort: Int, password: String, keyText: String?, extraArgs: String) -> String {
    let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = t.split(separator: "@", omittingEmptySubsequences: false)
    let user = parts.count > 1 ? parts.dropLast().joined(separator: "@") : ""
    let host = (parts.last.map(String.init) ?? t).lowercased()
    let fingerprint = keyText.flatMap { $0.isEmpty ? nil : keyFingerprint($0) } ?? ""
    let args = extraArgs.split(whereSeparator: { $0.isWhitespace }).map(String.init).joined(separator: " ")
    return ["ssh", user, host, String(sshPort), remoteHost.trimmingCharacters(in: .whitespaces).lowercased(), String(remotePort), password, fingerprint, args]
      .joined(separator: "\u{0}")
  }
}

struct ShareImportSummary {
  let profilesAdded: Int
  let profilesSkipped: Int
  let keysAdded: Int
  let keysReused: Int

  var text: String {
    var s = "新增 \(profilesAdded) 个服务器"
    if profilesSkipped > 0 { s += "，跳过 \(profilesSkipped) 个重复配置" }
    if keysAdded > 0 { s += "；新增 \(keysAdded) 把私钥" }
    if keysReused > 0 { s += "；复用 \(keysReused) 把已有私钥" }
    return s
  }
}

enum ImportedKeyFiles {
  static let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("TmuxWeb/shared-keys")

  static func write(_ text: String) throws -> String {
    let fm = FileManager.default
    try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = dir.appendingPathComponent(UUID().uuidString + ".key")
    guard fm.createFile(atPath: file.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
      throw ShareError("无法保存导入的私钥")
    }
    chmod(file.path, 0o600)
    return file.path
  }
}

extension ProfileStore {
  /// Merge a received bundle. Keys are matched by their text, servers by every connection detail.
  func importShared(_ payload: SharedPayload) -> ShareImportSummary {
    var nextKeys = keys
    var nextProfiles = profiles
    var keyByFingerprint: [String: UUID] = [:]
    for k in nextKeys {
      if let text = try? String(contentsOfFile: k.file, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        keyByFingerprint[ShareIdentity.keyFingerprint(text)] = k.id
      }
    }
    var portableKeyIDs: [String: UUID] = [:]
    var keysAdded = 0
    var keysReused = 0
    for shared in payload.keys where !shared.privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let fingerprint = ShareIdentity.keyFingerprint(shared.privateKey)
      if let existing = keyByFingerprint[fingerprint] {
        portableKeyIDs[shared.id] = existing
        keysReused += 1
      } else if let path = try? ImportedKeyFiles.write(shared.privateKey) {
        let key = SSHKey(id: UUID(), name: shared.name.isEmpty ? "共享私钥" : shared.name, path: path)
        nextKeys.append(key)
        keyByFingerprint[fingerprint] = key.id
        portableKeyIDs[shared.id] = key.id
        keysAdded += 1
      }
    }

    func keyText(_ id: UUID?) -> String? {
      guard let id, let key = nextKeys.first(where: { $0.id == id }) else { return nil }
      return try? String(contentsOfFile: key.file, encoding: .utf8)
    }

    var identities = Set<String>()
    for p in nextProfiles {
      identities.insert(ShareIdentity.profileIdentity(p, password: Keychain.password(for: p.id) ?? "", keyText: keyText(p.keyID)))
    }
    var usedPorts = Set(nextProfiles.filter { !$0.isDirect }.map(\.localPort))
    var profilesAdded = 0
    var profilesSkipped = 0
    for shared in payload.profiles {
      let mappedKey = shared.keyId.isEmpty ? nil : portableKeyIDs[shared.keyId]
      let identity = ShareIdentity.profileIdentity(shared, keyText: keyText(mappedKey))
      if identities.contains(identity) {
        profilesSkipped += 1
        continue
      }
      let direct = shared.mode == "direct"
      var localPort = 18080
      if !direct {
        while usedPorts.contains(localPort) { localPort += 1 }
        usedPorts.insert(localPort)
      }
      var p = Profile()
      p.id = UUID()
      p.name = shared.name
      p.mode = direct ? "direct" : "ssh"
      p.directURL = shared.directUrl
      p.target = shared.target
      p.sshPort = shared.sshPort
      p.remoteHost = shared.remoteHost
      p.remotePort = shared.remotePort
      p.localPort = localPort
      p.keyID = mappedKey
      p.extraArgs = direct ? "" : shared.extraArgs
      nextProfiles.append(p)
      identities.insert(identity)
      if !direct { Keychain.setPassword(shared.password, for: p.id) }
      profilesAdded += 1
    }
    if profilesAdded > 0 || keysAdded > 0 { applyImport(keys: nextKeys, profiles: nextProfiles) }
    return ShareImportSummary(profilesAdded: profilesAdded, profilesSkipped: profilesSkipped, keysAdded: keysAdded, keysReused: keysReused)
  }
}
