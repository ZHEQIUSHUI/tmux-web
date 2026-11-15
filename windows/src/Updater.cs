using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TmuxWeb
{
  /// Updates: version.json of the latest release, through a connected tmux-web server (GitHub may be
  /// slow or unreachable) or else GitHub and its download proxies; the zip is checked against
  /// version.json's SHA-256, unpacked over this folder by a small script once we've quit, and started.
  static class Updater
  {
    const string Github = "https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/";
    static readonly string[] Proxies = { "https://ghfast.top/", "https://gh-proxy.com/", "https://gh.llkk.cc/", "https://ghproxy.net/", "" };
    static readonly string Dir = Path.Combine(Store.Dir, "update");
    const long Every = 6 * 3600 * 1000L;

    public static string Current
    {
      get
      {
        var a = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        return a?.InformationalVersion ?? "0";
      }
    }

    class Offer { public string server, version, notes, file, sha256; public long size; }
    static Offer offer;
    static bool busy;
    static System.Windows.Forms.Timer timer;

    static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static void Schedule(MainForm form)
    {
      timer = new System.Windows.Forms.Timer { Interval = 30 * 60 * 1000 };
      timer.Tick += (s, e) => Check(form, null, false);
      timer.Start();
      // a little after starting, when nothing is connected yet: GitHub and the mirrors
      var first = new System.Windows.Forms.Timer { Interval = 20000 };
      first.Tick += (s, e) => { first.Stop(); first.Dispose(); Check(form, null, false); };
      first.Start();
    }

    /// a server just came up: it's the best way to the release
    public static void CheckSoon(MainForm form, string server) => Check(form, server, false);

    static void Say(MainForm form, string state, string text = null)
    {
      form.Send(new { type = "update", state, text, version = offer?.version, notes = offer?.notes, current = Current });
    }

    /// Look for a new version (at most every 6 hours unless asked); not asked: say nothing if none.
    public static async void Check(MainForm form, string server, bool asked)
    {
      if (busy) { if (asked && offer != null) Say(form, "offer"); return; }
      if (!asked && long.TryParse(Store.Setting("updateChecked"), out var last) && Now - last < Every) return;
      if (asked) Say(form, "checking");
      busy = true;
      try
      {
        Dictionary<string, object> info = null;
        string from = null;
        if (server != null) { info = await Json(server + "/_tw/api/app/version.json", 15000); if (info != null) from = server; }
        if (info == null)
          info = await Race(Proxies.Select(p => (Func<Task<Dictionary<string, object>>>)(() => Json(p + Github + "version.json", 20000)))
            .Concat(GhcrHosts.Select(h => (Func<Task<Dictionary<string, object>>>)(() => GhcrVersion(h)))));
        if (info == null)
        {
          if (asked) Say(form, "failed", "服务器、GitHub 和镜像都没取到版本信息，稍后再试。");
          return;
        }
        Store.SetSetting("updateChecked", Now.ToString());
        var version = info.TryGetValue("version", out var v) ? v as string : null;
        var win = info.TryGetValue("windows", out var w) ? w as Dictionary<string, object> : null;
        if (version == null || win == null || !Newer(version, Current))
        {
          if (asked) Say(form, "latest");
          return;
        }
        if (!asked && Store.Setting("updateSkipped") == version) return;
        offer = new Offer
        {
          server = from,
          version = version,
          notes = info.TryGetValue("notes", out var n) ? n as string : "",
          file = win.TryGetValue("file", out var f) ? f as string : "tmux-web-windows.zip",
          sha256 = (win.TryGetValue("sha256", out var sh) ? sh as string : "")?.ToLowerInvariant(),
          size = win.TryGetValue("size", out var sz) ? Convert.ToInt64(sz) : 0,
        };
        form.UpdateOffer = version;
        Say(form, "offer");
      }
      finally { busy = false; }
    }

    public static void Skip(MainForm form)
    {
      if (offer != null) Store.SetSetting("updateSkipped", offer.version);
      offer = null;
      form.UpdateOffer = null;
      Say(form, "none");
    }

    /// download, check, unpack; then a script waits for us to quit, copies it over this folder and starts it
    public static async void Install(MainForm form)
    {
      var o = offer;
      if (o == null || busy) return;
      var appDir = AppContext.BaseDirectory.TrimEnd('\\');
      if (!Writable(appDir))
      {
        Say(form, "failed", "没有权限写入 App 所在的文件夹（" + appDir + "）。把 tmux-web 文件夹放到自己的目录里（比如「文档」），或从 GitHub 下载新版本手动替换。");
        return;
      }
      busy = true;
      try
      {
        Say(form, "downloading", "0");
        var urls = new List<string>();
        if (o.server != null) urls.Add(o.server + "/_tw/api/app/download/" + Uri.EscapeDataString(o.file));
        // GitHub's proxies, GitHub, and the release in GHCR (Nanjing University's mirror first)
        urls.Add(Proxies[0] + Github + o.file);
        if (!string.IsNullOrEmpty(o.sha256)) urls.AddRange(GhcrHosts.Select(h => "ghcr:" + h));
        urls.AddRange(Proxies.Skip(1).Select(p => p + Github + o.file));
        byte[] data = null;
        foreach (var u in urls)
        {
          string token = null, url = u;
          if (u.StartsWith("ghcr:"))
          {
            token = await GhcrToken();
            if (token == null) continue;
            url = "https://" + u.Substring(5) + "/v2/" + Image + "/blobs/sha256:" + o.sha256;
          }
          data = await Download(url, o.size, pct => Say(form, "downloading", pct.ToString()), token);
          if (data == null) continue;
          var sha = Hex(SHA256.Create().ComputeHash(data));
          if (string.IsNullOrEmpty(o.sha256) || sha == o.sha256) break;
          Log.Write("update: sha mismatch from " + u);
          data = null;
        }
        if (data == null) { Say(form, "failed", "下载失败（服务器、GitHub 和镜像都没下载下来，或文件校验不对），稍后再试。"); return; }
        Say(form, "installing");
        try { if (Directory.Exists(Dir)) Directory.Delete(Dir, true); } catch { }
        Directory.CreateDirectory(Dir);
        var zip = Path.Combine(Dir, "update.zip");
        File.WriteAllBytes(zip, data);
        var unpacked = Path.Combine(Dir, "new");
        ZipFile.ExtractToDirectory(zip, unpacked);
        // the zip holds a tmux-web folder
        var root = File.Exists(Path.Combine(unpacked, "tmux-web.exe")) ? unpacked : Directory.GetDirectories(unpacked).FirstOrDefault(d => File.Exists(Path.Combine(d, "tmux-web.exe")));
        if (root == null) { Say(form, "failed", "更新包里没有 tmux-web.exe"); return; }
        var exe = Path.Combine(appDir, "tmux-web.exe");
        var script = Path.Combine(Dir, "update.cmd");
        File.WriteAllText(script, string.Join("\r\n", new[] {
          "@echo off",
          "chcp 65001 >nul",
          // wait for this app to be gone (it holds its exe)
          ":wait",
          $"tasklist /FI \"PID eq {Process.GetCurrentProcess().Id}\" 2>nul | find \"{Process.GetCurrentProcess().Id}\" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)",
          $"robocopy \"{root}\" \"{appDir}\" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul",
          $"start \"\" \"{exe}\" --updated",
          "",
        }), new UTF8Encoding(false));
        Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + script + "\"") { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = Dir });
        form.Quit();
      }
      catch (Exception e)
      {
        Log.Write("update: " + e);
        Say(form, "failed", "更新失败：" + e.Message);
      }
      finally { busy = false; }
    }

    /// after an update: the downloaded files go
    public static void Cleanup()
    {
      var t = new Thread(() =>
      {
        // the script that started us may still be sitting in that folder for a moment
        for (var i = 0; i < 10 && Directory.Exists(Dir); i++)
        {
          Thread.Sleep(3000);
          try { Directory.Delete(Dir, true); } catch { }
        }
      }) { IsBackground = true };
      t.Start();
    }

    static bool Writable(string dir)
    {
      try
      {
        var f = Path.Combine(dir, ".tw-write-test");
        File.WriteAllText(f, "");
        File.Delete(f);
        return true;
      }
      catch { return false; }
    }

    /// "2026.10.9.12" > "2026.10.9.9"
    public static bool Newer(string a, string b)
    {
      var x = a.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();
      var y = b.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();
      for (var i = 0; i < Math.Max(x.Length, y.Length); i++)
      {
        var p = i < x.Length ? x[i] : 0;
        var q = i < y.Length ? y[i] : 0;
        if (p != q) return p > q;
      }
      return false;
    }

    static string Hex(byte[] b) => string.Concat(b.Select(x => x.ToString("x2")));

    static async Task<Dictionary<string, object>> Json(string url, int timeoutMs, string bearer = null, string accept = null, bool needVersion = true)
    {
      try
      {
        using (var c = new TimedClient(timeoutMs))
        {
          if (bearer != null) c.Headers[HttpRequestHeader.Authorization] = "Bearer " + bearer;
          if (accept != null) c.Headers[HttpRequestHeader.Accept] = accept;
          var t = c.DownloadDataTaskAsync(url);
          if (await Task.WhenAny(t, Task.Delay(timeoutMs)) != t) { c.CancelAsync(); return null; }
          var d = Store.Json.DeserializeObject(Encoding.UTF8.GetString(await t).TrimStart('\uFEFF')) as Dictionary<string, object>;
          return d != null && (!needVersion || d.ContainsKey("version")) ? d : null;
        }
      }
      catch { return null; }
    }

    /// the release as an OCI artifact (CI pushes it): version.json in the manifest, the files as blobs
    const string Image = "zheqiushui/tmux-web-app";
    static readonly string[] GhcrHosts = { "ghcr.nju.edu.cn", "ghcr.io" };

    static async Task<string> GhcrToken()
    {
      var d = await Json("https://ghcr.io/token?service=ghcr.io&scope=repository:" + Image + ":pull", 10000, null, null, false);
      return d != null && d.TryGetValue("token", out var t) ? t as string : null;
    }

    static async Task<Dictionary<string, object>> GhcrVersion(string host)
    {
      var token = await GhcrToken();
      if (token == null) return null;
      var m = await Json("https://" + host + "/v2/" + Image + "/manifests/latest", 15000, token, "application/vnd.oci.image.manifest.v1+json", false);
      var ann = m != null && m.TryGetValue("annotations", out var a) ? a as Dictionary<string, object> : null;
      var v = ann != null && ann.TryGetValue("tw.version", out var x) ? x as string : null;
      if (v == null) return null;
      try { var d = Store.Json.DeserializeObject(v) as Dictionary<string, object>; return d != null && d.ContainsKey("version") ? d : null; } catch { return null; }
    }

    /// version.json from everywhere at once: the first good answer
    static async Task<Dictionary<string, object>> Race(IEnumerable<Func<Task<Dictionary<string, object>>>> sources)
    {
      var tasks = sources.Select(f => f()).ToList();
      while (tasks.Count > 0)
      {
        var done = await Task.WhenAny(tasks);
        tasks.Remove(done);
        if (done.Result != null) return done.Result;
      }
      return null;
    }

    static async Task<byte[]> Download(string url, long size, Action<int> progress, string bearer = null)
    {
      try
      {
        using (var c = new TimedClient(30000))
        {
          if (bearer != null) c.Headers[HttpRequestHeader.Authorization] = "Bearer " + bearer;
          var last = -1;
          c.DownloadProgressChanged += (s, e) =>
          {
            var total = e.TotalBytesToReceive > 0 ? e.TotalBytesToReceive : size;
            if (total <= 0) return;
            var pct = (int)(e.BytesReceived * 100 / total);
            if (pct != last) { last = pct; progress(pct); }
          };
          return await c.DownloadDataTaskAsync(url);
        }
      }
      catch (Exception e) { Log.Write("update download " + url + ": " + e.Message); return null; }
    }

    class TimedClient : WebClient
    {
      readonly int timeout;
      public TimedClient(int t) { timeout = t; Headers[HttpRequestHeader.UserAgent] = "tmux-web-windows"; }
      protected override WebRequest GetWebRequest(Uri address)
      {
        var r = base.GetWebRequest(address);
        r.Timeout = timeout;
        if (r is HttpWebRequest h) h.ReadWriteTimeout = timeout;
        return r;
      }
    }
  }
}
