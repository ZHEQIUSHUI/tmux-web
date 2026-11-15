using System;
using System.Diagnostics;
using System.Linq;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace TmuxWeb
{
  /// Whether a server answers, as the home screen and 测试连接 show it.
  public class Probe
  {
    /// checking | online | offline | unknown
    public string kind;
    public int ms;
    public string text;
    public static Probe Of(string kind, string text = null, int ms = 0) => new Probe { kind = kind, text = text, ms = ms };
  }

  public static class Prober
  {
    /// direct: tmux-web itself answers (any HTTP status: 401 means it's there); SSH: the SSH port
    /// takes a connection (logging in is left to connecting).
    public static async Task<Probe> Check(Profile p)
    {
      if (p.IsDirect)
      {
        var b = p.DirectBase;
        if (b == null) return Probe.Of("offline", "网址不对");
        var r = await Http.Answers(b + "/_tw/api/me", 5000);
        return r.ok ? Probe.Of("online", null, r.ms) : Probe.Of("offline", r.error);
      }
      if (p.IsEasyTier)
      {
        var problem = EasyTierConfig.Problem(p);
        if (problem != null) return Probe.Of("offline", problem);
        if (EasyTierCore.Executable == null) return Probe.Of("offline", "这个 App 没有内置 EasyTier Core");
        return Probe.Of("unknown", "由 App 内置的 EasyTier 负责连接");
      }
      var target = (p.target ?? "").Trim();
      if (target.Length == 0) return Probe.Of("offline", "没填 SSH 目标");
      var d = await Task.Run(() => Destination(target, p.sshPort));
      if (d.jump || p.extraArgs.Contains("-J") || p.extraArgs.Contains("ProxyJump") || p.extraArgs.Contains("ProxyCommand"))
        return Probe.Of("unknown", "经跳板机连接");
      return await Tcp(d.host, d.port);
    }

    /// where ssh would really go: ~/.ssh/config may rename the host, change the port or jump
    public static (string host, int port, bool jump) Destination(string target, int port)
    {
      var host = target.Contains("@") ? target.Substring(target.LastIndexOf('@') + 1) : target;
      var prt = port;
      var jump = false;
      var text = Ssh.Run(Ssh.Executable, new[] { "-G", "-p", port.ToString(), target }, 4000);
      if (text != null)
      {
        foreach (var line in text.Split('\n'))
        {
          var kv = line.Trim().Split(new[] { ' ' }, 2);
          if (kv.Length != 2) continue;
          switch (kv[0])
          {
            case "hostname": host = kv[1]; break;
            case "port": int.TryParse(kv[1], out prt); break;
            case "proxyjump": case "proxycommand": if (kv[1] != "none") jump = true; break;
          }
        }
      }
      return (host, prt, jump);
    }

    static async Task<Probe> Tcp(string host, int port)
    {
      var sw = Stopwatch.StartNew();
      using (var c = new TcpClient())
      {
        try
        {
          var t = c.ConnectAsync(host, port);
          if (await Task.WhenAny(t, Task.Delay(4000)) != t) return Probe.Of("offline", "连接超时");
          await t;
          return Probe.Of("online", null, Math.Max(1, (int)sw.ElapsedMilliseconds));
        }
        catch (Exception e) { return Probe.Of("offline", Http.Reason(e)); }
      }
    }
  }
}
