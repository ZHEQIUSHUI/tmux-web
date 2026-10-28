import SwiftUI

/// In front of a server's page until it's up: the steps as they go, or what went wrong.
struct ConnectingView: View {
  let profile: Profile
  let info: ConnInfo
  let actions: ServerActions

  var body: some View {
    ZStack {
      Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
      VStack(spacing: 22) {
        VStack(spacing: 10) {
          Avatar(profile: profile, size: 60)
          Text(profile.title).font(.system(size: 20, weight: .bold))
          Text(profile.address).font(.callout).foregroundStyle(.secondary)
        }
        if case .failed(let raw) = info.state {
          Failure(raw: raw, direct: profile.isDirect, easyTier: profile.isEasyTier, actions: actions)
        } else {
          steps
          TimelineView(.periodic(from: info.started, by: 1)) { t in
            Text("已用 \(max(0, Int(t.date.timeIntervalSince(info.started)))) 秒").font(.caption).foregroundStyle(.tertiary).monospacedDigit()
          }
          Button("取消") { actions.disconnect(profile.id) }.keyboardShortcut(.cancelAction).controlSize(.large)
        }
      }
      .frame(maxWidth: 460)
      .padding(40)
    }
  }

  /// 1. the connection, 2. the page
  private var steps: some View {
    let up: Bool = { if case .ready = info.state { return true } else { return false } }()
    return VStack(alignment: .leading, spacing: 0) {
      Step(
        state: up ? .done : .running,
        title: profile.isDirect ? "连接服务器" : profile.isEasyTier ? "启动 EasyTier 并连接" : "建立 SSH 连接和端口转发",
        detail: profile.isDirect ? profile.address : profile.isEasyTier ? "不需要 TUN，也不用管理员权限" : "需要密码或验证码时会弹出对话框"
      )
      Divider().padding(.leading, 44)
      Step(state: up ? .running : .waiting, title: "打开网页", detail: up ? "正在加载 tmux-web…" : nil)
    }
    .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
  }
}

private struct Step: View {
  enum State { case waiting, running, done }
  let state: State
  let title: String
  let detail: String?

  var body: some View {
    HStack(spacing: 12) {
      Group {
        switch state {
        case .waiting: Image(systemName: "circle").foregroundStyle(.tertiary)
        case .running: ProgressView().controlSize(.small)
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        }
      }
      .font(.system(size: 18)).frame(width: 20)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: state == .waiting ? .regular : .medium)).foregroundStyle(state == .waiting ? .secondary : .primary)
        if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
      }
      Spacer()
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
  }
}

private struct Failure: View {
  let raw: String
  let direct: Bool
  let easyTier: Bool
  let actions: ServerActions
  @State private var details = false

  var body: some View {
    let (title, hint) = explain(raw, direct: direct, easyTier: easyTier)
    VStack(spacing: 16) {
      VStack(spacing: 8) {
        Label(title, systemImage: "exclamationmark.triangle.fill")
          .font(.headline).foregroundStyle(.orange)
        Text(hint).font(.callout).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      }
      VStack(alignment: .leading, spacing: 8) {
        Button { withAnimation(.easeOut(duration: 0.15)) { details.toggle() } } label: {
          Label("详细信息", systemImage: details ? "chevron.down" : "chevron.right").font(.caption)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary)
        if details {
          Text(raw).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 10) {
        Button("返回首页") { actions.home() }
        Button("编辑服务器…") { actions.editActive() }
        Button("重试") { actions.retry() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
      }
      .controlSize(.large)
    }
  }
}

/// The connection went away after it worked: a quiet note over the page while it comes back.
struct ReconnectingBanner: View {
  let text: String
  var body: some View {
    VStack {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(text).font(.callout)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)
      .background(.regularMaterial, in: Capsule())
      .shadow(color: .black.opacity(0.1), radius: 6, y: 2)
      .padding(.top, 10)
      Spacer()
    }
    .allowsHitTesting(false)
  }
}
