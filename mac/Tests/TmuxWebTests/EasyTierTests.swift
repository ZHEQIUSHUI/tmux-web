import XCTest
@testable import TmuxWeb

final class EasyTierTests: XCTestCase {
  private func profile() -> Profile {
    var p = Profile()
    p.id = UUID(uuidString: "12345678-1234-1234-1234-123456789abc")!
    p.mode = "easytier"
    p.easyTierNetwork = "home"
    p.easyTierSecret = "secret"
    p.easyTierPeers = "tcp://public.example.com:11010"
    p.easyTierServerIP = "10.144.144.30"
    p.remotePort = 18090
    p.localPort = 18080
    return p
  }

  func testConfigIsNoTunAndForwardsToTheVirtualIPv4() throws {
    let text = try EasyTierConfig.make(for: profile())
    XCTAssertTrue(text.contains("no_tun = true"))
    XCTAssertTrue(text.contains("listeners = []"))
    XCTAssertTrue(text.contains("bind_addr = \"127.0.0.1:18080\""))
    XCTAssertTrue(text.contains("dst_addr = \"10.144.144.30:18090\""))
    XCTAssertTrue(text.contains("uri = \"tcp://public.example.com:11010\""))
    XCTAssertTrue(text.contains("network_secret = \"secret\""))
  }

  func testTOMLStringEscapesSecrets() throws {
    var p = profile()
    p.easyTierSecret = "a\"b\\c\n\u{1}"
    let text = try EasyTierConfig.make(for: p)
    XCTAssertTrue(text.contains("network_secret = \"a\\\"b\\\\c\\n\\u0001\""))
    XCTAssertEqual(EasyTierConfig.string("a\t"), "\"a\\t\"")
  }

  func testLogsDoNotShowTheNetworkSecret() {
    let text = "INFO config:\nnetwork_secret = \"super-secret\"\nnetwork_name = \"home\"\nsecret=super-secret"
    let clean = EasyTierLog.redact(text, secret: "super-secret")
    XCTAssertFalse(clean.contains("super-secret"))
    XCTAssertTrue(clean.contains("network_name = \"home\""))
    XCTAssertTrue(clean.contains("network_secret = \"<已隐藏>\""))
  }

  func testPeersCanBeSeparatedByCommasOrNewlines() {
    XCTAssertEqual(
      EasyTierConfig.peers(from: "tcp://one:11010, tcp://two:11010\n tcp://three:11010 "),
      ["tcp://one:11010", "tcp://two:11010", "tcp://three:11010"]
    )
    let text = (try? EasyTierConfig.make(for: {
      var p = profile()
      p.easyTierPeers = "tcp://one:11010,tcp://two:11010"
      return p
    }())) ?? ""
    XCTAssertEqual(text.components(separatedBy: "[[peer]]").count - 1, 2)
    XCTAssertEqual(EasyTierConfig.peers(from: "tcp://one:11010，tcp://two:11010；tcp://three:11010"), ["tcp://one:11010", "tcp://two:11010", "tcp://three:11010"])
  }

  func testEditorRowsSplitAPastedList() {
    XCTAssertEqual(EasyTierConfig.peerRows(""), [""])
    XCTAssertEqual(EasyTierConfig.peerRows("tcp://a:1\n"), ["tcp://a:1", ""])
    // typing in a row
    XCTAssertEqual(EasyTierConfig.peerText("tcp://a:1\n", row: 1, value: "tcp://b"), "tcp://a:1\ntcp://b")
    // a pasted list: a row per node, the rows after it kept
    XCTAssertEqual(EasyTierConfig.peerText("x\ny", row: 0, value: "tcp://a:1, tcp://b:2"), "tcp://a:1\ntcp://b:2\ny")
    // a comma typed at the end: the next row, empty
    XCTAssertEqual(EasyTierConfig.peerText("", row: 0, value: "tcp://a:1，"), "tcp://a:1\n")
  }

  func testValidationWantsALiteralIPv4AndARealPeer() {
    var p = profile()
    p.easyTierServerIP = "server.local"
    XCTAssertNotNil(EasyTierConfig.problem(p))
    p.easyTierServerIP = "10.144.144.30"
    p.easyTierPeers = "public.example.com:11010"
    XCTAssertNotNil(EasyTierConfig.problem(p))
    p.easyTierPeers = "tcp://public.example.com:11010"
    XCTAssertNil(EasyTierConfig.problem(p))
  }

  func testOldProfileJSONStillDecodes() throws {
    let json = #"{"id":"12345678-1234-1234-1234-123456789abc","mode":"direct","directURL":"http://10.0.0.2:8080"}"#
    let p = try JSONDecoder().decode(Profile.self, from: Data(json.utf8))
    XCTAssertEqual(p.mode, "direct")
    XCTAssertEqual(p.directURL, "http://10.0.0.2:8080")
    XCTAssertEqual(p.easyTierNetwork, "")
    XCTAssertEqual(p.easyTierSecret, "")
    XCTAssertEqual(p.easyTierPeers, "")
    XCTAssertEqual(p.easyTierServerIP, "")
  }

  func testIdentityIncludesTheSecretAndIgnoresLocalPortAndPeerOrder() {
    var a = profile()
    var b = a
    b.localPort = 19000
    a.easyTierPeers = "tcp://one:11010,tcp://two:11010"
    b.easyTierPeers = "tcp://two:11010, tcp://one:11010"
    XCTAssertEqual(ShareIdentity.profileIdentity(a, password: "", keyText: nil), ShareIdentity.profileIdentity(b, password: "", keyText: nil))
    b.easyTierSecret = "different"
    XCTAssertNotEqual(ShareIdentity.profileIdentity(a, password: "", keyText: nil), ShareIdentity.profileIdentity(b, password: "", keyText: nil))
  }

  func testConfigPathIsSpecificToTheProfile() {
    let a = EasyTierFiles.path(for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
    let b = EasyTierFiles.path(for: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!)
    XCTAssertTrue(a.hasSuffix("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.toml"))
    XCTAssertNotEqual(a, b)
  }
}
