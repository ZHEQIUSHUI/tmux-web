# tmux-web

一个面向弱网环境的多会话网页，用来驱动 Claude Code、Codex 等 agent 的 TUI。

- 左侧是会话列表（带运行中、等待确认、空闲、主机离线状态），右侧是**对话视图**（Markdown 渲染）和**终端视图**（xterm.js）
- 对话只加载最后 30 条，往上滚动时再按需加载更早的；生成过程中显示实时画面
- 大图片由服务端压缩成适合屏幕的 WebP 再发给浏览器（sharp），可以一键打开原图
- 对话记录保存在浏览器本地（IndexedDB，每个会话最近 400 条，最多 50 个会话），刷新或重开网页时立即显示，只补拉新增的部分；退出登录时清除
- 网页服务跑在 Docker 里，**tmux 和 agent 跑在宿主机上**：通过 SSH 执行，用的是宿主机自己的 tmux、claude、codex 和全部命令
- **文件**标签：浏览工作目录、查看文件（Markdown 渲染、大文件分段加载、看末尾）、搜索文件名、查看 git 改动和 diff、下载；可以复制路径，或者把 `@路径` 插入输入框发给 agent。只读
- **分屏**（电脑）：把左侧的会话拖到对话区，按落点上下或左右并排，最多 2×2；分隔线和左侧列表宽度都能拖动。分屏只是记在浏览器里的布局，会出现在「最近」里，随其中最近活跃的会话一起过期
- **全局文件浏览器**（侧边栏 / 手机首页顶部的文件图标）：浏览任意可用主机，从主目录开始，也可以进入根目录；可以在任意目录「在这里新建会话」
- 可以通过 SSH 管理**多台主机**；支持账号和分组
- 可以**导入主机上已有的 tmux 会话**：里面的程序不重启，你在本机照常 attach，网页上同时可见
- 手机端按终端 App 的方式设计：会话卡片列表、终端附加键栏（Ctrl/Alt/Esc/方向键/粘贴）、双指缩放字号，可以添加到主屏幕

## 快速开始

```bash
cat > .env <<EOF
ADMIN_PASSWORD=换成你的密码
HOST_USER=$(whoami)        # 会话以这个宿主机账号运行
EOF
docker compose up -d --build
docker compose logs        # 第一次启动时，日志里会打印需要添加的公钥
```

把日志里那行公钥加进 `HOST_USER` 的 `~/.ssh/authorized_keys`（网页「账号 → 主机」面板里也有一键复制的命令），然后打开 `http://<服务器>:8080`，用 admin 登录，在「主机」里点「检测」。

**务必放在 HTTPS 后面使用**（Caddy、Nginx、Cloudflare Tunnel 等）。这个网页能在你的主机上执行任意命令。

宿主机需要满足：

- 开着 sshd
- 装了 tmux（3.0 以上）
- 装了 claude 或 codex，并且已经登录。直接用你平时那份就行，由你自己更新

## 不用 Docker：直接在主机上运行（systemd）

如果主机的 sshd 不允许只用密钥登录（比如开了「公钥 + 密码」双因子），或者你本来就不想用 Docker，可以直接在主机上以普通用户运行。这种方式不经过 SSH，tmux 和 agent 以当前用户身份运行：

```bash
git clone https://github.com/ZHEQIUSHUI/tmux-web.git ~/tmux-web && cd ~/tmux-web
npm ci && npm run build
mkdir -p ~/.config/systemd/user && cp deploy/tmux-web.service ~/.config/systemd/user/
# 第一次启动时用环境变量创建管理员，之后可以在网页上修改密码
systemctl --user set-environment ADMIN_PASSWORD=换成你的密码
systemctl --user daemon-reload && systemctl --user enable --now tmux-web
systemctl --user unset-environment ADMIN_PASSWORD
loginctl enable-linger "$USER"   # 不登录也开机启动
```

服务文件里设置了 `KillMode=process`：重启或停止服务时只结束网页服务这一个进程，tmux 会话和里面的 agent 都会保留。升级时执行 `git pull && npm run build && systemctl --user restart tmux-web`。

## 原理

```
浏览器 ──HTTP/SSE/WebSocket──> 容器：网页服务（node + ssh 客户端）
                                   │ ssh HOST_USER@127.0.0.1（连接复用）
                                   ▼
                               宿主机：tmux -L tw（独立 socket，不影响你自己的 tmux）
                                   └─ claude / codex / bash（登录 shell，环境和你 SSH 上去一样）
```

- **实时输出**：每个会话有一条 `tmux -C`（control mode）长连接，输出实时推过来，不需要轮询。服务端用 `@xterm/headless` 镜像屏幕，用来判断状态、生成实时画面和终端快照。
- **对话记录**：在主机上读取 agent 的 JSONL 日志。打开会话时倒序读取最近 30 条，之后由主机上的 `tail -F` 推送新内容。SSE 的 event id 就是文件的字节偏移量，所以断线重连能从断点继续。
- **会话不怕重启**：
  - 重启、升级、重建容器：tmux 跑在宿主机上，会话不受任何影响
  - SSH 断开：自动重连
  - 主机离线：显示「主机离线」，恢复后自动重连
  - 主机重启导致 tmux 消失：自动重建会话，并用 `claude --resume` 或 `codex resume` 恢复对话
- **直接接管会话**：在宿主机上执行 `tmux -L tw attach -t tw-<会话id>`，就能和网页同时操作同一个会话。
- **体积**：首屏 JS 和 CSS 经 brotli 压缩后约 28KB。xterm.js（约 74KB）只在打开终端标签时才加载。

## 预览 agent 起的网页

agent 在主机上启动的网页（比如 `npm run dev` 监听在 5173），可以直接在会话的「预览」标签里打开：填入端口和路径（例如 `5173/docs`），或者点击自动列出的监听端口。请求由 tmux-web 转发：

- 本机直接连接；远端主机的端口则通过已有的 SSH 连接转发（`ssh -O forward`），不需要额外开放端口或配置穿透。
- 预览网页的地址是 `/p/<主机id>/<端口>/...`，同样受 tmux-web 的登录保护，可以点 ↗ 在新窗口打开。
- WebSocket 也会转发，所以 Vite、Next.js 等开发服务器的热更新可以用。
- 很多应用会使用 `/assets/...`、`/api/...` 这类绝对路径。tmux-web 会把它们转发给这个浏览器最近打开的那个端口（记录在 cookie 里），因此同一时间一个浏览器只能「激活」一个预览端口。tmux-web 自己的页面和接口都在 `/_tw/` 下面，不会和应用的路径冲突。
- 转发时会去掉 tmux-web 的登录 cookie，Host 头会改成 `localhost:<端口>`（开发服务器默认只接受 localhost）。为了能嵌入预览窗口，会去掉 `X-Frame-Options` 头。
- 注意：被预览的网页和 tmux-web 是同一个域名，网页里的脚本可以以你的身份调用 tmux-web 的接口。agent 自己写的网页没有问题，但不要用它来打开不可信的第三方网页。

## 多主机与账号

- 管理员可以在「主机」里添加其他机器（地址、端口、SSH 用户），把同一把公钥加进那台机器即可。主机可以设为「所有人可用」或「仅某个账号可用」。
- 新建会话时选择主机。会话可以共享给某个分组，权限分为只读和可操作两种。管理员可以看到所有会话。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / 无 | 数据库为空时用来创建第一个管理员 |
| `HOST_USER` | 无 | 第一台主机（本机）的 SSH 用户 |
| `SSH_HOST` / `SSH_PORT` | `127.0.0.1` / `22` | 第一台主机的地址 |
| `PORT` | `8080` | |
| `COOKIE_SECURE` | `auto` | `auto` 表示根据请求是否为 https（包括 `X-Forwarded-Proto`）决定 |
| `TRUST_PROXY` | `true` | 是否信任 `X-Forwarded-*` 头（用于限速时识别 IP 以及判断 https）|

`/data` 里保存 SQLite 数据库（账号、分组、主机、会话）和 SSH 私钥。SSH 私钥能登录你的主机，请保护好这个目录。如果想限制这把钥匙只能从本机使用，可以在 `authorized_keys` 里对应那一行前面加上 `from="127.0.0.1"`。

## 代码结构

```
src/server/          Node 服务（esbuild 打包成 dist/server.js）
  index.ts           HTTP 路由、SSE、WebSocket、启动流程
  sessions.ts        会话生命周期、导入 tmux、重启 Claude、活动时间、历史会话
  backend/tmux.ts    tmux 后端（control mode）；backend/types.ts 是可替换的接口
  host.ts            本机 / SSH 执行、文件读取、端口转发
  transcript.ts      解析 Claude Code / Codex 的 JSONL 对话记录（分页、跟随、状态）
  screen.ts          服务端终端镜像：运行状态、实时画面、权限模式、更新提示
  notify.ts          通知事件；proxy.ts 预览反向代理；auth.ts 登录与 API 令牌
src/web/             Preact 前端
  lib.ts             工具、主题、数据流（liveStream）    ui.tsx      图标、弹窗
  chat.tsx           对话视图、输入框、Claude 状态栏      lists.tsx   侧边栏、手机首页、文件夹、提醒
  chat-store.ts      对话记录的本地缓存（IndexedDB）      mermaid*.ts 流程图（按需加载）
  files-view.tsx     文件标签（浏览、查看、改动）          （服务端：src/server/files.ts）
  dialogs.tsx        新建会话、设置、账号、令牌等对话框    shell.tsx   整体布局与导航
  terminal-view.tsx  终端标签（xterm.js 按需加载）        preview.tsx 预览标签
test/                解析器、分页、屏幕识别等测试（npm test）
docs/API.md          给 App / 脚本用的接口说明
```

## 本地开发

```bash
npm install && npm run build
ADMIN_PASSWORD=test1234 DATA_DIR=.dev/data PORT=18080 npm start
```

不设置 `HOST_USER` 时，第一台主机是「本进程直接运行」，不经过 SSH。
