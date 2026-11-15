using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace TmuxWeb
{
  /// The EasyTier part of a server: a small generated TOML file for the bundled Core. It runs without
  /// a TUN device and forwards one local TCP port to tmux-web's address inside the virtual network.
  public static class EasyTierConfig
  {
    /// what may separate nodes: commas and semicolons (also full-width ones), spaces, line breaks
    static readonly char[] Separators = { ',', '，', ';', '；', ' ', '\t', '\r', '\n' };

    public static List<string> Peers(string text) =>
      (text ?? "").Split(Separators, StringSplitOptions.RemoveEmptyEntries).ToList();

    public static bool ValidIPv4(string text)
    {
      var t = (text ?? "").Trim();
      var parts = t.Split('.');
      if (parts.Length != 4) return false;
      return parts.All(x => x.Length > 0 && x.Length <= 3 && x.All(char.IsDigit) && int.Parse(x) <= 255);
    }

    public static bool ValidPeer(string text)
    {
      if (!Uri.TryCreate(text, UriKind.Absolute, out var u)) return false;
      if (string.IsNullOrEmpty(u.Scheme) || string.IsNullOrEmpty(u.Host)) return false;
      // Uri gives -1 for schemes it doesn't know when no port is written
      return u.Port > 0 && u.Port <= 65535 && text.Substring(text.IndexOf("://") + 3).Contains(":");
    }

    public static string Problem(Profile p)
    {
      if (string.IsNullOrWhiteSpace(p.easyTierNetwork)) return "填写 EasyTier 网络名称";
      if (!ValidIPv4(p.easyTierServerIP)) return "服务器虚拟 IP 要是 IPv4 地址，比如 10.144.144.30";
      if (p.remotePort < 1 || p.remotePort > 65535) return "tmux-web 端口在 1–65535 之间";
      if (p.localPort < 1 || p.localPort > 65535) return "本地端口在 1–65535 之间";
      var peers = Peers(p.easyTierPeers);
      if (peers.Count == 0) return "至少填一个 EasyTier 公共节点";
      var bad = peers.FirstOrDefault(x => !ValidPeer(x));
      if (bad != null) return "公共节点格式不对：" + bad + "。比如 tcp://public.example.com:11010";
      return null;
    }

    /// A complete no-TUN configuration. The node needs a virtual IP (dhcp): without one EasyTier has
    /// no userspace stack for the forward and dials the server IP directly, outside the network.
    public static string Make(Profile p)
    {
      var problem = Problem(p);
      if (problem != null) throw new Exception(problem);
      var serverIP = p.easyTierServerIP.Trim();
      var instance = "tmux-web-" + p.id.Substring(0, 8).ToLowerInvariant();
      var sb = new StringBuilder();
      sb.Append("instance_name = ").Append(Str(instance)).Append('\n');
      sb.Append("dhcp = true\nlisteners = []\nmapped_listeners = []\nexit_nodes = []\nrpc_portal = \"127.0.0.1:0\"\n\n");
      sb.Append("[network_identity]\n");
      sb.Append("network_name = ").Append(Str(p.easyTierNetwork.Trim())).Append('\n');
      sb.Append("network_secret = ").Append(Str(p.easyTierSecret ?? "")).Append("\n\n");
      foreach (var peer in Peers(p.easyTierPeers)) sb.Append("[[peer]]\nuri = ").Append(Str(peer)).Append("\n\n");
      sb.Append(@"[flags]
default_protocol = ""tcp""
enable_encryption = true
enable_ipv6 = true
mtu = 1380
latency_first = false
enable_exit_node = false
no_tun = true
use_smoltcp = false
relay_network_whitelist = ""*""
disable_p2p = false
relay_all_peer_rpc = false
disable_udp_hole_punching = false
disable_tcp_hole_punching = false

[[port_forward]]
proto = ""tcp""
".Replace("\r\n", "\n"));
      sb.Append("bind_addr = \"127.0.0.1:").Append(p.localPort).Append("\"\n");
      sb.Append("dst_addr = \"").Append(serverIP).Append(':').Append(p.remotePort).Append("\"\n");
      return sb.ToString();
    }

    /// A TOML basic string. Network secrets can contain quotes, backslashes and control characters.
    public static string Str(string value)
    {
      var sb = new StringBuilder("\"");
      foreach (var c in value)
      {
        switch (c)
        {
          case '\b': sb.Append("\\b"); break;
          case '\t': sb.Append("\\t"); break;
          case '\n': sb.Append("\\n"); break;
          case '\f': sb.Append("\\f"); break;
          case '\r': sb.Append("\\r"); break;
          case '"': sb.Append("\\\""); break;
          case '\\': sb.Append("\\\\"); break;
          default:
            if (c < 0x20 || c == 0x7f) sb.Append("\\u").Append(((int)c).ToString("X4"));
            else sb.Append(c);
            break;
        }
      }
      return sb.Append('"').ToString();
    }

    /// EasyTier echoes its config at info level, including network_secret: scrubbed from anything shown.
    public static string Redact(string text, string secret)
    {
      var lines = (text ?? "").Split('\n').Select(l => l.IndexOf("network_secret", StringComparison.OrdinalIgnoreCase) >= 0 ? "network_secret = \"<已隐藏>\"" : l);
      var o = string.Join("\n", lines);
      if (string.IsNullOrEmpty(secret)) return o;
      o = o.Replace(Str(secret), "\"<已隐藏>\"");
      if (secret.Length >= 3) o = o.Replace(secret, "<已隐藏>");
      return o;
    }
  }

  public static class EasyTierCore
  {
    /// the Core packaged next to the app (EasyTier\easytier-core.exe), or an installed one
    public static string Executable
    {
      get
      {
        var list = new List<string>();
        var env = Environment.GetEnvironmentVariable("TMUX_WEB_EASYTIER_CORE");
        if (!string.IsNullOrEmpty(env)) list.Add(env);
        list.Add(Path.Combine(AppContext.BaseDirectory, "EasyTier", "easytier-core.exe"));
        list.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "EasyTier", "easytier-core.exe"));
        return list.FirstOrDefault(File.Exists);
      }
    }
  }

  /// The generated config: readable only by this user, removed when its connection stops.
  public static class EasyTierFiles
  {
    public static readonly string Directory = Path.Combine(Store.Dir, "easytier");

    public static string PathFor(string id) => Path.Combine(Directory, id.ToLowerInvariant() + ".toml");

    public static string Write(string text, string id)
    {
      System.IO.Directory.CreateDirectory(Directory);
      var path = PathFor(id);
      try { File.Delete(path); } catch { }
      Private.WriteFile(path, Encoding.UTF8.GetBytes(text));
      return path;
    }

    public static void Remove(string path)
    {
      if (path == null) return;
      try { File.Delete(path); } catch { }
    }

    /// A crash can leave configs behind: the secret shouldn't outlive the connection that needed it.
    public static void RemoveStale()
    {
      try
      {
        if (!System.IO.Directory.Exists(Directory)) return;
        foreach (var f in System.IO.Directory.GetFiles(Directory, "*.toml")) try { File.Delete(f); } catch { }
      }
      catch { }
    }
  }

  /// Files only this Windows account (and the system) can read: generated configs, key copies.
  public static class Private
  {
    public static void WriteFile(string path, byte[] data)
    {
      using (var f = File.Create(path)) { }
      var me = WindowsIdentity.GetCurrent().User;
      var sec = new FileSecurity();
      sec.SetAccessRuleProtection(true, false);
      sec.SetOwner(me);
      sec.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
      sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
      File.SetAccessControl(path, sec);
      File.WriteAllBytes(path, data);
    }
  }
}
