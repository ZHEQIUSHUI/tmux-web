using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TmuxWeb
{
  public class ShareError : Exception { public ShareError(string m) : base(m) { } }

  /// LAN config sharing, the same protocol as the Mac and Android apps: the sender serves one bundle
  /// encrypted with AES-256-GCM under a key from the password (PBKDF2-HMAC-SHA256, 120 000 rounds);
  /// the receiver asks for it with the password and merges it, skipping what it already has.
  public static class ShareProtocol
  {
    public const string Format = "tmux-web-config-share";
    public const int Version = 1;
    public const int Iterations = 120000;
    public const int DefaultPort = 48620;
    public const int MinPassword = 6;
    static readonly byte[] Aad = Encoding.UTF8.GetBytes("tmux-web-config-share:v1");
    static readonly byte[] AuthLabel = Encoding.UTF8.GetBytes("tmux-web-config-share-auth-v1");

    public class Sealed { public string envelopeJson; public byte[] salt; public int iterations; public byte[] authCode; }

    public static void CheckPassword(string password)
    {
      if ((password ?? "").Length < MinPassword) throw new ShareError("密码至少 " + MinPassword + " 位");
    }

    public static byte[] DeriveKey(string password, byte[] salt, int iterations)
    {
      using (var k = new Rfc2898DeriveBytes(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256))
        return k.GetBytes(32);
    }

    public static byte[] AuthCode(byte[] key)
    {
      using (var h = new HMACSHA256(key)) return h.ComputeHash(AuthLabel);
    }

    public static Sealed Seal(Dictionary<string, object> payload, string password)
    {
      CheckPassword(password);
      var salt = Random(16);
      var nonce = Random(12);
      var key = DeriveKey(password, salt, Iterations);
      var plain = Encoding.UTF8.GetBytes(Store.Json.Serialize(payload));
      var enc = AesGcm.Encrypt(key, nonce, plain, Aad); // ciphertext + tag
      var env = new Dictionary<string, object>
      {
        ["format"] = Format,
        ["version"] = Version,
        ["kdf"] = new Dictionary<string, object> { ["algorithm"] = "PBKDF2-HMAC-SHA256", ["iterations"] = Iterations, ["salt"] = Convert.ToBase64String(salt) },
        ["cipher"] = new Dictionary<string, object> { ["algorithm"] = "AES-256-GCM", ["nonce"] = Convert.ToBase64String(nonce) },
        ["payload"] = Convert.ToBase64String(enc),
      };
      return new Sealed { envelopeJson = Store.Json.Serialize(env), salt = salt, iterations = Iterations, authCode = AuthCode(key) };
    }

    static T Get<T>(Dictionary<string, object> d, string k) where T : class => d != null && d.TryGetValue(k, out var v) ? v as T : null;
    static int GetInt(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out var v) && v is int i ? i : -1;

    public static Dictionary<string, object> Open(string envelopeJson, string password)
    {
      if (envelopeJson.Length > 8 * 1024 * 1024) throw new ShareError("共享配置太大");
      Dictionary<string, object> env;
      try { env = Store.Json.DeserializeObject(envelopeJson) as Dictionary<string, object>; }
      catch { throw new ShareError("共享配置格式不对"); }
      if (env == null) throw new ShareError("共享配置格式不对");
      if (Get<string>(env, "format") != Format || GetInt(env, "version") != Version) throw new ShareError("这不是受支持的 tmux-web 共享配置");
      var kdf = Get<Dictionary<string, object>>(env, "kdf");
      var cipher = Get<Dictionary<string, object>>(env, "cipher");
      if (Get<string>(kdf, "algorithm") != "PBKDF2-HMAC-SHA256") throw new ShareError("不支持的密钥算法");
      var iterations = GetInt(kdf, "iterations");
      if (iterations < 10000 || iterations > 600000) throw new ShareError("共享配置的密钥参数不对");
      if (Get<string>(cipher, "algorithm") != "AES-256-GCM") throw new ShareError("不支持的加密算法");
      byte[] salt, nonce, enc;
      try { salt = Convert.FromBase64String(Get<string>(kdf, "salt") ?? ""); } catch { salt = null; }
      if (salt == null || salt.Length < 16 || salt.Length > 64) throw new ShareError("共享配置的盐不对");
      try { nonce = Convert.FromBase64String(Get<string>(cipher, "nonce") ?? ""); } catch { nonce = null; }
      if (nonce == null || nonce.Length != 12) throw new ShareError("共享配置的随机数不对");
      try { enc = Convert.FromBase64String(Get<string>(env, "payload") ?? ""); } catch { enc = null; }
      if (enc == null || enc.Length < 16) throw new ShareError("共享配置的加密内容不对");
      var key = DeriveKey(password, salt, iterations);
      byte[] plain;
      try { plain = AesGcm.Decrypt(key, nonce, enc, Aad); }
      catch { throw new ShareError("密码不对，或者共享内容已损坏"); }
      var payload = Store.Json.DeserializeObject(Encoding.UTF8.GetString(plain)) as Dictionary<string, object>;
      if (payload == null || Get<string>(payload, "format") != Format || GetInt(payload, "version") != Version) throw new ShareError("这不是受支持的 tmux-web 共享配置");
      return payload;
    }

    public static bool Verify(string password, Sealed s)
    {
      var code = AuthCode(DeriveKey(password, s.salt, s.iterations));
      if (code.Length != s.authCode.Length) return false;
      var diff = 0;
      for (var i = 0; i < code.Length; i++) diff |= code[i] ^ s.authCode[i];
      return diff == 0;
    }

    public static byte[] Random(int n)
    {
      var b = new byte[n];
      using (var r = RandomNumberGenerator.Create()) r.GetBytes(b);
      return b;
    }

    public static string RandomPassword()
    {
      const string alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      var b = Random(12);
      return new string(b.Select(x => alphabet[x % alphabet.Length]).ToArray());
    }
  }

  /// tmuxweb://share?h=192.168.1.23,10.126.126.5&p=48620&k=<password>: everything a receiver needs.
  /// tmuxweb://share?h=…&p=…&k=… : a device sharing, to fetch from.
  /// tmuxweb://receive?h=…&p=…&k=… : a device waiting to be sent to (it has no camera to scan with:
  /// the sender scans its code instead).
  public class ShareLink
  {
    public const string Prefix = "tmuxweb://share";
    public const string ReceivePrefix = "tmuxweb://receive";
    public List<string> hosts;
    public int port;
    public string password;
    public bool receive;

    public static ShareLink Parse(string text)
    {
      var s = (text ?? "").Trim();
      var receive = s.StartsWith(ReceivePrefix + "?");
      if (!receive && !s.StartsWith(Prefix + "?")) return null;
      var q = new Dictionary<string, string>();
      foreach (var pair in s.Substring((receive ? ReceivePrefix : Prefix).Length + 1).Split('&'))
      {
        var i = pair.IndexOf('=');
        if (i < 0) return null;
        try { q[pair.Substring(0, i)] = Uri.UnescapeDataString(pair.Substring(i + 1).Replace("+", " ")); } catch { return null; }
      }
      var hosts = (q.TryGetValue("h", out var h) ? h : "").Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
      if (hosts.Count == 0 || !q.TryGetValue("p", out var ps) || !int.TryParse(ps, out var port) || port < 1024 || port > 65535) return null;
      if (!q.TryGetValue("k", out var k) || k.Length < ShareProtocol.MinPassword) return null;
      return new ShareLink { hosts = hosts, port = port, password = k, receive = receive };
    }

    /// the password: only letters and digits stay as they are (the same as the Mac app writes it)
    public string Text
    {
      get
      {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(password))
        {
          var c = (char)b;
          if (b < 128 && char.IsLetterOrDigit(c)) sb.Append(c); else sb.Append('%').Append(b.ToString("X2"));
        }
        return (receive ? ReceivePrefix : Prefix) + "?h=" + string.Join(",", hosts) + "&p=" + port + "&k=" + sb;
      }
    }
  }

  /// How the receiver tells "already have it" (the same rules as the Mac and Android apps).
  public static class ShareIdentity
  {
    public static string CanonicalKey(string text)
    {
      var lines = text.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n').Select(l => l.TrimEnd(' ', '\t')).ToList();
      while (lines.Count > 0 && lines[0].Length == 0) lines.RemoveAt(0);
      while (lines.Count > 0 && lines[lines.Count - 1].Length == 0) lines.RemoveAt(lines.Count - 1);
      return string.Join("\n", lines);
    }

    public static string KeyFingerprint(string text)
    {
      using (var sha = SHA256.Create())
        return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(CanonicalKey(text))).Select(b => b.ToString("x2")));
    }

    public static string DirectIdentity(string url)
    {
      var s = (url ?? "").Trim();
      if (s.Length == 0) return "";
      if (!s.Contains("://")) s = "http://" + s;
      if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || string.IsNullOrEmpty(u.Host)) return s.ToLowerInvariant();
      var scheme = u.Scheme.ToLowerInvariant();
      var port = u.IsDefaultPort ? "" : ":" + u.Port;
      var path = u.AbsolutePath.TrimEnd('/');
      return scheme + "://" + u.Host.ToLowerInvariant() + port + path + u.Query;
    }

    static string EasyTier(string network, string secret, string peers, string serverIP, int remotePort)
    {
      var names = EasyTierConfig.Peers(peers).Select(x => x.ToLowerInvariant()).OrderBy(x => x, StringComparer.Ordinal);
      return string.Join("\0", new[] { "easytier", (network ?? "").Trim(), secret ?? "", string.Join(",", names), (serverIP ?? "").Trim(), remotePort.ToString() });
    }

    static string SshId(string target, int sshPort, string remoteHost, int remotePort, string password, string keyText, string extraArgs)
    {
      var t = (target ?? "").Trim();
      var parts = t.Split('@');
      var user = parts.Length > 1 ? string.Join("@", parts.Take(parts.Length - 1)) : "";
      var host = parts[parts.Length - 1].ToLowerInvariant();
      var fp = string.IsNullOrEmpty(keyText) ? "" : KeyFingerprint(keyText);
      var args = string.Join(" ", (extraArgs ?? "").Split((char[])null, StringSplitOptions.RemoveEmptyEntries));
      return string.Join("\0", new[] { "ssh", user, host, sshPort.ToString(), (remoteHost ?? "").Trim().ToLowerInvariant(), remotePort.ToString(), password ?? "", fp, args });
    }

    public static string Of(Profile p, string password, string keyText)
    {
      if (p.IsDirect) return "direct|" + DirectIdentity(p.directURL);
      if (p.IsEasyTier) return EasyTier(p.easyTierNetwork, p.easyTierSecret, p.easyTierPeers, p.easyTierServerIP, p.remotePort);
      return SshId(p.target, p.sshPort, p.remoteHost, p.remotePort, password, keyText, p.extraArgs);
    }

    public static string Of(Dictionary<string, object> s, string keyText)
    {
      string S(string k, string d = "") => s.TryGetValue(k, out var v) && v is string x ? x : d;
      int I(string k, int d) => s.TryGetValue(k, out var v) && v is int x ? x : d;
      var mode = S("mode", "ssh");
      if (mode == "direct") return "direct|" + DirectIdentity(S("directUrl"));
      if (mode == "easytier") return EasyTier(S("easyTierNetwork"), S("easyTierSecret"), S("easyTierPeers"), S("easyTierServerIP"), I("remotePort", 8080));
      return SshId(S("target"), I("sshPort", 22), S("remoteHost", "127.0.0.1"), I("remotePort", 8080), S("password"), keyText, S("extraArgs"));
    }
  }

  public static class ShareImport
  {
    static readonly string KeyDir = Path.Combine(Store.Dir, "shared-keys");

    static string ReadKey(SSHKey k)
    {
      try { return k != null && File.Exists(k.File) ? File.ReadAllText(k.File) : null; } catch { return null; }
    }

    /// what goes out: the chosen servers and keys
    public static Dictionary<string, object> Payload(ICollection<string> profileIDs, ICollection<string> keyIDs, string passphrase)
    {
      var keys = new List<object>();
      var sent = new HashSet<string>();
      foreach (var k in Store.Keys.Where(k => keyIDs.Contains(k.id)))
      {
        var text = ReadKey(k);
        if (string.IsNullOrWhiteSpace(text)) throw new ShareError("读不到私钥文件：" + k.path);
        keys.Add(new Dictionary<string, object> { ["id"] = k.id, ["name"] = k.name, ["privateKey"] = text, ["passphrase"] = string.IsNullOrEmpty(passphrase) ? Store.Passphrase(k.id) : passphrase });
        sent.Add(k.id);
      }
      var profiles = new List<object>();
      foreach (var p in Store.Profiles.Where(p => profileIDs.Contains(p.id)))
      {
        var ssh = p.mode == "ssh";
        profiles.Add(new Dictionary<string, object>
        {
          ["name"] = p.name ?? "",
          ["mode"] = p.mode,
          ["directUrl"] = p.directURL ?? "",
          ["easyTierNetwork"] = p.easyTierNetwork ?? "",
          ["easyTierSecret"] = p.easyTierSecret ?? "",
          ["easyTierPeers"] = p.easyTierPeers ?? "",
          ["easyTierServerIP"] = p.easyTierServerIP ?? "",
          ["target"] = p.target ?? "",
          ["sshPort"] = p.sshPort,
          ["remoteHost"] = p.remoteHost ?? "127.0.0.1",
          ["remotePort"] = p.remotePort,
          ["keyId"] = p.keyID != null && sent.Contains(p.keyID) ? p.keyID : "",
          ["password"] = ssh ? Store.Password(p.id) : "",
          ["extraArgs"] = ssh ? p.extraArgs ?? "" : "",
        });
      }
      return new Dictionary<string, object>
      {
        ["format"] = ShareProtocol.Format,
        ["version"] = ShareProtocol.Version,
        ["exportedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ["sender"] = "tmux-web Windows",
        ["keys"] = keys,
        ["profiles"] = profiles,
      };
    }

    /// Merge a received bundle. Keys are matched by their text, servers by every connection detail.
    public static string Merge(Dictionary<string, object> payload)
    {
      var byFingerprint = new Dictionary<string, string>();
      foreach (var k in Store.Keys)
      {
        var t = ReadKey(k);
        if (!string.IsNullOrWhiteSpace(t)) byFingerprint[ShareIdentity.KeyFingerprint(t)] = k.id;
      }
      var mapped = new Dictionary<string, string>();
      int keysAdded = 0, keysReused = 0, added = 0, skipped = 0;
      var sharedKeys = payload.TryGetValue("keys", out var ks) && ks is System.Collections.IEnumerable ke ? ke.OfType<Dictionary<string, object>>().ToList() : new List<Dictionary<string, object>>();
      foreach (var sk in sharedKeys)
      {
        var text = sk.TryGetValue("privateKey", out var pk) ? pk as string : null;
        if (string.IsNullOrWhiteSpace(text)) continue;
        var sid = sk.TryGetValue("id", out var i) ? i as string ?? "" : "";
        var phrase = sk.TryGetValue("passphrase", out var pp) ? pp as string ?? "" : "";
        var fp = ShareIdentity.KeyFingerprint(text);
        if (byFingerprint.TryGetValue(fp, out var existing))
        {
          mapped[sid] = existing;
          keysReused++;
          if (phrase.Length > 0 && Store.Passphrase(existing).Length == 0) Store.SetPassphrase(existing, phrase);
          continue;
        }
        Directory.CreateDirectory(KeyDir);
        var file = Path.Combine(KeyDir, Guid.NewGuid() + ".key");
        // as received, with the final line break ssh needs (the Android app sends keys trimmed)
        Private.WriteFile(file, KeyFile.Readable(new UTF8Encoding(false).GetBytes(text)));
        var name = sk.TryGetValue("name", out var n) && n is string nn && nn.Length > 0 ? nn : "共享私钥";
        var key = new SSHKey { name = name, path = file };
        Store.Keys.Add(key);
        if (phrase.Length > 0) Store.SetPassphrase(key.id, phrase);
        byFingerprint[fp] = key.id;
        mapped[sid] = key.id;
        keysAdded++;
      }
      string KeyText(string id) => ReadKey(Store.Key(id));
      var ids = new HashSet<string>(Store.Profiles.Select(p => ShareIdentity.Of(p, Store.Password(p.id), KeyText(p.keyID))));
      var used = new HashSet<int>(Store.Profiles.Where(p => !p.IsDirect).Select(p => p.localPort));
      var sharedProfiles = payload.TryGetValue("profiles", out var ps) && ps is System.Collections.IEnumerable pe ? pe.OfType<Dictionary<string, object>>().ToList() : new List<Dictionary<string, object>>();
      foreach (var s in sharedProfiles)
      {
        string S(string k, string d = "") => s.TryGetValue(k, out var v) && v is string x ? x : d;
        int I(string k, int d) => s.TryGetValue(k, out var v) && v is int x ? x : d;
        var keyId = S("keyId");
        var mappedKey = keyId.Length > 0 && mapped.TryGetValue(keyId, out var mk) ? mk : null;
        var identity = ShareIdentity.Of(s, KeyText(mappedKey));
        if (ids.Contains(identity)) { skipped++; continue; }
        var mode = new[] { "direct", "ssh", "easytier" }.Contains(S("mode")) ? S("mode") : "ssh";
        var localPort = 18080;
        if (mode != "direct")
        {
          while (used.Contains(localPort)) localPort++;
          used.Add(localPort);
        }
        var p = new Profile
        {
          name = S("name"),
          mode = mode,
          directURL = S("directUrl"),
          easyTierNetwork = S("easyTierNetwork"),
          easyTierSecret = S("easyTierSecret"),
          easyTierPeers = S("easyTierPeers"),
          easyTierServerIP = S("easyTierServerIP"),
          target = S("target"),
          sshPort = I("sshPort", 22),
          remoteHost = S("remoteHost", "127.0.0.1"),
          remotePort = I("remotePort", 8080),
          localPort = localPort,
          keyID = mappedKey,
          extraArgs = mode == "ssh" ? S("extraArgs") : "",
        };
        Store.Upsert(p, mode == "ssh" ? S("password") : "");
        ids.Add(identity);
        added++;
      }
      Store.Save();
      var msg = "新增 " + added + " 个服务器";
      if (skipped > 0) msg += "，跳过 " + skipped + " 个重复配置";
      if (keysAdded > 0) msg += "；新增 " + keysAdded + " 把私钥";
      if (keysReused > 0) msg += "；复用 " + keysReused + " 把已有私钥";
      return msg;
    }

    /// the bundle from another device: GET /api/bundle with the password
    public static async Task<Dictionary<string, object>> Fetch(string host, int port, string password, int timeoutMs)
    {
      var req = (HttpWebRequest)WebRequest.Create("http://" + (host.Contains(":") && !host.StartsWith("[") ? "[" + host + "]" : host) + ":" + port + "/api/bundle");
      req.Proxy = null;
      req.Timeout = timeoutMs;
      req.ReadWriteTimeout = timeoutMs;
      req.Accept = "application/json";
      req.Headers["X-Share-Password-B64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(password));
      string body;
      try
      {
        var t = req.GetResponseAsync();
        if (await Task.WhenAny(t, Task.Delay(timeoutMs)) != t) { req.Abort(); throw new ShareError("连不上 " + host + ":" + port + "：连接超时"); }
        using (var r = await t)
        using (var sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
          body = await sr.ReadToEndAsync();
      }
      catch (WebException e) when (e.Response is HttpWebResponse hr)
      {
        var code = (int)hr.StatusCode;
        hr.Dispose();
        if (code == 401) throw new ShareError("密码不对");
        if (code == 429) throw new ShareError("尝试次数太多，请等一分钟再试");
        throw new ShareError("对方拒绝连接（HTTP " + code + "）");
      }
      catch (WebException e) { throw new ShareError("连不上 " + host + ":" + port + "：" + Http.Reason(e)); }
      return await Task.Run(() => ShareProtocol.Open(body, password));
    }

    /// Send a bundle to a device waiting for one (POST /api/push): its summary of what it took.
    public static async Task<string> Push(string host, int port, string password, string envelopeJson, int timeoutMs)
    {
      // an address that doesn't answer fails fast (the async request below keeps no connect timeout)
      using (var probe = new TcpClient())
      {
        try
        {
          var c = probe.ConnectAsync(host, port);
          if (await Task.WhenAny(c, Task.Delay(timeoutMs)) != c) throw new ShareError("连不上 " + host + ":" + port + "：连接超时");
          await c;
        }
        catch (ShareError) { throw; }
        catch (Exception e) { throw new ShareError("连不上 " + host + ":" + port + "：" + Http.Reason(e)); }
      }
      var req = (HttpWebRequest)WebRequest.Create("http://" + (host.Contains(":") && !host.StartsWith("[") ? "[" + host + "]" : host) + ":" + port + "/api/push");
      req.Proxy = null;
      req.Method = "POST";
      req.Timeout = timeoutMs;
      req.ReadWriteTimeout = 30000;
      req.ContentType = "application/json; charset=utf-8";
      req.Accept = "application/json";
      req.Headers["X-Share-Password-B64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(password));
      var body = Encoding.UTF8.GetBytes(envelopeJson);
      string answer;
      try
      {
        var send = Task.Run(async () =>
        {
          using (var w = await req.GetRequestStreamAsync()) await w.WriteAsync(body, 0, body.Length);
          using (var r = await req.GetResponseAsync())
          using (var sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
            return await sr.ReadToEndAsync();
        });
        // the other side derives the key (PBKDF2) and merges before it answers: a while
        if (await Task.WhenAny(send, Task.Delay(timeoutMs + 30000)) != send) { req.Abort(); throw new ShareError("连不上 " + host + ":" + port + "：连接超时"); }
        answer = await send;
      }
      catch (WebException e) when (e.Response is HttpWebResponse hr)
      {
        var code = (int)hr.StatusCode;
        string msg = null;
        try { using (var sr = new StreamReader(hr.GetResponseStream(), Encoding.UTF8)) msg = (Store.Json.Deserialize<Dictionary<string, object>>(sr.ReadToEnd())?["error"]) as string; } catch { }
        hr.Dispose();
        if (code == 401) throw new ShareError("密码不对（二维码或链接不完整？）");
        if (code == 429) throw new ShareError("尝试次数太多，请等一分钟再试");
        if (code == 410) throw new ShareError("对方已经收到过一份了：让对方重新点「等对方发过来」");
        throw new ShareError(msg ?? "对方拒绝了（HTTP " + code + "）");
      }
      catch (WebException e) { throw new ShareError("连不上 " + host + ":" + port + "：" + Http.Reason(e)); }
      catch (AggregateException e) when (e.InnerException is WebException we) { throw new ShareError("连不上 " + host + ":" + port + "：" + Http.Reason(we)); }
      try { return (Store.Json.Deserialize<Dictionary<string, object>>(answer)?["text"] as string) ?? "对方已收到"; }
      catch { return "对方已收到"; }
    }

    /// "1.2.3.4", "1.2.3.4:48620" or a URL
    public static (string host, int port) Target(string input, int fallback)
    {
      var s = (input ?? "").Trim();
      if (s.Contains("://") && Uri.TryCreate(s, UriKind.Absolute, out var u) && !string.IsNullOrEmpty(u.Host)) return (u.Host, u.IsDefaultPort ? fallback : u.Port);
      var clean = s.Split('/')[0];
      var parts = clean.Split(':');
      if (parts.Length == 2 && int.TryParse(parts[1], out var p) && parts[0].Length > 0) return (parts[0], p);
      return (clean, fallback);
    }
  }

  /// A tiny HTTP server for one encrypted bundle. It listens on every interface but only answers
  /// with the bundle after the password checks out; five wrong guesses from one address pause it.
  public class ShareServer
  {
    readonly ShareProtocol.Sealed sealedBundle;
    readonly int profileCount;
    TcpListener listener;
    readonly Dictionary<string, (int count, DateTime until)> attempts = new Dictionary<string, (int, DateTime)>();
    public readonly int Port;

    // receiving instead (POST /api/push): the password the code shows, what takes the bundle
    readonly byte[] receivePassword;
    readonly Func<Dictionary<string, object>, string> onPush;
    int pushed; // 0 waiting, 1 taking one, 2 done: one bundle per code
    bool Receiving => receivePassword != null;
    int MaxBody => Receiving ? 8 * 1024 * 1024 : 16 * 1024;

    public ShareServer(ShareProtocol.Sealed s, int profiles, int port)
    {
      sealedBundle = s;
      profileCount = profiles;
      Port = port;
    }

    public ShareServer(string password, int port, Func<Dictionary<string, object>, string> take)
    {
      receivePassword = Encoding.UTF8.GetBytes(password);
      onPush = take;
      Port = port;
    }

    public void Start()
    {
      listener = new TcpListener(IPAddress.Any, Port);
      listener.Start();
      var t = new Thread(Loop) { IsBackground = true, Name = "share" };
      t.Start();
    }

    public void Stop()
    {
      try { listener?.Stop(); } catch { }
      listener = null;
    }

    void Loop()
    {
      var l = listener;
      while (l != null && listener == l)
      {
        TcpClient c;
        try { c = l.AcceptTcpClient(); } catch { return; }
        Task.Run(() => Serve(c));
      }
    }

    void Serve(TcpClient c)
    {
      using (c)
      {
        try
        {
          c.ReceiveTimeout = 10000;
          c.SendTimeout = 10000;
          var ip = ((IPEndPoint)c.Client.RemoteEndPoint).Address.ToString();
          var s = c.GetStream();
          var buf = new MemoryStream();
          var chunk = new byte[16 * 1024];
          string head = null;
          int bodyStart = -1, length = 0;
          while (true)
          {
            var n = s.Read(chunk, 0, chunk.Length);
            if (n <= 0) return;
            buf.Write(chunk, 0, n);
            if (buf.Length > MaxBody + 32 * 1024) { Send(s, 413, "text/plain; charset=utf-8", "请求太大"); return; }
            var data = buf.ToArray();
            if (head == null)
            {
              var end = IndexOf(data, new byte[] { 13, 10, 13, 10 });
              if (end < 0) { if (data.Length > 32 * 1024) { Send(s, 400, "text/plain; charset=utf-8", "请求不完整"); return; } continue; }
              head = Encoding.UTF8.GetString(data, 0, end);
              bodyStart = end + 4;
              var m = System.Text.RegularExpressions.Regex.Match(head, @"(?im)^content-length:\s*(\d+)");
              length = m.Success ? int.Parse(m.Groups[1].Value) : 0;
              if (length > MaxBody) { Send(s, 413, "text/plain; charset=utf-8", "请求太大"); return; }
            }
            if (data.Length >= bodyStart + length)
            {
              Route(s, head, Encoding.UTF8.GetString(data, bodyStart, length), ip);
              return;
            }
          }
        }
        catch { }
      }
    }

    void Route(Stream s, string head, string body, string ip)
    {
      var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
      var first = lines[0].Split(' ');
      if (first.Length < 2) { Send(s, 400, "text/plain; charset=utf-8", "请求不完整"); return; }
      var method = first[0].ToUpperInvariant();
      var path = first[1].Split('?')[0];
      var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (var line in lines.Skip(1))
      {
        var i = line.IndexOf(':');
        if (i > 0) headers[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
      }
      const string json = "application/json; charset=utf-8";
      if (Receiving) { Receive(s, method, path, headers, body, ip); return; }
      if (method == "GET" && (path == "/" || path == "/index.html")) { Send(s, 200, "text/html; charset=utf-8", Page()); return; }
      if (method == "GET" && path == "/api/info")
      {
        Send(s, 200, json, Store.Json.Serialize(new Dictionary<string, object> { ["format"] = ShareProtocol.Format, ["version"] = ShareProtocol.Version.ToString(), ["service"] = "tmux-web" }));
        return;
      }
      if (method == "GET" && path == "/api/bundle")
      {
        string pw = null;
        try { if (headers.TryGetValue("x-share-password-b64", out var h)) pw = Encoding.UTF8.GetString(Convert.FromBase64String(h)); } catch { }
        if (pw == null) { Send(s, 401, json, Err("需要密码")); return; }
        Authorized(s, pw, ip, false);
        return;
      }
      if (method == "POST" && path == "/download")
      {
        string pw = null;
        foreach (var part in body.Split('&'))
        {
          var kv = part.Split(new[] { '=' }, 2);
          if (kv.Length == 2 && kv[0] == "password") { try { pw = Uri.UnescapeDataString(kv[1].Replace("+", " ")); } catch { } }
        }
        if (pw == null) { Send(s, 400, json, Err("需要密码")); return; }
        Authorized(s, pw, ip, true);
        return;
      }
      Send(s, 404, "text/plain; charset=utf-8", "没有这个页面");
    }

    void Authorized(Stream s, string pw, string ip, bool download)
    {
      const string json = "application/json; charset=utf-8";
      if (Blocked(ip)) { Send(s, 429, json, Err("尝试次数太多，请稍后再试")); return; }
      if (!ShareProtocol.Verify(pw, sealedBundle))
      {
        lock (attempts)
        {
          attempts.TryGetValue(ip, out var a);
          a.count++;
          if (a.count >= 5) { a.count = 0; a.until = DateTime.UtcNow.AddSeconds(60); }
          attempts[ip] = a;
        }
        if (Blocked(ip)) Send(s, 429, json, Err("尝试次数太多，请稍后再试"));
        else Send(s, 401, json, Err("密码不对"));
        return;
      }
      lock (attempts) attempts.Remove(ip);
      Send(s, 200, json, sealedBundle.envelopeJson, download ? "Content-Disposition: attachment; filename=\"tmux-web-config-share.json\"\r\n" : "");
    }

    void Receive(Stream s, string method, string path, Dictionary<string, string> headers, string body, string ip)
    {
      const string json = "application/json; charset=utf-8";
      if (method == "GET" && path == "/api/info")
      {
        Send(s, 200, json, Store.Json.Serialize(new Dictionary<string, object> { ["format"] = ShareProtocol.Format, ["version"] = ShareProtocol.Version.ToString(), ["service"] = "tmux-web", ["mode"] = "receive" }));
        return;
      }
      if (method == "GET" && (path == "/" || path == "/index.html"))
      {
        Send(s, 200, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>tmux-web 接收配置</title><body style=\"font:16px/1.55 sans-serif;max-width:640px;margin:48px auto;padding:0 20px\"><h2>tmux-web 正在等待接收配置</h2><p>在另一台设备打开 tmux-web App → 共享配置 → 共享给其他设备 → 扫码发送，扫这台电脑上显示的二维码。</p></body>");
        return;
      }
      if (method != "POST" || path != "/api/push") { Send(s, 404, "text/plain; charset=utf-8", "没有这个页面"); return; }
      if (Blocked(ip)) { Send(s, 429, json, Err("尝试次数太多，请稍后再试")); return; }
      byte[] pw = null;
      try { if (headers.TryGetValue("x-share-password-b64", out var h)) pw = Convert.FromBase64String(h); } catch { }
      if (pw == null || !Same(pw, receivePassword))
      {
        Failed(ip);
        if (Blocked(ip)) Send(s, 429, json, Err("尝试次数太多，请稍后再试"));
        else Send(s, 401, json, Err("密码不对"));
        return;
      }
      lock (attempts) attempts.Remove(ip);
      if (System.Threading.Interlocked.CompareExchange(ref pushed, 1, 0) != 0) { Send(s, 410, json, Err("已经收到过一份了")); return; }
      try
      {
        var payload = ShareProtocol.Open(body, Encoding.UTF8.GetString(receivePassword));
        var text = onPush(payload);
        pushed = 2;
        Send(s, 200, json, Store.Json.Serialize(new Dictionary<string, object> { ["ok"] = true, ["text"] = text }));
      }
      catch (Exception e)
      {
        pushed = 0; // a broken bundle: the sender may try again
        Send(s, 400, json, Err(e is ShareError ? e.Message : "收到的内容解不开：" + e.Message));
      }
    }

    /// the same bytes, in a time that doesn't tell how much matched
    static bool Same(byte[] a, byte[] b)
    {
      var d = a.Length ^ b.Length;
      for (var i = 0; i < Math.Min(a.Length, b.Length); i++) d |= a[i] ^ b[i];
      return d == 0;
    }

    void Failed(string ip)
    {
      lock (attempts)
      {
        attempts.TryGetValue(ip, out var a);
        a.count++;
        if (a.count >= 5) { a.count = 0; a.until = DateTime.UtcNow.AddSeconds(60); }
        attempts[ip] = a;
      }
    }

    bool Blocked(string ip)
    {
      lock (attempts) return attempts.TryGetValue(ip, out var a) && a.until > DateTime.UtcNow;
    }

    static string Err(string m) => Store.Json.Serialize(new Dictionary<string, object> { ["error"] = m });

    static void Send(Stream s, int status, string type, string body, string extra = "")
    {
      var reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : status == 410 ? "Gone" : status == 413 ? "Payload Too Large" : status == 429 ? "Too Many Requests" : "Error";
      var b = Encoding.UTF8.GetBytes(body);
      var h = Encoding.UTF8.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Type: {type}\r\nContent-Length: {b.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n");
      s.Write(h, 0, h.Length);
      s.Write(b, 0, b.Length);
      s.Flush();
    }

    static int IndexOf(byte[] data, byte[] pat)
    {
      for (var i = 0; i + pat.Length <= data.Length; i++)
      {
        var ok = true;
        for (var j = 0; j < pat.Length && ok; j++) ok = data[i + j] == pat[j];
        if (ok) return i;
      }
      return -1;
    }

    string Page() => @"<!doctype html>
<html lang=""zh-CN""><head><meta charset=""utf-8""><meta name=""viewport"" content=""width=device-width,initial-scale=1"">
<title>tmux-web 共享配置</title>
<style>body{font:16px/1.55 -apple-system,BlinkMacSystemFont,""Segoe UI"",sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#202124}input,button{font:inherit;padding:10px}input{width:100%;box-sizing:border-box;margin:8px 0 14px;border:1px solid #bbb;border-radius:8px}button{border:0;border-radius:8px;background:#2f6fde;color:#fff;padding:11px 20px}.note{color:#5f6368;font-size:14px}</style></head>
<body><h2>tmux-web 共享配置</h2>
<p>这台设备正在共享 <b>" + profileCount + @"</b> 个服务器配置。请在另一台设备打开 tmux-web App，进入「共享配置 → 从其他设备获取」，填入本页地址、端口和密码。</p>
<p class=""note"">也可以在下面输入密码下载加密的共享文件。文件里的私钥和密码只有密码正确时才能解开。</p>
<form method=""post"" action=""/download""><label for=""password"">访问密码</label><input id=""password"" name=""password"" type=""password"" required><button type=""submit"">下载加密配置</button></form>
<p class=""note"">只在你信任的局域网里使用。关闭共享后这个页面就不能访问了。</p></body></html>";

    /// every IPv4 address of an interface that is up, loopback aside
    public static List<string> LocalIPv4()
    {
      var set = new SortedSet<string>(StringComparer.Ordinal);
      try
      {
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
          if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
          foreach (var a in ni.GetIPProperties().UnicastAddresses)
          {
            if (a.Address.AddressFamily != AddressFamily.InterNetwork) continue;
            var s = a.Address.ToString();
            if (s.StartsWith("169.254.") || s.StartsWith("127.")) continue;
            set.Add(s);
          }
        }
      }
      catch { }
      return set.ToList();
    }
  }

  /// The outgoing share: lives on after its dialog closes, until stopped or the app quits.
  public static class ShareService
  {
    public static ShareServer Server;
    public static int ProfileCount, KeyCount;
    public static List<string> Addresses = new List<string>();
    public static string Link;
    public static bool Starting;
    public static string Error;

    public static object Info => new
    {
      running = Server != null,
      starting = Starting,
      error = Error,
      port = Server?.Port ?? 0,
      addresses = Addresses,
      profileCount = ProfileCount,
      keyCount = KeyCount,
      link = Link,
    };

    public static async Task Start(ICollection<string> profiles, ICollection<string> keys, string passphrase, string password, int port)
    {
      Stop();
      Error = null;
      if (port < 1024 || port > 65535) { Error = "端口在 1024–65535 之间"; return; }
      try { ShareProtocol.CheckPassword(password); } catch (Exception e) { Error = e.Message; return; }
      Starting = true;
      try
      {
        var payload = ShareImport.Payload(profiles, keys, passphrase);
        var sealedBundle = await Task.Run(() => ShareProtocol.Seal(payload, password));
        var server = new ShareServer(sealedBundle, profiles.Count, port);
        try { server.Start(); }
        catch (SocketException e) when (e.SocketErrorCode == SocketError.AddressAlreadyInUse) { throw new ShareError("端口 " + port + " 已被占用，换一个"); }
        catch (Exception e) { throw new ShareError("共享服务启动失败：" + e.Message); }
        Server = server;
        ProfileCount = ((System.Collections.ICollection)payload["profiles"]).Count;
        KeyCount = ((System.Collections.ICollection)payload["keys"]).Count;
        Addresses = ShareServer.LocalIPv4();
        Link = Addresses.Count == 0 ? null : new ShareLink { hosts = Addresses, port = port, password = password }.Text;
      }
      catch (Exception e) { Error = e.Message; }
      finally { Starting = false; }
    }

    public static void Stop()
    {
      Server?.Stop();
      Server = null;
      Link = null;
      Addresses = new List<string>();
      Starting = false;
    }

    // ---- receiving: this device waits, the other one scans the code and sends

    public const int ReceivePort = 48621;
    public static ShareServer Receiver;
    public static string ReceiveLink, ReceiveResult, ReceiveError;
    public static List<string> ReceiveAddresses = new List<string>();

    public static object ReceiveInfo => new
    {
      running = Receiver != null,
      port = Receiver?.Port ?? 0,
      addresses = ReceiveAddresses,
      link = ReceiveLink,
      result = ReceiveResult,
      error = ReceiveError,
    };

    /// take: merges what came (on the UI thread) and says what it took; done: after that, from
    /// the server's thread
    public static void StartReceiving(Func<Dictionary<string, object>, string> take, Action done)
    {
      StopReceiving();
      ReceiveResult = null;
      ReceiveError = null;
      var password = ShareProtocol.RandomPassword();
      ShareServer server = null;
      // the usual port, or the next free one
      for (var port = ReceivePort; port < ReceivePort + 20 && server == null; port++)
      {
        ShareServer s = null;
        s = new ShareServer(password, port, payload =>
        {
          var text = take(payload);
          ReceiveResult = text;
          // after the answer has gone out
          Task.Delay(500).ContinueWith(_ => { if (Receiver == s) StopReceiving(keepResult: true); done(); });
          return text;
        });
        try { s.Start(); server = s; }
        catch (SocketException e) when (e.SocketErrorCode == SocketError.AddressAlreadyInUse) { }
        catch (Exception e) { ReceiveError = "接收服务启动失败：" + e.Message; return; }
      }
      if (server == null) { ReceiveError = "端口 " + ReceivePort + "–" + (ReceivePort + 19) + " 都被占用了"; return; }
      Receiver = server;
      ReceiveAddresses = ShareServer.LocalIPv4();
      ReceiveLink = ReceiveAddresses.Count == 0 ? null : new ShareLink { hosts = ReceiveAddresses, port = server.Port, password = password, receive = true }.Text;
    }

    public static void StopReceiving(bool keepResult = false)
    {
      Receiver?.Stop();
      Receiver = null;
      ReceiveLink = null;
      ReceiveAddresses = new List<string>();
      if (!keepResult) { ReceiveResult = null; ReceiveError = null; }
    }
  }

  /// AES-GCM through Windows' own BCrypt (the .NET Framework has none of its own).
  static class AesGcm
  {
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptOpenAlgorithmProvider(out IntPtr h, string alg, string impl, uint flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)] static extern uint BCryptSetProperty(IntPtr h, string prop, byte[] input, int size, uint flags);
    [DllImport("bcrypt.dll")] static extern uint BCryptGenerateSymmetricKey(IntPtr alg, out IntPtr key, IntPtr obj, int objSize, byte[] secret, int secretLen, uint flags);
    [DllImport("bcrypt.dll")] static extern uint BCryptEncrypt(IntPtr key, byte[] input, int inLen, ref Info padding, IntPtr iv, int ivLen, byte[] output, int outLen, out int result, uint flags);
    [DllImport("bcrypt.dll")] static extern uint BCryptDecrypt(IntPtr key, byte[] input, int inLen, ref Info padding, IntPtr iv, int ivLen, byte[] output, int outLen, out int result, uint flags);
    [DllImport("bcrypt.dll")] static extern uint BCryptDestroyKey(IntPtr key);
    [DllImport("bcrypt.dll")] static extern uint BCryptCloseAlgorithmProvider(IntPtr h, uint flags);

    /// BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO
    [StructLayout(LayoutKind.Sequential)]
    struct Info
    {
      public int cbSize, dwInfoVersion;
      public IntPtr pbNonce; public int cbNonce;
      public IntPtr pbAuthData; public int cbAuthData;
      public IntPtr pbTag; public int cbTag;
      public IntPtr pbMacContext; public int cbMacContext;
      public int cbAAD; public long cbData; public int dwFlags;
    }

    /// ciphertext followed by the 16-byte tag
    public static byte[] Encrypt(byte[] key, byte[] nonce, byte[] plain, byte[] aad)
    {
      var tag = new byte[16];
      var outp = new byte[plain.Length];
      Run(key, nonce, aad, tag, (IntPtr k, ref Info info) => BCryptEncrypt(k, plain, plain.Length, ref info, IntPtr.Zero, 0, outp, outp.Length, out _, 0));
      return outp.Concat(tag).ToArray();
    }

    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] data, byte[] aad)
    {
      if (data.Length < 16) throw new CryptographicException("too short");
      var cipher = data.Take(data.Length - 16).ToArray();
      var tag = data.Skip(data.Length - 16).ToArray();
      var outp = new byte[cipher.Length];
      Run(key, nonce, aad, tag, (IntPtr k, ref Info info) => BCryptDecrypt(k, cipher, cipher.Length, ref info, IntPtr.Zero, 0, outp, outp.Length, out _, 0));
      return outp;
    }

    delegate uint Op(IntPtr key, ref Info info);

    static void Run(byte[] key, byte[] nonce, byte[] aad, byte[] tag, Op op)
    {
      Check(BCryptOpenAlgorithmProvider(out var alg, "AES", null, 0));
      var hNonce = GCHandle.Alloc(nonce, GCHandleType.Pinned);
      var hAad = GCHandle.Alloc(aad, GCHandleType.Pinned);
      var hTag = GCHandle.Alloc(tag, GCHandleType.Pinned);
      var k = IntPtr.Zero;
      try
      {
        var mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
        Check(BCryptSetProperty(alg, "ChainingMode", mode, mode.Length, 0));
        Check(BCryptGenerateSymmetricKey(alg, out k, IntPtr.Zero, 0, key, key.Length, 0));
        var info = new Info
        {
          cbSize = Marshal.SizeOf(typeof(Info)),
          dwInfoVersion = 1,
          pbNonce = hNonce.AddrOfPinnedObject(), cbNonce = nonce.Length,
          pbAuthData = hAad.AddrOfPinnedObject(), cbAuthData = aad.Length,
          pbTag = hTag.AddrOfPinnedObject(), cbTag = tag.Length,
        };
        Check(op(k, ref info));
      }
      finally
      {
        if (k != IntPtr.Zero) BCryptDestroyKey(k);
        BCryptCloseAlgorithmProvider(alg, 0);
        hNonce.Free();
        hAad.Free();
        hTag.Free();
      }
    }

    static void Check(uint status)
    {
      if (status != 0) throw new CryptographicException("BCrypt 0x" + status.ToString("X8"));
    }
  }
}
