package com.zheqiushui.tmuxweb

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EasyTierConfigTest {
  private fun profile() = Profile(
    id = "12345678-1234-1234-1234-123456789abc",
    mode = "easytier",
    easyTierNetwork = "home",
    easyTierSecret = "secret",
    easyTierPeers = "tcp://public.example.com:11010",
    easyTierServerIP = "10.144.144.30",
    remotePort = 18090,
    localPort = 18080,
  )

  @Test
  fun configIsNoTunAndForwardsToTheVirtualIPv4() {
    val text = EasyTierConfig.make(profile())
    assertTrue(text.contains("no_tun = true"))
    assertTrue(text.contains("listeners = []"))
    assertTrue(text.contains("bind_addr = \"127.0.0.1:18080\""))
    assertTrue(text.contains("dst_addr = \"10.144.144.30:18090\""))
    assertTrue(text.contains("uri = \"tcp://public.example.com:11010\""))
    assertTrue(text.contains("network_secret = \"secret\""))
  }

  @Test
  fun tomlStringEscapesSecrets() {
    val p = profile().copy(easyTierSecret = "a\"b\\c\n\u0001")
    val text = EasyTierConfig.make(p)
    assertTrue(text.contains("network_secret = \"a\\\"b\\\\c\\n\\u0001\""))
    assertEquals("\"a\\t\"", EasyTierConfig.string("a\t"))
  }

  @Test
  fun logsDoNotShowTheNetworkSecret() {
    val text = "INFO config:\nnetwork_secret = \"super-secret\"\nnetwork_name = \"home\"\nsecret=super-secret"
    val clean = EasyTierLog.redact(text, "super-secret")
    assertTrue(!clean.contains("super-secret"))
    assertTrue(clean.contains("network_name = \"home\""))
    assertTrue(clean.contains("network_secret = \"<已隐藏>\""))
  }

  @Test
  fun peersCanBeSeparatedByCommasOrNewlines() {
    assertEquals(
      listOf("tcp://one:11010", "tcp://two:11010", "tcp://three:11010"),
      EasyTierConfig.peers("tcp://one:11010, tcp://two:11010\n tcp://three:11010 "),
    )
    val text = EasyTierConfig.make(profile().copy(easyTierPeers = "tcp://one:11010,tcp://two:11010"))
    assertEquals(2, text.split("[[peer]]").size - 1)
    assertEquals(
      listOf("tcp://one:11010", "tcp://two:11010", "tcp://three:11010"),
      EasyTierConfig.peers("tcp://one:11010，tcp://two:11010；tcp://three:11010"),
    )
  }

  @Test
  fun editorRowsSplitAPastedList() {
    assertEquals(listOf(""), EasyTierConfig.peerRows(""))
    assertEquals(listOf("tcp://a:1", ""), EasyTierConfig.peerRows("tcp://a:1\n"))
    // typing in a row
    assertEquals("tcp://a:1\ntcp://b", EasyTierConfig.peerText("tcp://a:1\n", 1, "tcp://b"))
    // a pasted list: a row per node, the rows after it kept
    assertEquals("tcp://a:1\ntcp://b:2\ny", EasyTierConfig.peerText("x\ny", 0, "tcp://a:1, tcp://b:2"))
    // a comma typed at the end: the next row, empty
    assertEquals("tcp://a:1\n", EasyTierConfig.peerText("", 0, "tcp://a:1，"))
  }

  @Test
  fun validationWantsALiteralIPv4AndARealPeer() {
    assertNotEquals(null, EasyTierConfig.problem(profile().copy(easyTierServerIP = "server.local")))
    assertNotEquals(null, EasyTierConfig.problem(profile().copy(easyTierPeers = "public.example.com:11010")))
    assertNull(EasyTierConfig.problem(profile()))
  }

  @Test
  fun oldProfileJsonStillDecodesWithEmptyEasyTierFields() {
    val p = Profile.fromJson(JSONObject("{\"id\":\"1234\",\"mode\":\"direct\",\"directUrl\":\"http://10.0.0.2:8080\"}"))
    assertEquals("direct", p.mode)
    assertEquals("http://10.0.0.2:8080", p.directUrl)
    assertEquals("", p.easyTierNetwork)
    assertEquals("", p.easyTierSecret)
    assertEquals("", p.easyTierPeers)
    assertEquals("", p.easyTierServerIP)
  }

  @Test
  fun identityIncludesTheSecretAndIgnoresLocalPortAndPeerOrder() {
    val a = profile().copy(easyTierPeers = "tcp://one:11010,tcp://two:11010")
    val b = a.copy(localPort = 19000, easyTierPeers = "tcp://two:11010, tcp://one:11010")
    assertEquals(ShareIdentity.profileIdentity(a, null), ShareIdentity.profileIdentity(b, null))
    assertNotEquals(
      ShareIdentity.profileIdentity(a, null),
      ShareIdentity.profileIdentity(a.copy(easyTierSecret = "different"), null),
    )
  }
}
