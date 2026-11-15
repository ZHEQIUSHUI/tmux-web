using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace TmuxWeb
{
  /// One server: how to reach it, and which port of it serves tmux-web.
  public class Profile
  {
    public string id = Guid.NewGuid().ToString();
    public string name = "";
    /// "direct": open directURL as it is; "ssh": an SSH port forward; "easytier": the bundled EasyTier Core
    public string mode = "direct";
    public string directURL = "";
    public string easyTierNetwork = "";
    public string easyTierSecret = "";
    /// one node a line, e.g. tcp://public.example.com:11010
    public string easyTierPeers = "";
    public string easyTierServerIP = "";
    /// user@host, or a Host alias from ~/.ssh/config
    public string target = "";
    public int sshPort = 22;
    public string remoteHost = "127.0.0.1";
    public int remotePort = 8080;
    /// fixed per server, so its page keeps its login (it belongs to http://127.0.0.1:<port>)
    public int localPort = 18080;
    /// one of the key list's; null: ~/.ssh/config decides
    public string keyID;
    public string extraArgs = "";
    /// ms since 1970, 0: never
    public long lastUsed;

    public bool IsDirect => mode == "direct";
    public bool IsEasyTier => mode == "easytier";

    public string Title
    {
      get
      {
        var n = (name ?? "").Trim();
        if (n.Length > 0) return n;
        if (IsDirect)
        {
          var b = DirectBase;
          return b != null ? new Uri(b).Host : directURL;
        }
        if (IsEasyTier) return string.IsNullOrWhiteSpace(easyTierServerIP) ? easyTierNetwork : easyTierServerIP.Trim();
        return (target ?? "").Trim();
      }
    }

    public string Address
    {
      get
      {
        if (IsDirect) return DirectBase ?? directURL;
        if (IsEasyTier)
        {
          var net = (easyTierNetwork ?? "").Trim();
          return "EasyTier" + (net.Length > 0 ? " · " + net : "") + " → " + (easyTierServerIP ?? "").Trim() + ":" + remotePort;
        }
        return (target ?? "").Trim() + (sshPort == 22 ? "" : ":" + sshPort) + " → " + remotePort;
      }
    }

    public bool IsComplete
    {
      get
      {
        if (IsDirect) return DirectBase != null;
        if (IsEasyTier) return EasyTierConfig.Problem(this) == null;
        return !string.IsNullOrWhiteSpace(target) && remotePort > 0 && localPort > 0;
      }
    }

    /// The direct address as http(s)://host[:port], or null when it isn't one ("10.0.0.2:8080" gets http://).
    public string DirectBase
    {
      get
      {
        var s = (directURL ?? "").Trim();
        if (s.Length == 0) return null;
        if (!s.Contains("://")) s = "http://" + s;
        s = s.TrimEnd('/');
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u)) return null;
        if (u.Scheme != "http" && u.Scheme != "https") return null;
        if (string.IsNullOrEmpty(u.Host)) return null;
        return s;
      }
    }

    public Profile Clone() => (Profile)MemberwiseClone();

    /// the same as far as connecting goes (a new name doesn't need a new connection)
    public bool SameConnection(Profile o)
    {
      if (o == null) return false;
      return mode == o.mode && directURL == o.directURL && easyTierNetwork == o.easyTierNetwork && easyTierSecret == o.easyTierSecret
        && easyTierPeers == o.easyTierPeers && easyTierServerIP == o.easyTierServerIP && target == o.target && sshPort == o.sshPort
        && remoteHost == o.remoteHost && remotePort == o.remotePort && localPort == o.localPort && keyID == o.keyID && extraArgs == o.extraArgs;
    }
  }

  /// A private key file, kept once in a list of its own: any number of servers log in with it.
  public class SSHKey
  {
    public string id = Guid.NewGuid().ToString();
    public string name = "";
    /// as picked; a .pub picked by mistake means the key next to it
    public string path = "";

    public string File
    {
      get
      {
        var p = Environment.ExpandEnvironmentVariables((path ?? "").Trim());
        if (p.StartsWith("~")) p = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + p.Substring(1);
        if (p.EndsWith(".pub", StringComparison.OrdinalIgnoreCase))
        {
          var priv = p.Substring(0, p.Length - 4);
          if (System.IO.File.Exists(priv)) return priv;
        }
        return p;
      }
    }

    public bool Exists => System.IO.File.Exists(File);

    public static SSHKey Of(string path)
    {
      var name = Path.GetFileName(path);
      if (name.EndsWith(".pub", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
      return new SSHKey { name = name, path = path };
    }
  }

  class Saved
  {
    public List<Profile> profiles = new List<Profile>();
    public List<SSHKey> keys = new List<SSHKey>();
    public Dictionary<string, string> passwords = new Dictionary<string, string>();
    public string current;
    public Dictionary<string, string> settings = new Dictionary<string, string>();
  }

  /// The servers, the keys and the saved passwords: one file, encrypted for this Windows account (DPAPI).
  public static class Store
  {
    public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TmuxWeb");
    static readonly string FilePath = Path.Combine(Dir, "servers.dat");
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("tmux-web servers v1");
    static Saved data = new Saved();
    public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    public static List<Profile> Profiles => data.profiles;
    public static List<SSHKey> Keys => data.keys;
    public static string CurrentID { get => data.current; set { data.current = value; Save(); } }

    public static void Load()
    {
      Directory.CreateDirectory(Dir);
      try
      {
        if (System.IO.File.Exists(FilePath))
        {
          var plain = ProtectedData.Unprotect(System.IO.File.ReadAllBytes(FilePath), Entropy, DataProtectionScope.CurrentUser);
          data = Json.Deserialize<Saved>(Encoding.UTF8.GetString(plain)) ?? new Saved();
        }
      }
      catch (Exception e)
      {
        Log.Write("load failed: " + e.Message);
        // keep the unreadable file for a look, start empty
        try { System.IO.File.Copy(FilePath, FilePath + ".bad", true); } catch { }
        data = new Saved();
      }
      data.profiles = data.profiles ?? new List<Profile>();
      data.keys = data.keys ?? new List<SSHKey>();
      data.passwords = data.passwords ?? new Dictionary<string, string>();
      data.settings = data.settings ?? new Dictionary<string, string>();
    }

    public static void Save()
    {
      try
      {
        Directory.CreateDirectory(Dir);
        var plain = Encoding.UTF8.GetBytes(Json.Serialize(data));
        var enc = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        var tmp = FilePath + ".tmp";
        System.IO.File.WriteAllBytes(tmp, enc);
        if (System.IO.File.Exists(FilePath)) System.IO.File.Replace(tmp, FilePath, null);
        else System.IO.File.Move(tmp, FilePath);
      }
      catch (Exception e) { Log.Write("save failed: " + e.Message); }
    }

    public static string Setting(string k) => data.settings.TryGetValue(k, out var v) ? v : null;
    public static void SetSetting(string k, string v)
    {
      if (v == null) data.settings.Remove(k); else data.settings[k] = v;
      Save();
    }

    public static Profile Get(string id) => id == null ? null : data.profiles.FirstOrDefault(p => p.id == id);

    /// the most recently used first, then by name
    public static List<Profile> Sorted => data.profiles
      .OrderByDescending(p => p.lastUsed)
      .ThenBy(p => p.Title, StringComparer.CurrentCultureIgnoreCase).ToList();

    public static void Touch(string id)
    {
      var p = Get(id);
      if (p == null) return;
      p.lastUsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      data.current = id;
      Save();
    }

    public static void Upsert(Profile p, string password)
    {
      var i = data.profiles.FindIndex(x => x.id == p.id);
      if (i >= 0) data.profiles[i] = p; else data.profiles.Add(p);
      if (string.IsNullOrEmpty(password)) data.passwords.Remove(p.id); else data.passwords[p.id] = password;
      if (data.current == null) data.current = p.id;
      Save();
    }

    public static void Remove(string id)
    {
      data.profiles.RemoveAll(p => p.id == id);
      data.passwords.Remove(id);
      if (data.current == id) data.current = data.profiles.FirstOrDefault()?.id;
      Save();
    }

    public static string Password(string id) => id != null && data.passwords.TryGetValue(id, out var pw) ? pw : "";

    /// A local port no other forwarded server here uses: each keeps its own page login.
    public static int FreeLocalPort(string except = null)
    {
      var used = new HashSet<int>(data.profiles.Where(p => !p.IsDirect && p.id != except).Select(p => p.localPort));
      var port = 18080;
      while (used.Contains(port)) port++;
      return port;
    }

    public static SSHKey Key(string id) => id == null ? null : data.keys.FirstOrDefault(k => k.id == id);

    public static List<Profile> UsersOf(string keyID) => Sorted.Where(p => !p.IsDirect && p.keyID == keyID).ToList();

    static string Norm(string f) { try { return Path.GetFullPath(f).ToLowerInvariant(); } catch { return f.ToLowerInvariant(); } }

    /// The entry for a picked file: the one there is for it, or a new one.
    public static SSHKey AddKey(string path, out bool known)
    {
      var k = SSHKey.Of(path);
      var same = data.keys.FirstOrDefault(x => Norm(x.File) == Norm(k.File));
      known = same != null;
      if (same != null) return same;
      data.keys.Add(k);
      Save();
      return k;
    }

    public static void UpdateKey(SSHKey k)
    {
      var i = data.keys.FindIndex(x => x.id == k.id);
      if (i >= 0) data.keys[i] = k; else data.keys.Add(k);
      Save();
    }

    /// gone from the list; the servers that used it go back to ~/.ssh/config
    public static void RemoveKey(string id)
    {
      foreach (var p in data.profiles) if (p.keyID == id) p.keyID = null;
      data.keys.RemoveAll(k => k.id == id);
      Save();
    }
  }

  /// A small log for looking into problems: %LOCALAPPDATA%\TmuxWeb\tmux-web.log (kept short).
  public static class Log
  {
    static readonly object gate = new object();
    public static readonly string FilePath = Path.Combine(Store.Dir, "tmux-web.log");

    public static void Write(string line)
    {
      lock (gate)
      {
        try
        {
          Directory.CreateDirectory(Store.Dir);
          var fi = new FileInfo(FilePath);
          if (fi.Exists && fi.Length > 512 * 1024) fi.Delete();
          System.IO.File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + line + "\r\n");
        }
        catch { }
      }
    }
  }
}
