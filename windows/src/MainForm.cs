using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Media;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace TmuxWeb
{
  /// One server in use: its connection and its own page. Several stay up at once; switching between
  /// them only changes which page shows.
  class Conn
  {
    public Profile profile;
    public Tunnel tunnel;
    public WebView2 web;
    public TunnelState state;
    /// the address the page was loaded from
    public string loadedBase;
    /// the page has come up (until then the connecting screen stays)
    public bool pageLoaded;
    public long started;
    /// a notification's session, opened once the page is up
    public int? pendingSession;
    public bool webReady;

    public bool Live => (state.Kind == TunnelKind.Ready || state.Kind == TunnelKind.Reconnecting) && pageLoaded;
  }

  /// The main window: the home screen, toolbar, dialogs (an app page of our own, "shell"), and the
  /// pages of the servers in use under it (one shows).
  public class MainForm : Form
  {
    const string ShellHost = "app.tmux-web";
    /// CSS px of the toolbar strip at the top of the shell
    const int BarCss = 44;

    CoreWebView2Environment env;
    readonly WebView2 shell = new WebView2();
    bool shellReady;
    readonly Panel pages = new Panel { Dock = DockStyle.None };
    readonly Dictionary<string, Conn> conns = new Dictionary<string, Conn>();
    readonly List<string> order = new List<string>();
    readonly Dictionary<string, Probe> probes = new Dictionary<string, Probe>();
    string activeID;
    bool showHome = true;
    /// a dialog of the shell is open: it gets the whole window
    bool overlay;
    readonly NotifyIcon tray = new NotifyIcon();
    bool quitting;
    bool hintedTray;
    System.Windows.Forms.Timer probeTimer;
    /// what a click on the balloon opens
    (string server, int? session) balloonTarget;
    EventWaitHandle showSignal;
    public string UpdateOffer;

    public MainForm()
    {
      Text = "tmux-web";
      Icon = Program.AppIcon;
      StartPosition = FormStartPosition.Manual;
      BackColor = Dark() ? Color.FromArgb(30, 30, 30) : Color.FromArgb(246, 246, 246);
      LoadBounds();
      Controls.Add(pages);
      shell.DefaultBackgroundColor = BackColor;
      Controls.Add(shell);
      shell.BringToFront();
      Resize += (s, e) => Layout2();
      FormClosing += OnClosing;
      Load += async (s, e) => await Init();
      SystemEvents.UserPreferenceChanged += (s, e) => { if (IsHandleCreated) BeginInvoke((Action)ApplyTheme); };
      HandleCreated += (s, e) => ApplyTheme();

      tray.Icon = Icon;
      tray.Text = "tmux-web";
      tray.Visible = true;
      tray.DoubleClick += (s, e) => BringBack();
      tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) BringBack(); };
      tray.BalloonTipClicked += (s, e) => OpenTarget(balloonTarget.server, balloonTarget.session);
      tray.ContextMenuStrip = new ContextMenuStrip();
      tray.ContextMenuStrip.Opening += (s, e) => FillTrayMenu(tray.ContextMenuStrip);

      // a second start of the app: our window comes back
      showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEvent);
      var t = new Thread(() =>
      {
        while (true)
        {
          showSignal.WaitOne();
          try { BeginInvoke((Action)BringBack); } catch { return; }
        }
      }) { IsBackground = true };
      t.Start();
    }

    // ---------- startup

    async Task Init()
    {
      var data = Path.Combine(Store.Dir, "WebView2");
      try
      {
        var opts = new CoreWebView2EnvironmentOptions { Language = "zh-CN" };
        env = await CoreWebView2Environment.CreateAsync(null, data, opts);
      }
      catch (Exception e)
      {
        Log.Write("webview2: " + e);
        var r = MessageBox.Show(this, "这台电脑没有可用的 WebView2 运行时（Windows 10/11 一般自带）。\n\n点「确定」打开微软的下载页面，安装后再启动 tmux-web。\n\n" + e.Message, "tmux-web", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
        if (r == DialogResult.OK) Browser("https://developer.microsoft.com/microsoft-edge/webview2/");
        quitting = true;
        Close();
        return;
      }
      await shell.EnsureCoreWebView2Async(env);
      var core = shell.CoreWebView2;
      var ui = Path.Combine(AppContext.BaseDirectory, "ui");
      core.SetVirtualHostNameToFolderMapping(ShellHost, ui, CoreWebView2HostResourceAccessKind.Allow);
      core.Settings.AreDefaultContextMenusEnabled = false;
      core.Settings.IsStatusBarEnabled = false;
      core.Settings.IsZoomControlEnabled = false;
      core.Settings.AreBrowserAcceleratorKeysEnabled = false;
      core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("TW_DEVTOOLS") == "1";
      core.WebMessageReceived += (s, e) => OnShellMessage(e.WebMessageAsJson);
      core.NewWindowRequested += (s, e) => { e.Handled = true; Browser(e.Uri); };
      core.NavigationStarting += (s, e) =>
      {
        if (!e.Uri.StartsWith("https://" + ShellHost + "/")) { e.Cancel = true; Browser(e.Uri); }
      };
      shell.CoreWebView2.Navigate("https://" + ShellHost + "/index.html");
      StartProbing();
      Updater.Schedule(this);
    }

    // ---------- the window

    static bool Dark()
    {
      try
      {
        using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
          return k != null && (k.GetValue("AppsUseLightTheme") as int?) == 0;
      }
      catch { return false; }
    }

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);

    void ApplyTheme()
    {
      var dark = Dark() ? 1 : 0;
      try { if (DwmSetWindowAttribute(Handle, 20, ref dark, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref dark, 4); } catch { }
      BackColor = dark == 1 ? Color.FromArgb(30, 30, 30) : Color.FromArgb(246, 246, 246);
    }

    void LoadBounds()
    {
      var s = Store.Setting("window");
      var area = Screen.PrimaryScreen.WorkingArea;
      double sys = 1;
      try { sys = GetDpiForSystem() / 96.0; } catch { }
      int w0 = Math.Min((int)(1280 * sys), area.Width - 40), h0 = Math.Min((int)(820 * sys), area.Height - 40);
      var r = new Rectangle(area.X + (area.Width - w0) / 2, area.Y + (area.Height - h0) / 2, w0, h0);
      MinimumSize = new Size((int)(560 * sys), (int)(420 * sys));
      var max = false;
      if (s != null)
      {
        var p = s.Split(',');
        if (p.Length == 5 && int.TryParse(p[0], out var x) && int.TryParse(p[1], out var y) && int.TryParse(p[2], out var w) && int.TryParse(p[3], out var h))
        {
          var saved = new Rectangle(x, y, Math.Max(w, MinimumSize.Width), Math.Max(h, MinimumSize.Height));
          // only where a screen still is (a display that's gone)
          if (Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(saved))) r = saved;
          max = p[4] == "1";
        }
      }
      Bounds = r;
      if (max) WindowState = FormWindowState.Maximized;
    }

    void SaveBounds()
    {
      var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
      if (WindowState == FormWindowState.Minimized) return;
      Store.SetSetting("window", $"{r.X},{r.Y},{r.Width},{r.Height},{(WindowState == FormWindowState.Maximized ? 1 : 0)}");
    }

    /// the window in front, whatever happened to it (closed to the tray, minimized, behind others)
    public void BringBack()
    {
      if (!Visible) Show();
      if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
      Activate();
      TopMost = true;
      TopMost = false;
      Activate();
    }

    void OnClosing(object sender, FormClosingEventArgs e)
    {
      SaveBounds();
      // closing the window keeps the app (its connections, the notifications) running in the tray
      if (!quitting && e.CloseReason == CloseReason.UserClosing)
      {
        e.Cancel = true;
        Hide();
        if (!hintedTray && Store.Setting("trayHint") == null)
        {
          hintedTray = true;
          Store.SetSetting("trayHint", "1");
          balloonTarget = (null, null);
          tray.ShowBalloonTip(5000, "tmux-web 还在运行", "连接和通知照常；点右下角托盘里的图标回来，右键可以退出。", ToolTipIcon.Info);
        }
        return;
      }
      foreach (var c in conns.Values) c.tunnel.Stop();
      tray.Visible = false;
    }

    public void Quit()
    {
      quitting = true;
      Close();
      Application.Exit();
    }

    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();

    /// the window's own DPI (WinForms' DeviceDpi stays 96 without its app.config switch)
    double DpiScale
    {
      get
      {
        try { var d = GetDpiForWindow(Handle); if (d > 0) return d / 96.0; } catch { }
        return DeviceDpi / 96.0;
      }
    }

    int BarPx => (int)Math.Round(BarCss * DpiScale);

    /// which page shows, how much of the window the shell takes
    void Layout2()
    {
      var area = ClientRectangle;
      var active = Active;
      var live = !showHome && active != null && active.Live;
      var full = !live || overlay;
      shell.Bounds = full ? area : new Rectangle(0, 0, area.Width, Math.Min(BarPx, area.Height));
      pages.Bounds = new Rectangle(0, BarPx, area.Width, Math.Max(0, area.Height - BarPx));
      pages.Visible = live && !overlay;
      foreach (var c in conns.Values)
      {
        var show = live && c == active;
        if (c.web.Visible != show) c.web.Visible = show;
      }
      shell.BringToFront();
      if (live && !overlay && active.web.Visible && ContainsFocus && shell.Focused) active.web.Focus();
    }

    Conn Active => activeID != null && conns.TryGetValue(activeID, out var c) ? c : null;

    // ---------- servers

    /// Its page: one already in use just comes to the front; otherwise it connects (others stay up).
    async void Open(Profile p)
    {
      if (!p.IsComplete) { Send(new { type = "editor", draft = Draft(p.id, null, false) }); return; }
      Store.Touch(p.id);
      Conn c;
      if (conns.TryGetValue(p.id, out c))
      {
        if (c.state.Kind == TunnelKind.Failed || c.state.Kind == TunnelKind.Idle) StartConn(c, p);
      }
      else
      {
        c = new Conn { profile = p.Clone(), tunnel = new Tunnel(this), web = new WebView2 { Dock = DockStyle.Fill, Visible = false } };
        c.web.DefaultBackgroundColor = BackColor;
        conns[p.id] = c;
        order.Add(p.id);
        pages.Controls.Add(c.web);
        var cc = c;
        c.tunnel.OnState = s => TunnelChanged(cc, s);
        activeID = p.id;
        showHome = false;
        Publish();
        await SetUpPage(c);
        if (!conns.ContainsKey(p.id) || conns[p.id] != c) return;
        StartConn(c, p);
      }
      activeID = p.id;
      showHome = false;
      StopProbing();
      Publish();
    }

    /// A page for a server: its own profile, so logins and settings don't mix (every forwarded server
    /// is 127.0.0.1, and a copy of a server must not share the original's login).
    async Task SetUpPage(Conn c)
    {
      var o = env.CreateCoreWebView2ControllerOptions();
      o.ProfileName = "s" + c.profile.id.Replace("-", "");
      await c.web.EnsureCoreWebView2Async(env, o);
      var core = c.web.CoreWebView2;
      c.webReady = true;
      core.Settings.AreBrowserAcceleratorKeysEnabled = false;
      core.Settings.IsStatusBarEnabled = false;
      core.Settings.AreDevToolsEnabled = true;
      // the page's alerts reach us the way the Mac app gets them
      await core.AddScriptToExecuteOnDocumentCreatedAsync(
        "(function(){if(window.webkit&&window.webkit.messageHandlers)return;var w=window.chrome&&window.chrome.webview;if(!w)return;" +
        "window.webkit={messageHandlers:{twNotify:{postMessage:function(n){try{w.postMessage({tw:'notify',n:n})}catch(e){}}}}};" +
        // F5 reloads (the browser's own keys are off: Ctrl+R, Ctrl+F… belong to the terminal)
        "addEventListener('keydown',function(e){if(e.key==='F5'&&!e.ctrlKey&&!e.altKey){e.preventDefault();location.reload();}},true);})();");
      core.WebMessageReceived += (s, e) => PageMessage(c, e.WebMessageAsJson);
      core.NavigationStarting += (s, e) =>
      {
        // other sites open in the browser
        if (IsOther(c, e.Uri)) { e.Cancel = true; Browser(e.Uri); }
      };
      core.NewWindowRequested += (s, e) =>
      {
        if (IsOther(c, e.Uri)) { e.Handled = true; Browser(e.Uri); }
        // the same server (an original image…): a window of its own, same login
      };
      core.NavigationCompleted += (s, e) => PageLoaded(c, e);
      core.ProcessFailed += (s, e) =>
      {
        Log.Write("page process failed " + e.ProcessFailedKind);
        if (c.loadedBase != null) c.web.CoreWebView2.Navigate(c.loadedBase + "/");
      };
    }

    bool IsOther(Conn c, string uri)
    {
      if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
      if (u.Scheme != "http" && u.Scheme != "https") return false;
      var own = c.loadedBase != null && Uri.TryCreate(c.loadedBase, UriKind.Absolute, out var b) ? b.Host : null;
      return u.Host != "127.0.0.1" && u.Host != own;
    }

    void StartConn(Conn c, Profile p)
    {
      c.profile = p.Clone();
      c.started = Now;
      // a fresh start: the old page goes, so it never shows under new settings
      c.loadedBase = null;
      c.pageLoaded = false;
      if (c.webReady) c.web.CoreWebView2.Navigate("about:blank");
      c.tunnel.Start(p);
    }

    void TunnelChanged(Conn c, TunnelState s)
    {
      // a stopped connection's last word
      if (!conns.TryGetValue(c.profile.id, out var now) || now != c) return;
      Log.Write("state " + c.profile.Title + " " + s);
      c.state = s;
      if (s.Kind == TunnelKind.Ready && c.webReady)
      {
        var url = c.web.CoreWebView2.Source;
        // after a reconnect the page reconnects its own streams: only load when it isn't there yet
        if (c.loadedBase != s.Text || string.IsNullOrEmpty(url) || url == "about:blank")
        {
          c.loadedBase = s.Text;
          c.pageLoaded = false;
          c.web.CoreWebView2.Navigate(s.Text + "/");
          Updater.CheckSoon(this, s.Text);
        }
      }
      if (s.Kind == TunnelKind.Failed)
      {
        c.loadedBase = null;
        c.pageLoaded = false;
      }
      Publish();
    }

    void PageLoaded(Conn c, CoreWebView2NavigationCompletedEventArgs e)
    {
      var src = c.web.CoreWebView2.Source ?? "";
      if (c.loadedBase == null) return;
      if (e.IsSuccess)
      {
        if (!src.StartsWith(c.loadedBase)) return;
        Log.Write("page loaded " + src);
        c.pageLoaded = true;
        if (c.pendingSession is int sid)
        {
          c.pendingSession = null;
          _ = c.web.CoreWebView2.ExecuteScriptAsync("location.hash = '#/s/" + sid + "'");
        }
        Publish();
        return;
      }
      // replaced by another load (a reload, a link) or turned into a download: not a failure
      if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled || e.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted && c.pageLoaded) return;
      Log.Write("page failed " + e.WebErrorStatus);
      if (c.pageLoaded) return; // the page itself is up; a frame or a later navigation
      c.state = TunnelState.Of(TunnelKind.Failed, "网页加载失败：" + e.WebErrorStatus);
      c.loadedBase = null;
      c.pageLoaded = false;
      Publish();
    }

    void Disconnect(string id)
    {
      if (!conns.TryGetValue(id, out var c)) return;
      conns.Remove(id);
      order.Remove(id);
      c.tunnel.OnState = null;
      c.tunnel.Stop();
      pages.Controls.Remove(c.web);
      try { c.web.Dispose(); } catch { }
      if (activeID == id) { activeID = null; GoHome(); }
      else Publish();
    }

    void GoHome()
    {
      showHome = true;
      Publish();
      StartProbing();
    }

    void Reconnect()
    {
      var c = Active;
      if (c == null) return;
      var p = Store.Get(c.profile.id);
      if (p == null) return;
      StartConn(c, p);
      showHome = false;
      Publish();
    }

    void ReloadPage()
    {
      var c = Active;
      if (showHome || c == null || c.loadedBase == null || !c.webReady) return;
      var src = c.web.CoreWebView2.Source;
      if (string.IsNullOrEmpty(src) || src == "about:blank") c.web.CoreWebView2.Navigate(c.loadedBase + "/");
      else c.web.CoreWebView2.Reload();
    }

    void Remove(string id)
    {
      var c = conns.TryGetValue(id, out var x) ? x : null;
      // its login goes too: the page's profile
      if (c != null && c.webReady)
      {
        try { _ = c.web.CoreWebView2.Profile.ClearBrowsingDataAsync(); } catch { }
      }
      Disconnect(id);
      Store.Remove(id);
      probes.Remove(id);
      Publish();
    }

    void Saved(Profile p, string pw, bool go)
    {
      var before = Store.Get(p.id)?.Clone();
      var pwBefore = Store.Password(p.id);
      Store.Upsert(p, pw);
      probes.Remove(p.id);
      if (showHome) Probe(p);
      // in use: new connection settings mean connecting again, where you are (home or its page)
      if (conns.TryGetValue(p.id, out var c))
      {
        if (!p.SameConnection(before) || pwBefore != (pw ?? "")) StartConn(c, p);
        else c.profile = p.Clone();
      }
      Publish();
      if (go) Open(p);
    }

    object Draft(string id, string mode, bool duplicate)
    {
      var src = Store.Get(id);
      Profile d;
      var pw = "";
      var isNew = true;
      if (src == null)
      {
        d = new Profile { localPort = Store.FreeLocalPort() };
        if (mode != null) d.mode = mode;
      }
      else if (duplicate)
      {
        d = src.Clone();
        d.id = Guid.NewGuid().ToString();
        d.name = src.Title + " 副本";
        d.lastUsed = 0;
        if (!d.IsDirect) d.localPort = Store.FreeLocalPort();
        pw = Store.Password(src.id);
      }
      else
      {
        d = src.Clone();
        pw = Store.Password(src.id);
        isNew = false;
      }
      var taken = new Dictionary<string, string>();
      foreach (var o in Store.Profiles) if (!o.IsDirect && o.id != d.id) taken[o.localPort.ToString()] = o.Title;
      return new { profile = d, password = pw, isNew, taken };
    }

    // ---------- is it up? (the cards' dots)

    void StartProbing()
    {
      ProbeAll();
      if (probeTimer == null)
      {
        probeTimer = new System.Windows.Forms.Timer { Interval = 30000 };
        probeTimer.Tick += (s, e) => { if (showHome && Visible) ProbeAll(); };
      }
      probeTimer.Start();
    }

    void StopProbing() => probeTimer?.Stop();

    void ProbeAll() { foreach (var p in Store.Profiles.ToList()) Probe(p); }

    async void Probe(Profile p)
    {
      // the last answer stays shown while asking again
      if (!probes.ContainsKey(p.id)) probes[p.id] = TmuxWeb.Probe.Of("checking");
      var r = await Prober.Check(p.Clone());
      if (Store.Get(p.id) == null) return;
      probes[p.id] = r;
      Publish();
    }

    // ---------- page → notifications

    void PageMessage(Conn c, string json)
    {
      Dictionary<string, object> m;
      try { m = Store.Json.Deserialize<Dictionary<string, object>>(json); } catch { return; }
      if (m == null || !(m.TryGetValue("tw", out var tw) && (tw as string) == "notify") || !(m["n"] is Dictionary<string, object> n)) return;
      Log.Write("notice from " + c.profile.Title + " shown=" + !(Visible && WindowState != FormWindowState.Minimized && Form.ActiveForm == this && Active == c && !showHome));
      // only when you aren't looking at that page (it shows its own alert then)
      if (Visible && WindowState != FormWindowState.Minimized && ContainsFocus && Form.ActiveForm == this && Active == c && !showHome) return;
      var title = n.TryGetValue("title", out var t) ? t as string : null;
      var text = n.TryGetValue("text", out var x) ? x as string : null;
      var session = n.TryGetValue("session", out var se) ? se as string : null;
      int? sid = n.TryGetValue("sessionId", out var si) && si is int i ? i : (int?)null;
      var kind = n.TryGetValue("kind", out var k) ? k as string : null;
      var several = conns.Count > 1;
      var sub = string.Join(" · ", new[] { several ? c.profile.Title : null, session }.Where(s => !string.IsNullOrEmpty(s)));
      balloonTarget = (c.profile.id, sid);
      var body = string.Join("\n", new[] { sub, text }.Where(s => !string.IsNullOrEmpty(s)));
      tray.ShowBalloonTip(8000, string.IsNullOrEmpty(title) ? "tmux-web" : title, string.IsNullOrEmpty(body) ? " " : body, ToolTipIcon.None);
      if (kind == "waiting") SystemSounds.Asterisk.Play();
      FlashTaskbar();
    }

    void OpenTarget(string server, int? session)
    {
      BringBack();
      var p = Store.Get(server);
      if (p == null) return;
      Open(p);
      if (session is int sid && conns.TryGetValue(server, out var c))
      {
        if (c.pageLoaded && c.webReady) _ = c.web.CoreWebView2.ExecuteScriptAsync("location.hash = '#/s/" + sid + "'");
        else c.pendingSession = sid;
      }
    }

    [StructLayout(LayoutKind.Sequential)] struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags, uCount, dwTimeout; }
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);

    void FlashTaskbar()
    {
      if (!Visible || Form.ActiveForm == this) return;
      var f = new FLASHWINFO { cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)), hwnd = Handle, dwFlags = 2 | 12, uCount = 3 };
      FlashWindowEx(ref f);
    }

    // ---------- the shell page: state out, actions in

    long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    void Publish()
    {
      Layout2();
      UpdateTitle();
      if (!shellReady) return;
      var cs = new Dictionary<string, object>();
      foreach (var kv in conns)
      {
        var c = kv.Value;
        cs[kv.Key] = new { kind = c.state.Kind.ToString().ToLowerInvariant(), text = c.state.Text, pageLoaded = c.pageLoaded, started = c.started, live = c.Live };
      }
      var keys = Store.Keys.Select(k => new { k.id, k.name, k.path, file = k.File, exists = k.Exists, users = Store.UsersOf(k.id).Select(p => p.Title).ToList() }).ToList();
      Send(new
      {
        type = "state",
        profiles = Store.Sorted,
        conns = cs,
        order,
        probes,
        activeID,
        showHome,
        keys,
        version = Updater.Current,
        update = UpdateOffer,
        easyTier = EasyTierCore.Executable != null,
      });
    }

    void UpdateTitle()
    {
      var c = Active;
      Text = showHome || c == null ? "tmux-web" : "tmux-web · " + c.profile.Title;
    }

    public void Send(object o)
    {
      if (!shellReady) return;
      try { shell.CoreWebView2.PostWebMessageAsJson(Store.Json.Serialize(o)); } catch (Exception e) { Log.Write("send: " + e.Message); }
    }

    void Reply(object req, object data) => Send(new { type = "reply", req, data });

    static string S(Dictionary<string, object> m, string k) => m.TryGetValue(k, out var v) ? v as string : null;

    async void OnShellMessage(string json)
    {
      Dictionary<string, object> m;
      try { m = Store.Json.Deserialize<Dictionary<string, object>>(json); } catch { return; }
      if (m == null) return;
      var op = S(m, "op");
      m.TryGetValue("req", out var req);
      var id = S(m, "id");
      try
      {
        switch (op)
        {
          case "ready": shellReady = true; Publish(); break;
          case "connect": { var p = Store.Get(id); if (p != null) Open(p); break; }
          case "disconnect": Disconnect(id); break;
          case "home": GoHome(); break;
          case "retry": Reconnect(); break;
          case "reload": ReloadPage(); break;
          case "overlay": overlay = m.TryGetValue("on", out var on) && on is bool b && b; Layout2(); if (!overlay) Active?.web.Focus(); break;
          case "draft": Reply(req, Draft(id, S(m, "mode"), m.TryGetValue("duplicate", out var dup) && dup is bool d && d)); break;
          case "save":
            {
              var p = Store.Json.ConvertToType<Profile>(m["profile"]);
              Saved(p, S(m, "password") ?? "", m.TryGetValue("connect", out var go) && go is bool g && g);
              break;
            }
          case "remove": Remove(id); break;
          case "test":
            {
              var p = Store.Json.ConvertToType<Profile>(m["profile"]);
              var r = await Prober.Check(p);
              Reply(req, r);
              break;
            }
          case "pickKey": Reply(req, PickKey(S(m, "title"))); break;
          case "addKey":
            {
              var path = S(m, "path");
              var problem = KeyFile.Problem(SSHKey.Of(path).File);
              if (problem != null) { Reply(req, new { error = problem }); break; }
              var k = Store.AddKey(path, out var known);
              Publish();
              Reply(req, new { k.id, k.name, known });
              break;
            }
          case "renameKey": { var k = Store.Key(id); if (k != null) { k.name = S(m, "name") ?? k.name; Store.UpdateKey(k); Publish(); } break; }
          case "replaceKey":
            {
              var k = Store.Key(id);
              var path = S(m, "path");
              var problem = KeyFile.Problem(SSHKey.Of(path).File);
              if (k == null) break;
              if (problem != null) { Reply(req, new { error = problem }); break; }
              k.path = path;
              Store.UpdateKey(k);
              Publish();
              Reply(req, new { ok = true });
              break;
            }
          case "removeKey": Store.RemoveKey(id); Publish(); break;
          case "keyInfo": { var k = Store.Key(id); Reply(req, k == null ? null : await Task.Run(() => KeyInfo.Info(k))); break; }
          case "copyPublic":
            {
              var k = Store.Key(id);
              var r = k == null ? null : await Task.Run(() => KeyInfo.PublicKey(k));
              if (r != null && r.StartsWith("ssh-") || r != null && r.StartsWith("ecdsa-") || r != null && r.StartsWith("sk-"))
              {
                Clipboard.SetText(r);
                Reply(req, new { ok = true });
              }
              else Reply(req, new { error = "这把私钥有口令，旁边也没有 .pub 文件，取不出公钥。可以在终端运行：ssh-keygen -y -f \"" + k?.File + "\"" });
              break;
            }
          case "reveal": { var k = Store.Key(id); if (k != null && k.Exists) Process.Start("explorer.exe", "/select,\"" + k.File + "\""); break; }
          case "menu": ShowMoreMenu(Pt(m)); break;
          case "tabMenu": ShowTabMenu(id, Pt(m)); break;
          case "openInBrowser": { var c = Active; if (c?.loadedBase != null) Browser(c.loadedBase + "/"); break; }
          case "checkUpdates": Updater.Check(this, Active?.loadedBase ?? conns.Values.Select(c => c.loadedBase).FirstOrDefault(x => x != null), true); break;
          case "installUpdate": Updater.Install(this); break;
          case "skipUpdate": Updater.Skip(this); break;
          case "link": Browser(S(m, "url")); break;
          case "openLog": if (File.Exists(Log.FilePath)) Process.Start("notepad.exe", "\"" + Log.FilePath + "\""); break;
          case "quit": Quit(); break;
        }
      }
      catch (Exception e)
      {
        Log.Write("op " + op + ": " + e);
        if (req != null) Reply(req, new { error = e.Message });
      }
    }

    Point Pt(Dictionary<string, object> m)
    {
      double x = m.TryGetValue("x", out var a) ? Convert.ToDouble(a) : 0, y = m.TryGetValue("y", out var b) ? Convert.ToDouble(b) : 0;
      var scale = DpiScale;
      return shell.PointToScreen(new Point((int)(x * scale), (int)(y * scale)));
    }

    string PickKey(string title)
    {
      using (var d = new OpenFileDialog
      {
        Title = title ?? "选择 SSH 私钥（选公钥 .pub 也可以）",
        InitialDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh"),
        Filter = "所有文件|*.*",
        CheckFileExists = true,
      })
        return d.ShowDialog(this) == DialogResult.OK ? d.FileName : null;
    }

    // ---------- menus: the toolbar's ⋯, a tab's right click, the tray

    ToolStripMenuItem Item(string text, Action a, bool enabled = true)
    {
      var i = new ToolStripMenuItem(text) { Enabled = enabled };
      i.Click += (s, e) => a();
      return i;
    }

    ContextMenuStrip NewMenu()
    {
      var m = new ContextMenuStrip { ShowImageMargin = false, Font = new Font("Microsoft YaHei UI", 9f) };
      m.Closed += (s, e) => BeginInvoke((Action)(() => m.Dispose()));
      return m;
    }

    void ShowMoreMenu(Point at)
    {
      var m = NewMenu();
      var c = Active;
      var onServer = !showHome && c != null;
      m.Items.Add(Item("编辑此服务器…", () => Send(new { type = "editor", draft = Draft(c.profile.id, null, false) }), onServer));
      m.Items.Add(Item("重新连接", Reconnect, onServer));
      m.Items.Add(Item("在浏览器中打开", () => Browser(c.loadedBase + "/"), onServer && c.loadedBase != null));
      m.Items.Add(Item("断开此服务器", () => Disconnect(c.profile.id), onServer));
      if (conns.Count > 1) m.Items.Add(Item("断开全部（" + conns.Count + " 台）", () => { foreach (var k in conns.Keys.ToList()) Disconnect(k); }));
      m.Items.Add(new ToolStripSeparator());
      m.Items.Add(Item("私钥…", () => Send(new { type = "keys" })));
      m.Items.Add(Item("检查更新…", () => Updater.Check(this, c?.loadedBase, true)));
      m.Items.Add(Item("查看日志", () => { if (File.Exists(Log.FilePath)) Process.Start("notepad.exe", "\"" + Log.FilePath + "\""); }));
      m.Items.Add(new ToolStripSeparator());
      m.Items.Add(Item("退出 tmux-web", Quit));
      m.Show(at);
    }

    void ShowTabMenu(string id, Point at)
    {
      var p = Store.Get(id);
      if (p == null) return;
      var m = NewMenu();
      m.Items.Add(Item("编辑此服务器…", () => Send(new { type = "editor", draft = Draft(id, null, false) })));
      m.Items.Add(Item("断开", () => Disconnect(id)));
      m.Show(at);
    }

    void FillTrayMenu(ContextMenuStrip m)
    {
      m.Items.Clear();
      m.Font = new Font("Microsoft YaHei UI", 9f);
      m.Items.Add(Item("显示 tmux-web", BringBack));
      m.Items.Add(Item("全部服务器", () => { BringBack(); GoHome(); }));
      var used = Store.Sorted.Where(p => conns.ContainsKey(p.id)).ToList();
      if (used.Count > 0) m.Items.Add(new ToolStripSeparator());
      foreach (var p in used)
      {
        var pp = p;
        var c = conns[p.id];
        m.Items.Add(Item((c.Live ? "● " : "○ ") + p.Title, () => { BringBack(); Open(pp); }));
      }
      m.Items.Add(new ToolStripSeparator());
      m.Items.Add(Item("退出", Quit));
    }

    public static void Browser(string url)
    {
      if (string.IsNullOrEmpty(url)) return;
      if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto")) return;
      try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
    }

    protected override void WndProc(ref Message m)
    {
      base.WndProc(ref m);
      // per-monitor DPI change: the toolbar strip keeps its size in CSS px
      if (m.Msg == 0x02E0) BeginInvoke((Action)Layout2);
    }
  }

  static class KeyInfo
  {
    public class Details { public string type = "", fingerprint = "", problem; }

    /// kind and fingerprint, from ssh-keygen (a .pub next to the key is read when there is one, so a
    /// key with a passphrase needn't be opened)
    public static Details Info(SSHKey k)
    {
      var file = k.File;
      var problem = KeyFile.Problem(file);
      if (problem != null) return new Details { problem = problem };
      var pub = file + ".pub";
      var outp = Ssh.Run(Ssh.Tool("ssh-keygen.exe"), new[] { "-l", "-f", File.Exists(pub) ? pub : file });
      if (outp == null) return new Details { problem = "有口令，旁边也没有 .pub 文件，看不了指纹（登录不受影响）" };
      var parts = outp.Split(' ');
      var fp = parts.FirstOrDefault(x => x.StartsWith("SHA256:")) ?? "";
      var type = outp.Contains("(") ? outp.Substring(outp.LastIndexOf('(') + 1).TrimEnd(')') : "";
      if (type == "RSA") type = "RSA " + parts[0];
      return new Details { type = type, fingerprint = fp };
    }

    public static string PublicKey(SSHKey k)
    {
      var pub = k.File + ".pub";
      try
      {
        if (File.Exists(pub))
        {
          var t = File.ReadAllText(pub).Trim();
          if (t.StartsWith("ssh-") || t.StartsWith("ecdsa-") || t.StartsWith("sk-")) return t;
        }
      }
      catch { }
      return Ssh.Run(Ssh.Tool("ssh-keygen.exe"), new[] { "-y", "-f", k.File });
    }
  }
}
