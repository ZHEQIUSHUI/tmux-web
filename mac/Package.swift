// swift-tools-version:5.9
// tmux-web for macOS: a window onto the tmux-web page, through an SSH port forward it keeps up.
import PackageDescription

let package = Package(
  name: "TmuxWeb",
  platforms: [.macOS(.v13)],
  targets: [.executableTarget(name: "TmuxWeb", path: "Sources/TmuxWeb")]
)
