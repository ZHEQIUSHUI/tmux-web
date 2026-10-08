# tmux-web for macOS

A shell App: it maintains an SSH port forward to the server's tmux-web and shows the page in its own window. The page content still comes from the server, so when the server updates, the App does too (if a refresh is needed, click ⟳ in the upper right or press ⌘R).

## Usage

1. Unzip `tmux-web-mac.zip` and drag `tmux-web.app` into "Applications".
2. On first launch, **right-click → Open** (no Apple developer signature, so macOS asks once).
3. Fill in the server settings:
   - **SSH target**: `user@host`, or an alias from `~/.ssh/config` (then port, jump host, and key all follow that config).
   - **tmux-web port on the server**: defaults to 8080.
   - **Local port**: defaults to 18080. It stays fixed so the page's login state and settings persist.
   - **SSH private key**: optional. Picking a public key `.pub` is fine too; the private key with the same name is used automatically.
   - **Other ssh options**: optional, e.g. `-J jump-host`.
4. Click "保存并连接". When a verification code or password is needed, a dialog pops up for you to enter it.

## Features

- Uses the system's `ssh`; `~/.ssh/config`, keys, `ssh-agent`, and `known_hosts` all apply.
- Reconnects automatically after a disconnect. Quitting the App or a crash takes the forward down with it; nothing lingers.
- The page's "waiting for confirmation / task done" alerts become **macOS system notifications** (when you aren't looking at the window); clicking one jumps to that session.
- File upload and download (into "Downloads") work, and "打开原图" opens a new window.
- Closing the window doesn't quit the App (notifications keep coming); click the Dock icon to bring it back. ⌘Q quits.
- The "服务器" menu holds the server list, reconnect, and edit (multiple servers are supported).

## Building (on a Mac)

```sh
xcode-select --install   # first time only
./build.sh               # → build/tmux-web.app, build/tmux-web-mac.zip (Apple silicon + Intel, macOS 13+)
```
