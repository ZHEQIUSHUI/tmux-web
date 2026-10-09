import AppKit
import SwiftUI

/// What the server list asks the app to do.
struct ServerActions {
  var connect: (Profile) -> Void = { _ in }
  /// nil: a new one
  var edit: (Profile?) -> Void = { _ in }
  var duplicate: (Profile) -> Void = { _ in }
  var remove: (Profile) -> Void = { _ in }
}

/// The first thing the app shows: every server as a card. A click connects (or goes back to the
/// page of the one already connected); ⋯ or a right click edits, copies, deletes.
struct ServerListView: View {
  @ObservedObject var store = ProfileStore.shared
  @ObservedObject var status: Status
  @State private var query = ""

  private var shown: [Profile] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    if q.isEmpty { return store.profiles }
    return store.profiles.filter { "\($0.title) \($0.address)".lowercased().contains(q) }
  }

  var body: some View {
    ZStack {
      Rectangle().fill(Color(nsColor: .windowBackgroundColor))
      if store.profiles.isEmpty {
        VStack(spacing: 14) {
          Image(systemName: "server.rack").font(.system(size: 40)).foregroundStyle(.secondary)
          Text("还没有服务器").font(.title3.weight(.semibold))
          Text("添加一台运行 tmux-web 的服务器：能直接访问（EasyTier、局域网）就填网址，否则通过 SSH 转发。")
            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
          Button("新建服务器…") { status.actions.edit(nil) }.keyboardShortcut(.defaultAction).controlSize(.large)
        }
        .padding(30)
      } else {
        VStack(spacing: 0) {
          HStack(spacing: 12) {
            Text("服务器").font(.title2.weight(.semibold))
            Spacer()
            if store.profiles.count > 3 {
              TextField("搜索", text: $query).textFieldStyle(.roundedBorder).frame(width: 200)
            }
            Button { status.actions.edit(nil) } label: { Label("新建", systemImage: "plus") }
              .help("新建服务器（⌘N）")
          }
          .padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 14)
          ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 380), spacing: 16)], spacing: 16) {
              ForEach(shown) { p in
                ServerCard(profile: p, state: status.activeID == p.id ? status.state : nil, actions: status.actions)
              }
              if query.isEmpty { AddCard { status.actions.edit(nil) } }
            }
            .padding(.horizontal, 28).padding(.bottom, 28).padding(.top, 2)
            if shown.isEmpty { Text("没有找到「\(query)」").foregroundStyle(.secondary).padding(.top, 30) }
          }
        }
      }
    }
  }
}

private struct ServerCard: View {
  let profile: Profile
  /// the connection's state, when this is the server in use
  let state: Tunnel.State?
  let actions: ServerActions
  @State private var hover = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: profile.isDirect ? "network" : "lock.shield")
          .font(.system(size: 17, weight: .medium)).foregroundStyle(.white)
          .frame(width: 36, height: 36)
          .background(RoundedRectangle(cornerRadius: 9).fill(profile.isDirect ? Color.teal : Color.indigo))
        VStack(alignment: .leading, spacing: 3) {
          Text(profile.title).font(.headline).lineLimit(1)
          Text(profile.address).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 4)
        Menu { items } label: { Image(systemName: "ellipsis.circle").font(.system(size: 15)) }
          .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
          .opacity(hover ? 1 : 0.35)
          .help("编辑、复制、删除")
      }
      HStack(spacing: 8) {
        Text(profile.isDirect ? "直接访问" : "SSH 转发")
          .font(.caption).foregroundStyle(.secondary)
          .padding(.horizontal, 7).padding(.vertical, 2)
          .background(Capsule().fill(Color.primary.opacity(0.07)))
        Spacer()
        if let state { StateLabel(state: state) }
      }
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
    .overlay(
      RoundedRectangle(cornerRadius: 12)
        .strokeBorder(state != nil ? Color.accentColor.opacity(0.75) : Color.primary.opacity(hover ? 0.2 : 0.09), lineWidth: state != nil ? 1.5 : 1)
    )
    .shadow(color: .black.opacity(hover ? 0.12 : 0.04), radius: hover ? 7 : 3, y: 1)
    .contentShape(RoundedRectangle(cornerRadius: 12))
    .onHover { hover = $0 }
    .onTapGesture { actions.connect(profile) }
    .contextMenu { items }
    .help(state.map { if case .ready = $0 { return "回到这台服务器的页面" } else { return "连接" } } ?? "连接")
    .animation(.easeOut(duration: 0.12), value: hover)
  }

  @ViewBuilder private var items: some View {
    Button("连接") { actions.connect(profile) }
    Divider()
    Button("编辑…") { actions.edit(profile) }
    Button("复制一份…") { actions.duplicate(profile) }
    Divider()
    Button("删除…", role: .destructive) { actions.remove(profile) }
  }
}

private struct StateLabel: View {
  let state: Tunnel.State
  var body: some View {
    HStack(spacing: 5) {
      switch state {
      case .ready:
        Circle().fill(Color.green).frame(width: 7, height: 7)
        Text("已连接")
      case .idle, .connecting:
        ProgressView().controlSize(.mini)
        Text("连接中")
      case .reconnecting:
        ProgressView().controlSize(.mini)
        Text("重新连接中")
      case .failed:
        Circle().fill(Color.red).frame(width: 7, height: 7)
        Text("连接失败")
      }
    }
    .font(.caption).foregroundStyle(.secondary)
  }
}

private struct AddCard: View {
  let add: () -> Void
  @State private var hover = false
  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: "plus").font(.system(size: 18, weight: .medium))
      Text("新建服务器").font(.callout)
    }
    .foregroundStyle(hover ? .primary : .secondary)
    .frame(maxWidth: .infinity, minHeight: 92)
    .background(
      RoundedRectangle(cornerRadius: 12)
        .strokeBorder(style: StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
        .foregroundStyle(Color.primary.opacity(hover ? 0.35 : 0.18))
    )
    .contentShape(RoundedRectangle(cornerRadius: 12))
    .onHover { hover = $0 }
    .onTapGesture(perform: add)
  }
}
