using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace TmuxWeb
{
  static class Program
  {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    /// the app's own name for "bring the window back" (a second start of the app signals it)
    public static readonly string ShowEvent = "tmux-web-show-" + Environment.UserName;

    [STAThread]
    static int Main(string[] args)
    {
      // ssh asking for a password or a code: this exe answers (see Tunnel: SSH_ASKPASS)
      var token = Environment.GetEnvironmentVariable("TW_ASKPASS");
      if (!string.IsNullOrEmpty(token)) return Askpass.Run(args, token);

      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);

      if (args.Length >= 1 && args[0] == "--updated") Updater.Cleanup();

      // one app: a second start brings the first one's window back
      var mutex = new Mutex(true, "tmux-web-app-" + Environment.UserName, out var first);
      if (!first)
      {
        try { EventWaitHandle.OpenExisting(ShowEvent).Set(); } catch { }
        return 0;
      }
      Application.ThreadException += (s, e) => Log.Write("ui error: " + e.Exception);
      AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Write("fatal: " + e.ExceptionObject);
      Store.Load();
      EasyTierFiles.RemoveStale();
      KeyFile.RemoveStale();
      Askpass.ClearMarks();
      Application.Run(new MainForm());
      GC.KeepAlive(mutex);
      return 0;
    }

    public static Icon AppIcon
    {
      get
      {
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; }
      }
    }
  }

  /// The program ssh runs to ask for a password or a code: a small dialog; the answer goes to ssh.
  /// The password saved in the app answers the password prompt itself — once: a second ask means it
  /// was wrong, so then the dialog comes.
  static class Askpass
  {
    static string Mark(string token) => Path.Combine(Path.GetTempPath(), "tw-askpass-" + token);

    public static void ClearMarks()
    {
      try { foreach (var f in Directory.GetFiles(Path.GetTempPath(), "tw-askpass-*")) try { File.Delete(f); } catch { } } catch { }
    }

    public static int Run(string[] args, string token)
    {
      var prompt = args.Length > 0 ? string.Join(" ", args) : "密码：";
      var secret = prompt.IndexOf("assword", StringComparison.OrdinalIgnoreCase) >= 0 || prompt.IndexOf("passphrase", StringComparison.OrdinalIgnoreCase) >= 0;
      var saved = Environment.GetEnvironmentVariable("TW_SSH_PASSWORD");
      if (prompt.IndexOf("assword", StringComparison.OrdinalIgnoreCase) >= 0 && !string.IsNullOrEmpty(saved) && !File.Exists(Mark(token)))
      {
        try { File.WriteAllText(Mark(token), ""); } catch { }
        Answer(saved);
        return 0;
      }
      // "Enter passphrase for key …": the key's saved passphrase, the same way
      var phrase = Environment.GetEnvironmentVariable("TW_SSH_PASSPHRASE");
      if (prompt.IndexOf("passphrase", StringComparison.OrdinalIgnoreCase) >= 0 && !string.IsNullOrEmpty(phrase) && !File.Exists(Mark(token) + "-key"))
      {
        try { File.WriteAllText(Mark(token) + "-key", ""); } catch { }
        Answer(phrase);
        return 0;
      }
      // a yes/no question (a new host key with other settings): yes/no, not a password field
      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
      Application.EnableVisualStyles();
      var title = Environment.GetEnvironmentVariable("TW_ASKPASS_TITLE");
      using (var f = new AskForm(prompt, secret, string.IsNullOrEmpty(title) ? "tmux-web · SSH 验证" : "tmux-web · " + title))
      {
        if (f.ShowDialog() != DialogResult.OK) return 1;
        Answer(f.Value);
        return 0;
      }
    }

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);

    static void Answer(string s)
    {
      using (var o = Console.OpenStandardOutput())
      {
        var b = new System.Text.UTF8Encoding(false).GetBytes(s + "\n");
        o.Write(b, 0, b.Length);
      }
    }
  }

  class AskForm : Form
  {
    readonly TextBox box;
    public string Value => box.Text;

    public AskForm(string prompt, bool secret, string title)
    {
      Text = title;
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = MinimizeBox = false;
      StartPosition = FormStartPosition.CenterScreen;
      TopMost = true;
      ShowInTaskbar = true;
      AutoScaleDimensions = new SizeF(96f, 96f);
      AutoScaleMode = AutoScaleMode.Dpi;
      Font = new Font("Microsoft YaHei UI", 9f);
      Icon = Program.AppIcon;
      var pad = 16;
      var label = new Label { Text = prompt.Trim(), AutoSize = true, MaximumSize = new Size(380, 0), Location = new Point(pad, pad) };
      Controls.Add(label);
      var y = pad + label.PreferredHeight + 10;
      box = new TextBox { Location = new Point(pad, y), Width = 380, UseSystemPasswordChar = secret };
      Controls.Add(box);
      y += box.Height + 16;
      var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Size = new Size(88, 30), Location = new Point(pad + 380 - 88, y) };
      var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Size = new Size(88, 30), Location = new Point(pad + 380 - 88 * 2 - 8, y) };
      Controls.Add(ok);
      Controls.Add(cancel);
      AcceptButton = ok;
      CancelButton = cancel;
      ClientSize = new Size(380 + pad * 2, y + 30 + pad);
      Shown += (s, e) => { Activate(); box.Focus(); };
    }
  }
}
