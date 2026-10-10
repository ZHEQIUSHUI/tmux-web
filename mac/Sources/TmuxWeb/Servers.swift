import AppKit
import SwiftUI

/// The home screen: every server as a card, the recently used first. A click opens it (straight
/// back to its page when it's already connected); ⋯ or a right click edits, copies, deletes.
struct HomeView: View {
  @ObservedObject var store = ProfileStore.shared
  @ObservedObject var model: AppModel
  @State private var query = ""

  private var shown: [Profile] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let all = store.sorted
    return q.isEmpty ? all : all.filter { "\($0.title) \($0.address)".lowercased().contains(q) }
  }

  var body: some View {
    ZStack {
      Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
      if store.profiles.isEmpty {
        Welcome(model: model)
      } else {
        VStack(spacing: 0) {
          header
          ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 420), spacing: 18)], spacing: 18) {
              ForEach(shown) { p in
                ServerCard(profile: p, conn: model.conns[p.id], probe: model.probes[p.id], actions: model.actions)
              }
            }
            .padding(.horizontal, 32).padding(.top, 4).padding(.bottom, 24)
            if shown.isEmpty { Text("没有找到「\(query)」").foregroundStyle(.secondary).padding(.top, 40) }
          }
          footer
        }
      }
    }
  }

  private var header: some View {
    let connected = store.profiles.filter { model.conns[$0.id] != nil }.count
    return HStack(alignment: .firstTextBaseline, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text("服务器").font(.system(size: 26, weight: .bold))
        Text(connected > 0 ? "\(store.profiles.count) 台 · \(connected) 台已连接" : "\(store.profiles.count) 台 · 点卡片打开")
          .font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("搜索名称或地址", text: $query).textFieldStyle(.plain).frame(width: 170)
        if !query.isEmpty {
          Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }.buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
      Button { model.actions.edit(nil, nil) } label: { Label("新建服务器", systemImage: "plus") }
        .buttonStyle(.borderedProminent).controlSize(.large)
    }
    .padding(.horizontal, 32).padding(.top, 26).padding(.bottom, 18)
  }

  private var footer: some View {
    HStack(spacing: 8) {
      Text("tmux-web \(Updater.current)")
      Text("·")
      Button("检查更新") { model.actions.checkUpdates() }.buttonStyle(.link)
      Spacer()
      Text("关掉窗口后连接和通知照常，点程序坞图标回来").foregroundStyle(.tertiary)
    }
    .font(.caption).foregroundStyle(.secondary)
    .padding(.horizontal, 32).padding(.vertical, 10)
  }
}

/// No servers yet: what the app is, and the two ways to add one.
private struct Welcome: View {
  @ObservedObject var model: AppModel
  var body: some View {
    VStack(spacing: 22) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 88, height: 88)
      VStack(spacing: 8) {
        Text("添加第一台服务器").font(.system(size: 24, weight: .bold))
        Text("tmux-web 运行在你的服务器上，这个 App 打开它的网页。选择怎么连过去：")
          .foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      HStack(spacing: 16) {
        ModeChoice(icon: "network", color: .teal, title: "直接访问", text: "已经能直接打开服务器的地址：EasyTier 等组网、局域网、公网") { model.actions.edit(nil, "direct") }
        ModeChoice(icon: "lock.shield", color: .indigo, title: "SSH 转发", text: "通过 SSH 端口转发访问，服务器不用对外开放 tmux-web 的端口") { model.actions.edit(nil, "ssh") }
      }
      .frame(maxWidth: 620)
    }
    .padding(40)
  }
}

struct ModeChoice: View {
  let icon: String
  let color: Color
  let title: String
  let text: String
  var selected = false
  let action: () -> Void
  @State private var hover = false

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        Image(systemName: icon).font(.system(size: 20, weight: .medium)).foregroundStyle(.white)
          .frame(width: 40, height: 40)
          .background(RoundedRectangle(cornerRadius: 10).fill(color.gradient))
        Text(title).font(.headline)
        Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .background(
        RoundedRectangle(cornerRadius: 14)
          .fill(selected ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14)
          .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(hover ? 0.25 : 0.1), lineWidth: selected ? 2 : 1)
      )
      .contentShape(RoundedRectangle(cornerRadius: 14))
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}

struct Avatar: View {
  let profile: Profile
  var size: CGFloat = 42
  var body: some View {
    let first = String(profile.title.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    Text(first.isEmpty ? "+" : first)
      .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(RoundedRectangle(cornerRadius: size * 0.26).fill((profile.isDirect ? Color.teal : Color.indigo).gradient))
  }
}

private struct ServerCard: View {
  let profile: Profile
  let conn: ConnInfo?
  let probe: Probe?
  let actions: ServerActions
  @State private var hover = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Avatar(profile: profile)
        VStack(alignment: .leading, spacing: 3) {
          Text(profile.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
          Text(profile.address).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 4)
        if let conn { ConnBadge(info: conn) }
        Menu { items } label: { Image(systemName: "ellipsis").font(.system(size: 14, weight: .semibold)).frame(width: 22, height: 22) }
          .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
          .opacity(hover ? 1 : 0.45)
          .help("编辑、复制、删除")
      }
      HStack(spacing: 8) {
        Chip(text: profile.isDirect ? "直接访问" : "SSH 转发", icon: profile.isDirect ? "network" : "lock.shield")
        ProbeChip(probe: probe)
        Spacer()
        if hover {
          if conn != nil {
            Button("断开") { actions.disconnect(profile.id) }.controlSize(.small)
            Button("打开") { actions.connect(profile) }.controlSize(.small).buttonStyle(.borderedProminent)
          } else {
            Button("连接") { actions.connect(profile) }.controlSize(.small).buttonStyle(.borderedProminent)
          }
        } else if let used = profile.lastUsed {
          Text("上次使用 \(relativeTime(used))").font(.caption).foregroundStyle(.tertiary)
        }
      }
      .frame(height: 22)
    }
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 14)
        .fill(conn != nil ? Color.accentColor.opacity(0.07) : Color(nsColor: .controlBackgroundColor))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14)
        .strokeBorder(conn != nil ? Color.accentColor.opacity(0.6) : Color.primary.opacity(hover ? 0.18 : 0.08), lineWidth: conn != nil ? 1.5 : 1)
    )
    .shadow(color: .black.opacity(hover ? 0.12 : 0.04), radius: hover ? 10 : 3, y: hover ? 3 : 1)
    .contentShape(RoundedRectangle(cornerRadius: 14))
    .onHover { hover = $0 }
    .onTapGesture { actions.connect(profile) }
    .contextMenu { items }
    .animation(.easeOut(duration: 0.15), value: hover)
  }

  @ViewBuilder private var items: some View {
    Button(conn != nil ? "打开" : "连接") { actions.connect(profile) }
    if conn != nil { Button("断开") { actions.disconnect(profile.id) } }
    Divider()
    Button("编辑…") { actions.edit(profile, nil) }
    Button("复制一份…") { actions.duplicate(profile) }
    Divider()
    Button("删除…", role: .destructive) { actions.remove(profile) }
  }
}

struct Chip: View {
  let text: String
  var icon: String?
  var color: Color = .secondary
  var body: some View {
    HStack(spacing: 4) {
      if let icon { Image(systemName: icon).font(.system(size: 9, weight: .semibold)) }
      Text(text)
    }
    .font(.caption).foregroundStyle(color)
    .padding(.horizontal, 8).padding(.vertical, 3)
    .background(Capsule().fill(Color.primary.opacity(0.06)))
  }
}

struct ProbeChip: View {
  let probe: Probe?
  var body: some View {
    switch probe {
    case nil, .checking?:
      HStack(spacing: 5) {
        ProgressView().controlSize(.mini)
        Text("检测中")
      }
      .font(.caption).foregroundStyle(.secondary)
    case .online(let ms)?:
      dot(.green, "在线 · \(ms) ms")
    case .offline(let why)?:
      dot(.gray, "离线 · \(why)")
    case .unknown(let why)?:
      dot(.gray.opacity(0.5), why)
    }
  }

  private func dot(_ c: Color, _ text: String) -> some View {
    HStack(spacing: 5) {
      Circle().fill(c).frame(width: 7, height: 7)
      Text(text).lineLimit(1)
    }
    .font(.caption).foregroundStyle(.secondary)
  }
}

/// the state of a server in use
struct ConnBadge: View {
  let info: ConnInfo
  var body: some View {
    let (text, color): (String, Color) = {
      switch info.state {
      case .ready: return info.pageLoaded ? ("已连接", .green) : ("打开中", .orange)
      case .reconnecting: return ("重新连接中", .orange)
      case .failed: return ("连接失败", .red)
      case .idle, .connecting: return ("连接中", .orange)
      }
    }()
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text)
    }
    .font(.caption.weight(.medium)).foregroundStyle(color)
    .padding(.horizontal, 8).padding(.vertical, 3)
    .background(Capsule().fill(color.opacity(0.12)))
  }
}
