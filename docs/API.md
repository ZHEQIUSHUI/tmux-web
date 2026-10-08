# tmux-web 接口说明

给网页以外的客户端用：手机 App、Mac App、脚本等。所有路径都在 `/_tw/api/` 下面。请求和响应都是 JSON（客户端带 `Accept-Encoding: gzip` 时，超过 1KB 的响应会用 gzip 压缩）。

## 登录方式

- **API 令牌（给 App 和脚本用）**：在网页的「API 令牌」里创建。每个请求都带上：
  `Authorization: Bearer tw_...`
  令牌只显示一次，可以随时在同一个地方吊销。它的权限和创建它的账号一样。
- **浏览器 cookie**：`POST /_tw/api/login {"username","password"}` 会设置 `tw_sid` cookie（HttpOnly，30 天有效）。网页用的就是这种。

出错时返回 `{"error": "说明"}` 和对应的 HTTP 状态码（401 未登录、403 无权限、404 不存在、409 冲突、502 主机连不上）。

## 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `sessions` | 你能看到的会话列表（字段见下） |
| POST | `sessions` | 新建：`{agent: "claude"\|"codex"\|"bash", hostId, cwd, name?, args?, resumeId?, fork?, groupId?, share?}` |
| PATCH | `sessions/:id` | 修改 `{name?, note?, groupId?, share?}`（有操作权限的人都能改 `note`） |
| PUT | `sessions/:id/folder` | 放进你的某个文件夹：`{folderId \| null}` |
| DELETE | `sessions/:id` | 删除（导入的 tmux 会话只是取消接管，原会话不会被关掉） |
| POST | `sessions/:id/restart` | 重建整个 tmux 会话（导入的会话会迁移进 tmux-web） |
| POST | `sessions/:id/restart-agent` | 只重启 claude 进程并接着原来的对话。有后台任务在跑时返回 409，带 `{force: true}` 可以强制重启。Claude 重新起来后才返回 |

会话字段：`id, name, agent, cwd, hostId, host, owner, note, folderId, groupId, share, adopted, tmux, access ("view"|"control"), status, activityAt, title`。

`status`：`starting` 连接中 · `idle` 空闲 · `busy` 运行中 · `waiting` 等待你确认 · `offline` 主机连不上 · `dead` 已结束。

## 对话和输入

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `sessions/:id/messages?limit=30&before=<偏移>` | 从最新往前读：`{items, start, end, hasMore, log}`。要更早的，把 `start` 作为 `before` 传进来。`log` 是对话记录文件名，`/clear` 之后会变 |
| GET | `sessions/:id/message?off=<偏移>` | 被截断的条目的完整内容（条目 `id` 的格式是 `"<偏移>:<序号>"`） |
| GET | `sessions/:id/stream?from=<end>&log=<log>` | SSE：`msg`（新条目；事件 id 是记录文件的字节偏移，断线后用 `Last-Event-ID` 重连会从断点继续）、`state`（`{status, preview, mode, update, background, choices, suggestion}`）、`reset`（对话换了，比如 `/clear`，需要重新加载）、`ping` 心跳 |
| GET | `streams?s=<id>:<from>:<log>,…` | 多个会话共用一条 SSE 连接（事件同上，数据都包成 `{sid, data, end}`；没有权限或不存在的会话收到 `gone`）。没有事件 id：重连时自己带上已经读到的偏移 |
| GET | `sessions/:id/claude-state` | 模型、上下文用量、权限模式 |
| GET | `sessions/:id/image?off=<偏移>&n=<序号>&w=<宽度>` | 对话里嵌入的图片。消息里嵌入的 base64 图片会被替换成 `tw-img:<序号>`，`off` 是条目 `id` 的前半部分。带 `w` 时大图会压缩成适合这个宽度的 WebP |
| GET | `sessions/:id/file-image?path=<路径>&w=<宽度>` | 主机上的图片文件（相对路径从会话的工作目录算起；工作目录以外的路径需要操作权限；最大 20MB）。`w` 同上 |
| POST | `sessions/:id/input` | 发送文字并回车：`{text, submit?: true}` |
| POST | `sessions/:id/keys` | 发送按键：`{keys: ["Escape"]}`。允许的键：Enter Escape Tab BTab Up Down Left Right Space BSpace C-c C-d C-l y n 1–9 |
| POST | `sessions/:id/upload` | 上传文件（请求体是文件内容，文件名放在 `X-File-Name` 头里，需 URL 编码）。返回 `{path, rel, name, size}`，`rel` 是相对工作目录的路径 |
| WS | `sessions/:id/term` | 终端：服务端发来的二进制帧是终端原始输出（第一帧是屏幕快照），文本帧是 JSON（`hello`/`size`/`pong`）。客户端发二进制帧是按键，文本帧是 `{type:"resize",cols,rows}` / `{type:"ping"}` |

条目的 `role`：`user` · `assistant`（Markdown）· `tool`（`tool` 字段是工具名，或者 `result` / `error`）· `meta`（系统提示、命令等）。带 `truncated: true` 的条目可以再取完整内容。

## 文件（只读）

路径相对于会话的工作目录（`path` 为空就是工作目录本身）。只读权限的人只能访问工作目录里面；绝对路径、`~` 和 `..` 需要操作权限。

同样的接口也可以挂在主机下面用（全局文件浏览器）：把 `sessions/:id` 换成 `hosts/:id`。这时路径相对于主目录，允许绝对路径，能使用这台主机的人都能访问。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `sessions/:id/files?path=` | 列出目录：`{dir（绝对路径）, entries: [{name, type: "d"\|"f"\|"o", link, size, mtime}], truncated}` |
| GET | `sessions/:id/files/read?path=&offset=0&length=65536` | 读文件的一部分（原始字节，一次最多 1MB）；文件大小在响应头 `X-File-Size` 里 |
| GET | `sessions/:id/files/download?path=` | 下载整个文件 |
| GET | `sessions/:id/files/search?dir=&q=` | 在 `dir` 下面搜索文件名（最多 200 条；跳过 .git、node_modules 等） |
| GET | `sessions/:id/files/changes?dir=` | `dir` 所在 git 仓库里未提交的改动：`{root, cwd, files: [{path, status, from?, added?, removed?}]}`；不是 git 仓库时返回 `null` |
| GET | `sessions/:id/files/diff?dir=&path=` | 某个文件相对上次提交的差异（`path` 相对于仓库根目录；新文件显示为全部新增） |

## 通知（给 App 用）

由状态变化产生，服务端保留最近 200 条。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `notifications?after=<id>&limit=50` | 某个 id 之后的通知 |
| GET | `notifications/stream?after=<id>` | SSE，事件名 `notice`，事件 id 就是通知 id。用 `Last-Event-ID` 重连可以补上漏掉的。不带 `after` 时只推送新的 |

通知内容：`{id, at, sessionId, session, kind, title, text}`。`kind`：
- `waiting`：需要你确认（`text` 是屏幕上最后几行）
- `done`：任务完成（空闲满 3 秒才算完成；`text` 是最后一条回复的开头）
- `offline`：主机连不上
- `ended`：会话结束

会话列表本身也有实时推送：`GET events`（SSE：`sessions` 完整列表、`folders`、`status` `{id, status}`、`activity`；带 `?notices=1` 时通知也会以 `notice` 事件推送）。

## 其他

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `me` | 当前账号 |
| GET/POST/DELETE | `tokens`, `tokens/:id` | 列出 / 新建 `{name}`（响应里的 `token` 只出现这一次）/ 吊销 API 令牌 |
| GET/POST/PATCH/DELETE | `folders`, `folders/:id` | 你的文件夹 `{name, note, position}` |
| GET | `hosts`, `hosts/:id/dirs`, `hosts/:id/ports`, `hosts/:id/tmux`, `hosts/:id/claude-history` | 主机、目录建议、监听中的端口、已有的 tmux 会话、Claude 历史对话 |
| GET | `hosts/:id/stats` | 资源占用：CPU（采样半秒）、内存和交换分区、显卡（有 `nvidia-smi` 时）、磁盘、当前最占 CPU 的进程。结果缓存 2 秒 |
| GET | `app/version.json` | App 的最新版本信息（转发自 GitHub 最新 Release 的 version.json，缓存 10 分钟）。不需要登录 |
| GET | `app/download/<文件名>` | 下载最新版 App 的安装包（服务器从 GitHub 下载一次后缓存）。不需要登录 |
| POST | `hosts/:id/adopt` | 接管已有的 tmux 会话：`{name, socket?: "default"}` |

网页预览：`/p/<主机id>/<端口>/<路径>` 会转发到主机上的这个端口（HTTP 和 WebSocket 都支持），同样需要登录。
