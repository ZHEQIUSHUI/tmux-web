# tmux-web API

For clients other than the web page: the phone app, scripts, and so on. All paths are under `/_tw/api/`. Requests and responses are JSON (responses over 1KB are gzip-compressed when the client sends `Accept-Encoding: gzip`).

## Authentication

- **API token (for apps and scripts)**: create one in the web page under "API 令牌". Send it on every request:
  `Authorization: Bearer tw_...`
  The token is shown only once; revoke it any time from the same place. It has the same permissions as the account that created it.
- **Browser cookie**: `POST /_tw/api/login {"username","password"}` sets the `tw_sid` cookie (HttpOnly, valid for 30 days). The web page uses this.

Errors are returned as `{"error": "message"}` with the matching HTTP status code (401 not logged in, 403 no permission, 404 not found, 409 conflict, 502 host unreachable).

## Sessions

| Method | Path | Description |
|---|---|---|
| GET | `sessions` | List sessions visible to you (see the fields below) |
| POST | `sessions` | Create: `{agent: "claude"\|"codex"\|"bash", hostId, cwd, name?, args?, resumeId?, fork?, groupId?, share?}` |
| PATCH | `sessions/:id` | Change `{name?, note?, groupId?, share?}` (`note` can be changed by anyone with control access) |
| PUT | `sessions/:id/folder` | Move into one of your folders: `{folderId \| null}` |
| DELETE | `sessions/:id` | Delete (an imported tmux session only stops being adopted; the original session is not closed) |
| POST | `sessions/:id/restart` | Rebuild the whole tmux session (imported sessions are migrated into tmux-web) |
| POST | `sessions/:id/restart-agent` | Restart only the claude process and resume the conversation. Returns 409 when background tasks are running; send `{force: true}` to restart anyway |

Session fields: `id, name, agent, cwd, hostId, host, owner, note, folderId, groupId, share, adopted, tmux, access ("view"|"control"), status`.

`status`: `starting` connecting · `idle` · `busy` running · `waiting` waiting for your confirmation · `offline` host unreachable · `dead` ended.

## Conversation and input

| Method | Path | Description |
|---|---|---|
| GET | `sessions/:id/messages?limit=30&before=<offset>` | Read from newest backward: `{items, start, end, hasMore}`. For older items, pass `start` as `before` |
| GET | `sessions/:id/message?off=<offset>` | Full content of a truncated item (`id` is `"<offset>:<n>"`) |
| GET | `sessions/:id/stream?from=<end>` | SSE: `msg` (new items; the event id is the log byte offset, and reconnecting with `Last-Event-ID` resumes from the break), `state` (`{status, preview, mode, update, background}`), `reset` (conversation switched, e.g. `/clear`; reload), `ping` heartbeat |
| GET | `sessions/:id/claude-state` | Model, context usage, permission mode |
| GET | `sessions/:id/image?off=<offset>&n=<n>` | An image embedded in the conversation. In messages, embedded base64 images are replaced with `tw-img:<n>`, and `off` is the first part of the item `id` |
| GET | `sessions/:id/file-image?path=<path>` | An image file on the host (relative paths resolve from the session's working directory; paths outside it require control access; at most 20MB) |
| POST | `sessions/:id/input` | Send text and press Enter: `{text, submit?: true}` |
| POST | `sessions/:id/keys` | Send keys: `{keys: ["Escape"]}`. Allowed: Enter Escape Tab BTab Up Down Left Right Space BSpace C-c C-d C-l y n 1–9 |
| WS | `sessions/:id/term` | Terminal: server→client binary frames are raw terminal output (the first frame is a screen snapshot), text frames are JSON (`hello`/`size`/`pong`). Client→server: binary is keystrokes, text is `{type:"resize",cols,rows}` / `{type:"ping"}` |

Item `role`: `user` · `assistant` (Markdown) · `tool` (`tool` field is the tool name, or `result` / `error`) · `meta` (system notices, commands, etc.). An item with `truncated: true` can be fetched in full.

## Notifications (for apps)

Generated from status changes. The server keeps the last 200.

| Method | Path | Description |
|---|---|---|
| GET | `notifications?after=<id>&limit=50` | Notifications after a given id |
| GET | `notifications/stream?after=<id>` | SSE, event name `notice`, event id = notification id. Reconnect with `Last-Event-ID` to get the ones missed. Without `after`, only new notifications are pushed |

Notification: `{id, at, sessionId, session, kind, title, text}`. `kind`:
- `waiting`: needs your confirmation (`text` is the last few lines on screen)
- `done`: task finished (it counts as finished only after staying idle for 3 seconds; `text` is the beginning of the last reply)
- `offline`: host unreachable
- `ended`: session ended

The session list itself also has a live stream: `GET events` (SSE: `sessions` full list, `folders`, `status` `{id, status}`).

## Other

| Method | Path | Description |
|---|---|---|
| GET | `me` | Current account |
| GET/POST/DELETE | `tokens`, `tokens/:id` | List / create `{name}` (the response includes `token`, shown only this once) / revoke API tokens |
| GET/POST/PATCH/DELETE | `folders`, `folders/:id` | Your folders `{name, note, position}` |
| GET | `hosts`, `hosts/:id/dirs`, `hosts/:id/ports`, `hosts/:id/tmux`, `hosts/:id/claude-history` | Hosts, directory suggestions, listening ports, existing tmux sessions, Claude history conversations |
| POST | `hosts/:id/adopt` | Adopt an existing tmux session: `{name, socket?: "default"}` |

App preview: `/p/<hostId>/<port>/<path>` proxies to that port on the host (HTTP and WebSocket); it also requires login.
