import XCTest
@testable import TmuxWeb

final class ConfigShareTests: XCTestCase {
  func testPBKDF2MatchesTheStandardVector() {
    let key = ShareProtocol.deriveKey(password: "password", salt: Data("salt".utf8), iterations: 4096)
    XCTAssertEqual(key.map { String(format: "%02x", $0) }.joined(), "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a")
  }

  func testOpensABundleMadeByTheOtherPlatform() throws {
    let payload = try ShareProtocol.open(nodeFixture, password: "test-password")
    XCTAssertEqual(payload.keys.count, 1)
    XCTAssertEqual(payload.keys.first?.id, "k1")
    XCTAssertEqual(payload.keys.first?.passphrase, "key-pass")
    XCTAssertEqual(payload.profiles.first?.target, "noqi@10.0.0.5")
    XCTAssertEqual(payload.profiles.first?.extraArgs, "-J jump")
  }

  func testWrongPasswordDoesNotOpenTheBundle() {
    XCTAssertThrowsError(try ShareProtocol.open(nodeFixture, password: "wrong-password"))
  }

  func testSealAndOpenRoundTrip() throws {
    let payload = SharedPayload(
      keys: [SharedKey(id: "key", name: "测试", privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----", passphrase: "p")],
      profiles: [SharedProfile()]
    )
    let sealed = try ShareProtocol.seal(payload, password: "test-password")
    let opened = try ShareProtocol.open(sealed.envelopeJson, password: "test-password")
    XCTAssertEqual(opened.keys, payload.keys)
    XCTAssertEqual(opened.profiles, payload.profiles)
  }

  func testKeyFingerprintIgnoresLineEndingsAndNames() {
    let a = "-----BEGIN KEY-----\r\nabc  \r\n-----END KEY-----\r\n\r\n"
    let b = "\n-----BEGIN KEY-----\nabc\n-----END KEY-----"
    XCTAssertEqual(ShareIdentity.keyFingerprint(a), ShareIdentity.keyFingerprint(b))
  }

  func testProfileIdentityMatchesEveryCredential() {
    let key = "-----BEGIN KEY-----\nabc\n-----END KEY-----"
    var a = SharedProfile()
    a.name = "name"
    a.target = "noqi@Host"
    a.keyId = "k"
    a.password = "pw"
    var same = a
    same.name = "另一个名字"
    var otherPassword = a
    otherPassword.password = "other"
    XCTAssertEqual(ShareIdentity.profileIdentity(a, keyText: key), ShareIdentity.profileIdentity(same, keyText: key))
    XCTAssertNotEqual(ShareIdentity.profileIdentity(a, keyText: key), ShareIdentity.profileIdentity(otherPassword, keyText: key))
  }

  func testDirectURLIgnoresDefaultPortAndTrailingSlash() {
    XCTAssertEqual(ShareIdentity.directIdentity("HTTP://Example.com:80/tmux/"), ShareIdentity.directIdentity("example.com/tmux"))
  }

  private let nodeFixture = "{\"format\":\"tmux-web-config-share\",\"version\":1,\"kdf\":{\"algorithm\":\"PBKDF2-HMAC-SHA256\",\"iterations\":120000,\"salt\":\"AAECAwQFBgcICQoLDA0ODw==\"},\"cipher\":{\"algorithm\":\"AES-256-GCM\",\"nonce\":\"EBESExQVFhcYGRob\"},\"payload\":\"F+uGjJMAiKhnh9iHLH3vLUnseIFkhaBhJCXEyrNdD/Nifr4jaPT6gOVaK894YxVh6/K3I5RY8mttjGc+GWSENglcVTydx/f/CwOE93Kf0bGlPtezCa398CE9SpQWGPZ9Yb+AQmhzZ9ISFDSx04QHS4pOx2upvjh84+zwRaxu6D/mLQu0EqGI2iJ9HCYRwFJ8fwVgZ+3pVEoNpuZfRNzNefA2CsnYM7lNok/cpWF+9BhpDqdXj5oqxIqBwCXqZAT5QaxTpCGXqPNTxTwO78UsvMRPBfUS4KjJsz57UGrp17Sy5s4dgnJXJaXeEvr8gyLvfo/WSsVDf7v6BWxGbLdHB/VyuIgxYRiL0ENgsKIi1EhfsagoXmLwwyylDi01sP2TQ8u3dzclSHfMcM6tW0bYtYF3MdGcnxar4dKLHjDIwOYizZs5onK1FXjZxunESeaHBc+r+1BZk07FCZ/DaHIKq+wuKhrxj2SemeD1Fgh+ILU9nX1uDWQgwFYuk+BBUePTvQJCnfipyxYTfyxcgylBLA8JHE9XVSR+rc8VMWOzHLUeVcuCLuw8Q8u640UKwzFfBkjv/3rdrgdwYMvmhFcM2RdO79dock/be6Y/wpzQcTFBmYhH0fop2fnXOXWpZMaz\"}"
}
