using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TmuxWeb
{
  public enum TunnelKind { Idle, Connecting, Ready, Reconnecting, Failed }

  public struct TunnelState
  {
    public TunnelKind Kind;
    /// Ready: the page's address; Reconnecting / Failed: what to say
    public string Text;
    public static TunnelState Of(TunnelKind k, string t = null) => new TunnelState { Kind = k, Text = t };
    public override string ToString() => Kind + (Text == null ? "" : "(" + Text + ")");
  }

  /// A connection to tmux-web: an SSH port forward, a direct address, or the bundled EasyTier Core
  /// forwarding one local port through its virtual network without a TUN device.
  public class Tunnel
  {
    readonly Control ui;
    public Action<TunnelState> OnState;
    TunnelState state = TunnelState.Of(TunnelKind.Idle);
    public TunnelState State
    {
      get => state;
      private set
      {
        state = value;
        var s = value;
        Post(() => OnState?.Invoke(s));
      }
    }

    Process proc;
    string easyConfig;
    string keyCopy;
    readonly StringBuilder errText = new StringBuilder();
    Profile profile;
    bool wanted, everReady;
    int retry;
    Timer poll;
    int ticks;
    bool checking;
    /// tells this connection's callbacks from an earlier one's
    int generation;

    public Tunnel(Control ui) { this.ui = ui; }

    void Post(Action a)
    {
      if (ui.IsDisposed) return;
      if (ui.InvokeRequired) ui.BeginInvoke(a); else a();
    }

    public void Start(Profile p)
    {
      Stop();
      profile = p.Clone();
      wanted = true;
      everReady = false;
      retry = 0;
      if (p.IsDirect) Direct(p);
      else if (p.IsEasyTier) EasyTier();
      else Launch();
    }

    public void Stop()
    {
      wanted = false;
      generation++;
      poll?.Stop();
      poll?.Dispose();
      poll = null;
      checking = false;
      DropKeyCopy();
      var p = proc;
      proc = null;
      if (p != null) KillTree(p);
      EasyTierFiles.Remove(easyConfig);
      easyConfig = null;
      if (state.Kind != TunnelKind.Idle) State = TunnelState.Of(TunnelKind.Idle);
    }

    // ---------- direct: the address is reachable as it is; one look whether it answers

    void Direct(Profile p)
    {
      var b = p.DirectBase;
      if (b == null) { State = TunnelState.Of(TunnelKind.Failed, "地址不对：" + p.directURL); return; }
      State = TunnelState.Of(TunnelKind.Connecting);
      var gen = generation;
      Task.Run(async () =>
      {
        var r = await Http.Answers(b + "/_tw/api/me", 10000);
        Post(() =>
        {
          if (!wanted || gen != generation) return;
          // any answer from tmux-web (401 = not logged in yet) means it's there
          State = r.ok ? TunnelState.Of(TunnelKind.Ready, b) : TunnelState.Of(TunnelKind.Failed, "打不开 " + b + "：" + r.error);
        });
      });
    }

    // ---------- EasyTier

    void EasyTier()
    {
      if (!wanted) return;
      var p = profile;
      string config;
      try { config = EasyTierConfig.Make(p); }
      catch (Exception e) { State = TunnelState.Of(TunnelKind.Failed, e.Message); return; }
      var core = EasyTierCore.Executable;
      if (core == null) { State = TunnelState.Of(TunnelKind.Failed, "这个 App 没有找到内置的 EasyTier Core（EasyTier\\easytier-core.exe）。请重新下载 App。"); return; }
      var configPath = EasyTierFiles.PathFor(p.id);
      KillStale(c => c.IndexOf(configPath, StringComparison.OrdinalIgnoreCase) >= 0);
      if (Net.PortOpen(p.localPort)) { State = TunnelState.Of(TunnelKind.Failed, "本地端口 " + p.localPort + " 已被占用。换一个本地端口，或关掉占用它的程序。"); return; }
      try { easyConfig = EasyTierFiles.Write(config, p.id); }
      catch (Exception e) { State = TunnelState.Of(TunnelKind.Failed, "无法保存 EasyTier 临时配置：" + e.Message); return; }

      State = everReady ? TunnelState.Of(TunnelKind.Reconnecting, "EasyTier 正在重新连接…") : TunnelState.Of(TunnelKind.Connecting);
      lock (errText) errText.Clear();
      ticks = 0;
      var psi = new ProcessStartInfo(core, Args.Join(new[] { "-c", configPath, "--console-log-level", "warn", "--file-log-level", "off" }))
      {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardError = true,
        RedirectStandardOutput = true,
        RedirectStandardInput = true,
        WorkingDirectory = Path.GetDirectoryName(core),
        StandardOutputEncoding = Encoding.UTF8,
        StandardErrorEncoding = Encoding.UTF8,
      };
      if (!Run(psi, out var why)) { EasyTierFiles.Remove(easyConfig); easyConfig = null; State = TunnelState.Of(TunnelKind.Failed, "无法启动 EasyTier Core：" + why); return; }
      var task = proc;
      var gen = generation;
      // A listening port can appear before the virtual network is reachable. An HTTP answer from
      // tmux-web (401 included) is the first moment the page can really load.
      StartPoll(500, () =>
      {
        if (proc != task || task.HasExited) { poll?.Stop(); return; }
        ticks++;
        CheckEasyTierWeb(p.localPort, task, gen);
        if (ticks >= 120) { poll?.Stop(); EasyTierTimeout(task); }
      });
    }

    void CheckEasyTierWeb(int port, Process task, int gen)
    {
      if (checking) return;
      checking = true;
      Task.Run(async () =>
      {
        var r = await Http.Answers("http://127.0.0.1:" + port + "/_tw/api/me", 2000);
        Post(() =>
        {
          checking = false;
          if (!wanted || gen != generation || proc != task) return;
          if (r.ok)
          {
            poll?.Stop();
            everReady = true;
            retry = 0;
            State = TunnelState.Of(TunnelKind.Ready, "http://127.0.0.1:" + port);
          }
        });
      });
    }

    void EasyTierTimeout(Process task)
    {
      if (!wanted || proc != task) return;
      var why = Message();
      proc = null;
      KillTree(task);
      EasyTierFiles.Remove(easyConfig);
      easyConfig = null;
      if (everReady) Again("EasyTier 连接超时", EasyTier);
      else State = TunnelState.Of(TunnelKind.Failed, why.Length == 0 ? "EasyTier 在 60 秒内没有连上 tmux-web。检查网络名称、密钥、公共节点和服务器虚拟 IP。" : why);
    }

    // ---------- SSH

    void Launch()
    {
      if (!wanted) return;
      var p = profile;
      // a forward of ours left behind holds the port: end it
      KillStale(c => c.Contains("ExitOnForwardFailure=yes") && c.Contains("-L 127.0.0.1:" + p.localPort + ":"));
      if (Net.PortOpen(p.localPort))
      {
        State = TunnelState.Of(TunnelKind.Failed, "本地端口 " + p.localPort + " 已被占用。换一个本地端口，或关掉占用它的程序。");
        return;
      }
      var ssh = Ssh.Executable;
      if (ssh == null) { State = TunnelState.Of(TunnelKind.Failed, "没有找到 ssh.exe。在「设置 → 应用 → 可选功能」里添加「OpenSSH 客户端」后重试。"); return; }
      State = everReady ? TunnelState.Of(TunnelKind.Reconnecting, "正在重新连接…") : TunnelState.Of(TunnelKind.Connecting);
      lock (errText) errText.Clear();

      var args = new List<string> {
        "-N", "-T",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=15",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", p.sshPort.ToString(),
        "-L", "127.0.0.1:" + p.localPort + ":" + (string.IsNullOrWhiteSpace(p.remoteHost) ? "127.0.0.1" : p.remoteHost.Trim()) + ":" + p.remotePort,
      };
      var key = Store.Key(p.keyID);
      if (key != null)
      {
        var problem = KeyFile.Problem(key.File);
        if (problem != null) { State = TunnelState.Of(TunnelKind.Failed, problem); return; }
        // Windows' ssh refuses keys others may read (ACLs inherited from where the file sits): it
        // gets a copy only this account can read, there while it logs in
        try { keyCopy = KeyFile.PrivateCopy(key.File, p.id); }
        catch (Exception e) { State = TunnelState.Of(TunnelKind.Failed, "私钥复制失败：" + e.Message); return; }
        args.AddRange(new[] { "-i", keyCopy, "-o", "IdentitiesOnly=yes" });
      }
      args.AddRange(Args.Split(p.extraArgs));
      args.Add(p.target.Trim());

      var psi = new ProcessStartInfo(ssh, Args.Join(args))
      {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardError = true,
        RedirectStandardOutput = true,
        RedirectStandardInput = true,
        StandardErrorEncoding = Encoding.UTF8,
        StandardOutputEncoding = Encoding.UTF8,
      };
      // passwords and verification codes: our dialog (this exe in askpass mode), never a console
      psi.EnvironmentVariables["SSH_ASKPASS"] = Application.ExecutablePath;
      psi.EnvironmentVariables["SSH_ASKPASS_REQUIRE"] = "force";
      psi.EnvironmentVariables["DISPLAY"] = "localhost:0";
      psi.EnvironmentVariables["TW_ASKPASS"] = Guid.NewGuid().ToString("N");
      psi.EnvironmentVariables["TW_ASKPASS_TITLE"] = p.Title;
      var pw = Store.Password(p.id);
      if (pw.Length > 0) psi.EnvironmentVariables["TW_SSH_PASSWORD"] = pw; else psi.EnvironmentVariables.Remove("TW_SSH_PASSWORD");
      var phrase = key != null ? Store.Passphrase(key.id) : "";
      if (phrase.Length > 0) psi.EnvironmentVariables["TW_SSH_PASSPHRASE"] = phrase; else psi.EnvironmentVariables.Remove("TW_SSH_PASSPHRASE");
      if (!Run(psi, out var why)) { DropKeyCopy(); State = TunnelState.Of(TunnelKind.Failed, "无法启动 ssh：" + why); return; }
      var task = proc;
      // the forward listens once ssh is in: then the page can load
      StartPoll(250, () =>
      {
        if (proc != task) { poll?.Stop(); return; }
        if (!task.HasExited && Net.PortOpen(p.localPort))
        {
          poll?.Stop();
          everReady = true;
          retry = 0;
          DropKeyCopy(); // logged in: ssh has read it
          State = TunnelState.Of(TunnelKind.Ready, "http://127.0.0.1:" + p.localPort);
        }
      });
    }

    // ---------- the process, its end

    bool Run(ProcessStartInfo psi, out string why)
    {
      why = null;
      var task = new Process { StartInfo = psi, EnableRaisingEvents = true };
      DataReceivedEventHandler add = (s, e) =>
      {
        if (e.Data == null) return;
        lock (errText)
        {
          errText.Append(e.Data).Append('\n');
          if (errText.Length > 32 * 1024) errText.Remove(0, errText.Length - 16 * 1024);
        }
      };
      task.OutputDataReceived += add;
      task.ErrorDataReceived += add;
      task.Exited += (s, e) => Post(() => Ended(task));
      try
      {
        task.Start();
      }
      catch (Exception e) { why = e.Message; return false; }
      // ends with us, however we go (the job closes with our process)
      Job.Add(task);
      try { task.StandardInput.Close(); } catch { }
      task.BeginOutputReadLine();
      task.BeginErrorReadLine();
      proc = task;
      return true;
    }

    void Ended(Process t)
    {
      if (t != proc) return;
      poll?.Stop();
      DropKeyCopy();
      proc = null;
      var easy = profile != null && profile.IsEasyTier;
      if (easy) { EasyTierFiles.Remove(easyConfig); easyConfig = null; }
      if (!wanted) return;
      // the last lines of stderr may still be on their way
      var code = 0;
      try { code = t.ExitCode; } catch { }
      var gen = generation;
      var delay = new Timer { Interval = 150 };
      delay.Tick += (s, e) =>
      {
        delay.Stop();
        delay.Dispose();
        if (!wanted || gen != generation) return;
        var why = Message();
        if (everReady) Again(easy ? "EasyTier 连接断开" : "连接断开", easy ? (Action)EasyTier : Launch);
        else State = TunnelState.Of(TunnelKind.Failed, why.Length == 0 ? (easy ? "EasyTier Core" : "ssh") + " 退出了（代码 " + code + "）" : why);
      };
      delay.Start();
    }

    /// it worked before: the network went away, try again (slower each time, up to 30 s)
    void Again(string what, Action how)
    {
      retry++;
      var wait = (int)Math.Min(30, Math.Pow(2, Math.Min(retry, 5)));
      State = TunnelState.Of(TunnelKind.Reconnecting, what + "，" + wait + " 秒后重连…");
      var gen = generation;
      var t = new Timer { Interval = wait * 1000 };
      t.Tick += (s, e) =>
      {
        t.Stop();
        t.Dispose();
        if (wanted && gen == generation) how();
      };
      t.Start();
    }

    void StartPoll(int ms, Action tick)
    {
      poll?.Stop();
      poll?.Dispose();
      poll = new Timer { Interval = ms };
      poll.Tick += (s, e) => { if (!wanted) { poll?.Stop(); return; } tick(); };
      poll.Start();
    }

    void DropKeyCopy()
    {
      if (keyCopy != null) try { File.Delete(keyCopy); } catch { }
      keyCopy = null;
    }

    /// The useful lines of the complaints.
    string Message()
    {
      string text;
      lock (errText) text = errText.ToString();
      var lines = text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0 && !l.StartsWith("Warning: Permanently added")).ToList();
      var tail = string.Join("\n", lines.Skip(Math.Max(0, lines.Count - 4)));
      return EasyTierConfig.Redact(tail, profile?.easyTierSecret ?? "");
    }

    /// the process and what it started (ssh's password dialog: it would stay on screen)
    static void KillTree(Process p)
    {
      int id;
      try { if (p.HasExited) return; id = p.Id; } catch { return; }
      try
      {
        using (var q = new ManagementObjectSearcher("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = " + id))
          foreach (ManagementObject o in q.Get())
            try { Process.GetProcessById(Convert.ToInt32(o["ProcessId"])).Kill(); } catch { }
      }
      catch { }
      try { p.Kill(); } catch { }
    }

    /// Our own process for this connection, orphaned by an earlier run that didn't get to clean up.
    static void KillStale(Func<string, bool> ours)
    {
      try
      {
        using (var q = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'ssh.exe' OR Name = 'easytier-core.exe'"))
        {
          var killed = false;
          foreach (ManagementObject o in q.Get())
          {
            var cmd = o["CommandLine"] as string;
            if (cmd == null || !ours(cmd)) continue;
            try { Process.GetProcessById(Convert.ToInt32(o["ProcessId"])).Kill(); killed = true; } catch { }
          }
          if (killed) System.Threading.Thread.Sleep(300);
        }
      }
      catch (Exception e) { Log.Write("stale check: " + e.Message); }
    }
  }

  public static class Ssh
  {
    public static string Executable
    {
      get
      {
        var sys = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Sysnative", "OpenSSH", "ssh.exe");
        if (File.Exists(sys)) return sys;
        sys = Path.Combine(Environment.SystemDirectory, "OpenSSH", "ssh.exe");
        if (File.Exists(sys)) return sys;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
          try { var f = Path.Combine(dir.Trim(), "ssh.exe"); if (File.Exists(f)) return f; } catch { }
        }
        return null;
      }
    }

    public static string Tool(string name)
    {
      var ssh = Executable;
      if (ssh == null) return null;
      var f = Path.Combine(Path.GetDirectoryName(ssh), name);
      return File.Exists(f) ? f : null;
    }

    /// a tool's output (ssh -G, ssh-keygen); null when it fails or takes too long
    public static string Run(string exe, IEnumerable<string> args, int timeoutMs = 5000)
    {
      if (exe == null) return null;
      try
      {
        var psi = new ProcessStartInfo(exe, Args.Join(args))
        {
          UseShellExecute = false,
          CreateNoWindow = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
          RedirectStandardInput = true,
          StandardOutputEncoding = Encoding.UTF8,
        };
        psi.EnvironmentVariables.Remove("SSH_ASKPASS");
        using (var p = Process.Start(psi))
        {
          p.StandardInput.Close();
          var err = p.StandardError.ReadToEndAsync();
          var outTask = p.StandardOutput.ReadToEndAsync();
          if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } return null; }
          return p.ExitCode == 0 ? outTask.Result.Trim() : null;
        }
      }
      catch { return null; }
    }
  }

  /// The key as ssh will take it: a private key (judged by its content, not its name).
  public static class KeyFile
  {
    public static readonly string Dir = Path.Combine(Store.Dir, "keys");

    public static string Problem(string path)
    {
      string head;
      try
      {
        using (var f = File.OpenRead(path))
        {
          var buf = new byte[200];
          var n = f.Read(buf, 0, buf.Length);
          head = Encoding.UTF8.GetString(buf, 0, n).TrimStart('\uFEFF').Trim();
        }
      }
      catch { return "读不到密钥文件：" + path; }
      if (head.StartsWith("ssh-") || head.StartsWith("ecdsa-") || head.StartsWith("sk-"))
        return "选的是公钥（" + Path.GetFileName(path) + "），登录需要对应的私钥：内容以「-----BEGIN … PRIVATE KEY-----」开头的那个文件，通常和公钥同名、没有 .pub。";
      if (head.StartsWith("PuTTY-User-Key-File")) return "这是 PuTTY 格式（.ppk）的私钥，先用 PuTTYgen 导出为 OpenSSH 格式：" + path;
      if (!head.StartsWith("-----BEGIN")) return "这个文件看起来不是 SSH 私钥：" + path;
      return null;
    }

    public static string PrivateCopy(string path, string id)
    {
      Directory.CreateDirectory(Dir);
      var copy = Path.Combine(Dir, id);
      try { File.Delete(copy); } catch { }
      Private.WriteFile(copy, Readable(File.ReadAllBytes(path)));
      return copy;
    }

    /// The key as ssh reads it. LF or CRLF are both fine, but ssh calls a key "invalid format"
    /// without the line break after its last line (keys pasted or shared from the Android app are
    /// stored trimmed) or with a UTF-8 BOM in front (some editors save one).
    public static byte[] Readable(byte[] key)
    {
      var start = key.Length >= 3 && key[0] == 0xEF && key[1] == 0xBB && key[2] == 0xBF ? 3 : 0;
      var end = key.Length;
      while (end > start && (key[end - 1] == ' ' || key[end - 1] == '\t')) end--;
      var newline = end > start && key[end - 1] != '\n';
      var r = new byte[end - start + (newline ? 1 : 0)];
      Array.Copy(key, start, r, 0, end - start);
      if (newline) r[r.Length - 1] = (byte)'\n';
      return r;
    }

    public static void RemoveStale()
    {
      try { if (Directory.Exists(Dir)) foreach (var f in Directory.GetFiles(Dir)) try { File.Delete(f); } catch { } } catch { }
    }
  }

  public static class Net
  {
    public static bool PortOpen(int port)
    {
      try
      {
        using (var c = new TcpClient())
        {
          var r = c.BeginConnect(IPAddress.Loopback, port, null, null);
          if (!r.AsyncWaitHandle.WaitOne(300)) return false;
          c.EndConnect(r);
          return true;
        }
      }
      catch { return false; }
    }
  }

  public static class Http
  {
    static Http()
    {
      ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
      ServicePointManager.DefaultConnectionLimit = 32;
    }

    public struct Answer { public bool ok; public int ms; public string error; }

    /// any HTTP answer at all (401 included)
    public static async Task<Answer> Answers(string url, int timeoutMs)
    {
      var sw = Stopwatch.StartNew();
      try
      {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs;
        req.ReadWriteTimeout = timeoutMs;
        req.Proxy = null;
        req.AllowAutoRedirect = false;
        var t = req.GetResponseAsync();
        if (await Task.WhenAny(t, Task.Delay(timeoutMs)) != t) { req.Abort(); return new Answer { error = "连接超时" }; }
        using (await t) { }
        return new Answer { ok = true, ms = Math.Max(1, (int)sw.ElapsedMilliseconds) };
      }
      catch (WebException e) when (e.Response != null)
      {
        e.Response.Dispose();
        return new Answer { ok = true, ms = Math.Max(1, (int)sw.ElapsedMilliseconds) };
      }
      catch (Exception e)
      {
        return new Answer { error = Reason(e) };
      }
    }

    public static string Reason(Exception e)
    {
      var we = e as WebException ?? e.InnerException as WebException;
      if (we != null)
      {
        switch (we.Status)
        {
          case WebExceptionStatus.Timeout: return "连接超时";
          case WebExceptionStatus.NameResolutionFailure: return "找不到主机";
          case WebExceptionStatus.ConnectFailure:
            var se = we.InnerException as SocketException;
            if (se != null && se.SocketErrorCode == SocketError.ConnectionRefused) return "拒绝连接";
            if (se != null && se.SocketErrorCode == SocketError.TimedOut) return "连接超时";
            if (se != null && (se.SocketErrorCode == SocketError.HostUnreachable || se.SocketErrorCode == SocketError.NetworkUnreachable)) return "网络不可达";
            return "连不上";
        }
      }
      var s = e as SocketException ?? e.InnerException as SocketException;
      if (s != null)
      {
        switch (s.SocketErrorCode)
        {
          case SocketError.ConnectionRefused: return "拒绝连接";
          case SocketError.TimedOut: return "连接超时";
          case SocketError.HostNotFound: case SocketError.NoData: return "找不到主机";
          case SocketError.HostUnreachable: case SocketError.NetworkUnreachable: return "网络不可达";
        }
      }
      return "连不上";
    }
  }

  /// Command lines: split a user's extra options, join for CreateProcess (Windows quoting rules).
  public static class Args
  {
    public static IEnumerable<string> Split(string s)
    {
      var list = new List<string>();
      if (string.IsNullOrWhiteSpace(s)) return list;
      var cur = new StringBuilder();
      bool quoted = false, any = false;
      foreach (var c in s)
      {
        if (c == '"') { quoted = !quoted; any = true; continue; }
        if (!quoted && char.IsWhiteSpace(c))
        {
          if (any || cur.Length > 0) list.Add(cur.ToString());
          cur.Clear();
          any = false;
          continue;
        }
        cur.Append(c);
      }
      if (any || cur.Length > 0) list.Add(cur.ToString());
      return list;
    }

    public static string Quote(string a)
    {
      if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
      var sb = new StringBuilder("\"");
      var slashes = 0;
      foreach (var c in a)
      {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
        else { sb.Append('\\', slashes); sb.Append(c); }
        slashes = 0;
      }
      sb.Append('\\', slashes * 2);
      return sb.Append('"').ToString();
    }

    public static string Join(IEnumerable<string> args) => string.Join(" ", args.Select(Quote));
  }

  /// Every process we start ends with us: a job object that kills its members when its last
  /// handle (ours) closes, crash or not.
  public static class Job
  {
    static IntPtr handle;

    [StructLayout(LayoutKind.Sequential)]
    struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED info, int len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

    public static void Add(Process p)
    {
      try
      {
        if (handle == IntPtr.Zero)
        {
          handle = CreateJobObject(IntPtr.Zero, null);
          var info = new EXTENDED();
          info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
          SetInformationJobObject(handle, 9, ref info, Marshal.SizeOf(typeof(EXTENDED)));
        }
        AssignProcessToJobObject(handle, p.Handle);
      }
      catch (Exception e) { Log.Write("job: " + e.Message); }
    }
  }
}
