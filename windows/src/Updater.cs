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
      form.Send(new
      {
        type = "update", state, text, version = offer?.version, notes = offer?.notes, current = Current,
        channels = Channels(offer).Select(c => new { id = c.id, label = c.label }).ToArray(),
        channel = Channel,
      });
    }

    /// where the update is downloaded from: "auto" (all of them measured, the quickest one), or one
    /// of Channels (the others after it if it fails)
    public static string Channel => Store.Setting("updateChannel") ?? "auto";

    /// A place the file can be had: (url, bearer token or null), or null when it can't serve it.
    class Source { public string id, label; public Func<Offer, Task<Tuple<string, string>>> req; }

    static Source Web(string id, string label, string prefix) =>
      new Source { id = id, label = label, req = o => Task.FromResult(Tuple.Create(prefix + Github + o.file, (string)null)) };

    static Source Ghcr(string id, string label, string host) => new Source
    {
      id = id,
      label = label,
      req = async o =>
      {
        if (string.IsNullOrEmpty(o.sha256)) return null;
        var t = await GhcrToken();
        return t == null ? null : Tuple.Create("https://" + host + "/v2/" + Image + "/blobs/sha256:" + o.sha256, t);
      },
    };

    /// in the order they're tried when none was picked (or the picked one fails)
    static List<Source> Channels(Offer o)
    {
      var list = new List<Source>();
      if (o?.server != null)
        list.Add(new Source { id = "server", label = "已连接的服务器", req = x => Task.FromResult(Tuple.Create(x.server + "/_tw/api/app/download/" + Uri.EscapeDataString(x.file), (string)null)) });
      list.Add(Ghcr("nju", "南京大学镜像（ghcr.nju.edu.cn）", "ghcr.nju.edu.cn"));
      list.Add(Web("ghfast", "ghfast.top", Proxies[0]));
      list.Add(Web("ghproxy", "gh-proxy.com", Proxies[1]));
      list.Add(Web("llkk", "gh.llkk.cc", Proxies[2]));
      list.Add(Web("ghproxynet", "ghproxy.net", Proxies[3]));
      list.Add(Web("github", "GitHub 直连", ""));
      list.Add(Ghcr("ghcr", "ghcr.io", "ghcr.io"));
      return list;
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

    /// the download going on: 换一个渠道 stops it and the next channel goes on
    static CancellationTokenSource current;

    public static void SwitchChannel() => current?.Cancel();

    /// download, check, unpack; then a script waits for us to quit, copies it over this folder and starts it
    public static async void Install(MainForm form, string channel)
    {
      var o = offer;
      if (o == null || busy) return;
      var appDir = AppContext.BaseDirectory.TrimEnd('\\');
      if (!Writable(appDir))
      {
        Say(form, "failed", "没有权限写入 App 所在的文件夹（" + appDir + "）。把 tmux-web 文件夹放到自己的目录里（比如「文档」），或从 GitHub 下载新版本手动替换。");
        return;
      }
      if (channel != null) Store.SetSetting("updateChannel", channel);
      busy = true;
      try
      {
        Progress(form, o, "", 0, -1, 0);
        var all = Channels(o);
        var picked = all.FirstOrDefault(c => c.id == Channel);
        var order = new List<Source>();
        if (picked != null) order.Add(picked);
        else
        {
          // 自动: a moment of every one at once; the quickest first, then the rest by how they did
          Progress(form, o, "正在测速", 0, -1, 0);
          var got = await Measure(o, all);
          order.AddRange(all.Select((c, i) => new { c, n = got[i] }).Where(x => x.n > 0).OrderByDescending(x => x.n).Select(x => x.c));
        }
        order.AddRange(all.Where(c => !order.Contains(c)));
        byte[] data = null;
        foreach (var src in order)
        {
          var r = await src.req(o);
          if (r == null) continue;
          Progress(form, o, src.label, 0, -1, 0);
          using (current = new CancellationTokenSource())
            data = await Fetch(r.Item1, r.Item2, long.MaxValue, current.Token, (done, total, speed) => Progress(form, o, src.label, done, total > 0 ? total : o.size, speed));
          current = null;
          if (data == null) continue;
          var sha = Hex(SHA256.Create().ComputeHash(data));
          if (string.IsNullOrEmpty(o.sha256) || sha == o.sha256) break;
          Log.Write("update: sha mismatch from " + r.Item1);
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

    static void Progress(MainForm form, Offer o, string from, long done, long total, long speed)
    {
      var pct = total > 0 ? (int)Math.Min(100, done * 100 / total) : 0;
      form.Send(new { type = "update", state = "downloading", text = pct.ToString(), version = o.version, current = Current, from, done, total, speed });
    }

    /// how much of the file each channel gives in a few seconds (all at once; one that has half a
    /// megabyte already ends it)
    static async Task<long[]> Measure(Offer o, List<Source> all)
    {
      const long Enough = 512 * 1024;
      var got = new long[all.Count];
      using (var stop = new CancellationTokenSource())
      {
        var runs = all.Select(async (c, i) =>
        {
          try
          {
            var r = await c.req(o);
            if (r == null) return;
            await Fetch(r.Item1, r.Item2, Enough, stop.Token, (done, total, speed) =>
            {
              got[i] = done;
              if (done >= Enough || (total > 0 && done >= total)) stop.Cancel();
            });
          }
          catch { }
        }).ToList();
        await Task.WhenAny(Task.WhenAll(runs), Task.Delay(6000));
        stop.Cancel();
      }
      return got;
    }

    /// a file, or its first `max` bytes; null when it fails or is stopped. `progress`(bytes so far,
    /// total or -1, bytes a second), a few times a second
    static async Task<byte[]> Fetch(string url, string bearer, long max, CancellationToken stop, Action<long, long, long> progress)
    {
      HttpWebRequest req = null;
      try
      {
        req = (HttpWebRequest)WebRequest.Create(url);
        req.UserAgent = "tmux-web-windows";
        req.Timeout = 30000;
        req.ReadWriteTimeout = 60000;
        if (bearer != null) req.Headers[HttpRequestHeader.Authorization] = "Bearer " + bearer;
        using (stop.Register(() => { try { req.Abort(); } catch { } }))
        {
          var rt = req.GetResponseAsync();
          // async requests don't keep to Timeout
          if (await Task.WhenAny(rt, Task.Delay(30000, stop)) != rt) { req.Abort(); return null; }
          using (var res = (HttpWebResponse)await rt)
          using (var s = res.GetResponseStream())
          {
            if (res.StatusCode != HttpStatusCode.OK) return null;
            var total = res.ContentLength;
            var ms = new MemoryStream(total > 0 && total < 1 << 30 ? (int)Math.Min(total, max) : 0);
            var buf = new byte[65536];
            var watch = Stopwatch.StartNew();
            long lastAt = 0, lastDone = 0, speed = 0;
            progress(0, total, 0);
            while (ms.Length < max)
            {
              var read = s.ReadAsync(buf, 0, buf.Length, stop);
              // a stalled connection: give up after a minute without a byte
              if (await Task.WhenAny(read, Task.Delay(60000, stop)) != read) return null;
              var n = await read;
              if (n <= 0) break;
              ms.Write(buf, 0, n);
              var now = watch.ElapsedMilliseconds;
              if (now - lastAt >= 250)
              {
                var sp = (ms.Length - lastDone) * 1000 / Math.Max(1, now - lastAt);
                speed = speed == 0 ? sp : (speed * 2 + sp) / 3;
                lastAt = now;
                lastDone = ms.Length;
                progress(ms.Length, total, speed);
              }
            }
            if (stop.IsCancellationRequested) return null;
            progress(ms.Length, total, speed);
            if (max == long.MaxValue && total > 0 && ms.Length != total) return null;
            return ms.ToArray();
          }
        }
      }
      catch (Exception e)
      {
        if (!stop.IsCancellationRequested) Log.Write("update download " + url + ": " + e.Message);
        return null;
      }
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
