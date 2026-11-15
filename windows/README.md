# tmux-web 的 Windows App

一个「壳」App：它在后台维持到服务器的连接（直接访问、SSH 端口转发，或 App 内置的 EasyTier，可以同时连多台），在自己的窗口里打开 tmux-web 网页。网页内容还是由服务器提供，服务器上更新了网页，App 里也跟着更新（需要时点右上角的 ⟳ 或按 F5 刷新）。

## 使用

1. 下载 [tmux-web-windows.zip](https://github.com/ZHEQIUSHUI/tmux-web/releases/latest/download/tmux-web-windows.zip)，解压到自己的文件夹（比如「文档」里，不要放进 `C:\Program Files`，那里 App 没法自己更新），打开里面的 `tmux-web.exe`。
2. 第一次打开时 SmartScreen 可能提示「Windows 已保护你的电脑」（App 没有代码签名），点「更多信息 → 仍要运行」。
3. 首页选连接方式，填好后点「保存并连接」：
   - **直接访问**：已经能直接访问服务器时用（局域网、公网、已连上的 EasyTier），只填网址，比如 `http://10.126.126.2:8080`
   - **内置 EasyTier**：App 自己启动 EasyTier Core，不需要另外装 EasyTier。填网络名称、网络密钥、公共节点和服务器在 EasyTier 里的 IPv4 地址；它用 no-TUN 模式把一个本地端口转发到服务器上的 tmux-web，不装驱动，也不需要管理员权限
   - **SSH 转发**：用 Windows 自带的 OpenSSH 客户端（`ssh.exe`）做端口转发。填 `user@host`（或 `%USERPROFILE%\.ssh\config` 里的别名）、SSH 端口和服务器上 tmux-web 的端口；私钥、密码都可选，密码留空则需要时弹框输入
   - 填错的地方当场标红；「测试连接」先看看服务器通不通

需要 Windows 10 1809 或更新（64 位）。WebView2 运行时和 OpenSSH 客户端 Windows 10/11 一般都自带；缺 OpenSSH 时在「设置 → 应用 → 可选功能」里添加「OpenSSH 客户端」。

### 日常使用

- **首页**：每台服务器一张卡片，显示是否在线和延迟（自动检测）、上次使用时间，最近用过的排在前面，可以搜索。点卡片打开；⋯ 或右键可以编辑、复制一份、删除
- **多台同时连着**：打开过的服务器都保持连接，顶部一排标签，点一下切换，页面状态不丢；右键标签可以编辑或断开
- **工具栏**：▦ 回首页；右边 ⟳ 刷新网页（F5），⋯ 里有编辑此服务器、重新连接、在浏览器中打开、断开、私钥、检查更新、查看日志、退出
- **关掉窗口不退出**：App 留在右下角托盘里，连接和通知照常；点托盘图标回来，右键托盘图标可以退出。再次打开 `tmux-web.exe` 也会回到已经开着的窗口

## 功能

- 服务器配置、SSH 密码和 EasyTier 网络密钥用 Windows 的 DPAPI 加密保存，只有当前 Windows 账号能解开，不会弹框要密码
- 每台服务器的网页登录各自独立（每台一个 WebView2 配置），复制出来的服务器不会共用原来的登录
- 私钥统一登记在「私钥」里，多台服务器可以共用；能看类型和指纹、复制公钥。登录时交给 ssh 的是只有你能读的临时副本（Windows 的 ssh 不接受别人也能读的私钥），登录后立即删除
- 内置 EasyTier Core（v2.6.4，构建时下载并校验 SHA-256）：网络密钥只写进只有你能读的临时配置，不出现在进程参数里，断开时删除；断线自动重连
- 断线自动重连；App 退出或崩溃时，它启动的 ssh 和 EasyTier 都跟着关掉（Windows 作业对象），不会残留
- 网页的「等待确认 / 任务完成」提醒会变成 **Windows 通知**（只在你没看着那个页面时发），点通知直接跳到那个会话；等待确认时还会响一声并闪烁任务栏
- 下载文件（包括对话里 mermaid 图的「下载图片」）存到「下载」文件夹；网页里的外部链接用系统默认浏览器打开
- 跟随系统的浅色 / 深色模式
- 自动检查更新（启动后和每 6 小时，或 ⋯ →「检查更新」），通过你的 tmux-web 服务器下载，取不到时试 GitHub 和国内的 GitHub 加速（文件按 SHA-256 校验）；更新时自动替换并重新打开
- 出问题时 ⋯ →「查看日志」：`%LOCALAPPDATA%\TmuxWeb\tmux-web.log`

还没有的：Mac / 安卓版的「局域网共享配置」。

## 编译（在 Windows 上）

需要 Visual Studio 2022 或它的 Build Tools（带 MSBuild，用的是其中的 C# 编译器）和 .NET Framework 4.8（Windows 10/11 自带）。

```powershell
powershell -ExecutionPolicy Bypass -File windows\build.ps1
# → windows\build\tmux-web\（App 本体）、windows\build\tmux-web-windows.zip
```

`build.ps1` 会从 NuGet 下载 WebView2 SDK，从 GitHub 下载 EasyTier `v2.6.4` 的 Windows 版并校验 SHA-256，只取其中的 `easytier-core.exe`、`Packet.dll`、`wintun.dll`。网络受限时可以用 `EASYTIER_BASE_URL` 指向同一版本文件的镜像目录，或用 `EASYTIER_DIR` 指向已经装好的 EasyTier 2.6.4 目录。`VERSION` 环境变量设定版本号。EasyTier 以 LGPL-3.0 分发，许可证和第三方声明会一起放进 App，详见 `THIRD_PARTY_NOTICES.md`。

GitHub Actions 的 Apps 工作流在 `windows-2022` 上用同一个脚本构建，和 Mac、安卓版一起发布。
