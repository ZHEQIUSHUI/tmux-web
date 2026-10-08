import Darwin
import Foundation

/// The SSH port forward to tmux-web: the system's ssh (so ~/.ssh/config, keys, the agent and
/// known_hosts all apply), asking for passwords / verification codes in a dialog.
final class Tunnel {
  enum State: Equatable {
    case idle
    case connecting
    case ready(port: Int)
    /// gone after it worked: trying again (on its own)
    case reconnecting(String)
    /// never came up: wait for the user (wrong password, host unreachable…)
    case failed(String)
  }

  var onState: ((State) -> Void)?
  private(set) var state: State = .idle {
    didSet {
      let s = state
      DispatchQueue.main.async { self.onState?(s) }
    }
  }

  private var proc: Process?
  /// held open while we run; its closing ends the ssh
  private var lifeline: Pipe?
  private var errText = ""
  private var profile: Profile?
  private var wanted = false
  private var everReady = false
  private var retry = 0
  private var poll: Timer?

  func start(_ p: Profile) {
    stop()
    profile = p
    wanted = true
    everReady = false
    retry = 0
    launch()
  }

  func stop() {
    wanted = false
    poll?.invalidate()
    poll = nil
    try? lifeline?.fileHandleForWriting.close()
    lifeline = nil
    if let p = proc, p.isRunning { p.terminate() }
    proc = nil
    state = .idle
  }

  private func launch() {
    guard wanted, let p = profile else { return }
    // a forward of ours left behind (a crash): it holds the port, end it
    killStale(p.localPort)
    if portOpen(p.localPort) {
      // something else holds the port (an older forward, another app): don't show its page
      state = .failed("本地端口 \(p.localPort) 已被占用。换一个本地端口，或关掉占用它的程序（比如 Termius 里的同名转发）。")
      return
    }
    state = everReady ? .reconnecting("正在重新连接…") : .connecting
    errText = ""

    var args = [
      "-N", "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=accept-new",
      "-p", String(p.sshPort),
      "-L", "127.0.0.1:\(p.localPort):\(p.remoteHost):\(p.remotePort)",
    ]
    if let key = p.privateKey { args += ["-i", key, "-o", "IdentitiesOnly=yes"] }
    args += p.extraArgs.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
    args.append(p.target.trimmingCharacters(in: .whitespaces))

    // ssh runs under a small sh that ends it as soon as we are gone, however we go (crash, kill):
    // it waits on a pipe from us, which closes with our process
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/sh")
    task.arguments = ["-c", "exec 3<&0; /usr/bin/ssh \"$@\" < /dev/null & p=$!; (read _ <&3; kill $p 2>/dev/null) & w=$!; wait $p; s=$?; kill $w 2>/dev/null; exit $s", "sh"] + args
    var env = ProcessInfo.processInfo.environment
    // passwords and verification codes: our dialog, never a terminal
    env["SSH_ASKPASS"] = Askpass.path
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["DISPLAY"] = env["DISPLAY"] ?? ":0"
    task.environment = env
    let lifeline = Pipe()
    task.standardInput = lifeline
    self.lifeline = lifeline
    task.standardOutput = FileHandle.nullDevice
    let err = Pipe()
    task.standardError = err
    err.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
      DispatchQueue.main.async { self?.errText += s }
    }
    task.terminationHandler = { [weak self] t in
      DispatchQueue.main.async { self?.ended(t) }
    }
    do {
      try task.run()
    } catch {
      state = .failed("无法启动 ssh：\(error.localizedDescription)")
      return
    }
    proc = task

    // the forward listens once ssh is in: then the page can load
    poll?.invalidate()
    poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] t in
      guard let self, let pr = self.profile else { return t.invalidate() }
      if self.proc?.isRunning == true, self.portOpen(pr.localPort) {
        t.invalidate()
        self.everReady = true
        self.retry = 0
        self.state = .ready(port: pr.localPort)
      }
    }
  }

  private func ended(_ t: Process) {
    guard t === proc else { return }
    poll?.invalidate()
    proc = nil
    guard wanted else { return }
    let why = message()
    if everReady {
      // it worked before: the network went away, try again (slower each time, up to 30 s)
      retry += 1
      let wait = min(30.0, pow(2.0, Double(min(retry, 5))))
      state = .reconnecting("连接断开，\(Int(wait)) 秒后重连…")
      DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.launch() }
    } else {
      state = .failed(why.isEmpty ? "ssh 退出了（代码 \(t.terminationStatus)）" : why)
    }
  }

  /// The useful lines of ssh's complaints.
  private func message() -> String {
    errText.split(separator: "\n")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty && !$0.hasPrefix("Warning: Permanently added") }
      .suffix(4)
      .joined(separator: "\n")
  }

  /// Our own forward for this port, orphaned by an earlier run that didn't get to clean up.
  private func killStale(_ port: Int) {
    let k = Process()
    k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
    k.arguments = ["-f", "^/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes .* -L 127.0.0.1:\(port):"]
    try? k.run()
    k.waitUntilExit()
    if k.terminationStatus == 0 { Thread.sleep(forTimeInterval: 0.3) }
  }

  private func portOpen(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return r == 0
  }
}

/// The program ssh runs to ask for a password or a code: a native dialog via osascript.
enum Askpass {
  static let path: String = {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("TmuxWeb")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("askpass.sh")
    let script = """
      #!/bin/sh
      # ssh's prompt (password, verification code…) in a dialog; the answer goes to ssh
      exec /usr/bin/osascript - "$1" <<'APPLESCRIPT'
      on run argv
        set p to item 1 of argv
        activate
        set r to display dialog p with title "tmux-web · SSH 验证" default answer "" with hidden answer buttons {"取消", "确定"} default button "确定" cancel button "取消" with icon note
        return text returned of r
      end run
      APPLESCRIPT
      """
    try? script.write(to: file, atomically: true, encoding: .utf8)
    chmod(file.path, 0o700)
    return file.path
  }()
}
