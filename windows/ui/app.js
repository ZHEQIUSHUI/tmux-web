'use strict';
// The app's own screens: the toolbar, home, the connecting screen, and the dialogs. The C# side owns
// the state (servers, connections) and sends it whole on every change; we send back what was clicked.

const host = window.chrome && window.chrome.webview;
const post = (m) => host && host.postMessage(m);
let S = { profiles: [], conns: {}, order: [], probes: {}, keys: [], showHome: true, activeID: null, version: '' };
let query = '';
let modal = null; // { kind, ... } the open dialog
const waiting = new Map();
let reqN = 0;
/** a request whose answer comes back as a reply */
const ask = (m) =>
  new Promise((done) => {
    const req = ++reqN;
    waiting.set(req, done);
    post({ ...m, req });
  });

const $ = (sel, root = document) => root.querySelector(sel);
/** set only when it changed: a redraw between mouse down and up would lose the click */
function put(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- icons
const I = {
  home: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>',
  reload: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path d="M12 1.8v2.9H9.1"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  key: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.8 1.8M10 6l1.5 1.5" stroke-linecap="round"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  eye: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5l11-11" stroke-linecap="round"/></svg>',
  chev: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3l5 5-5 5"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--green)"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.6" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".9" fill="var(--bg)"/></svg>',
  errDot: '<svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v4.2" stroke="var(--bg)" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.3" r="1" fill="var(--bg)"/></svg>',
  minus: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M5 8h6" stroke-linecap="round"/></svg>',
  share: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2M5 4.8 8 2l3 2.8"/><path d="M4.5 7H3.5v7h9V7h-1"/></svg>',
  bolt: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1 3 9h4l-1 6 6-8H8z"/></svg>',
  network: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.3 2.2 3.3 4.7 3.3 7.5s-1 5.3-3.3 7.5c-2.3-2.2-3.3-4.7-3.3-7.5S7.7 4.7 10 2.5z"/></svg>',
  link: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/></svg>',
  shield: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.5 3.8 5v4.6c0 3.9 2.6 6.6 6.2 7.9 3.6-1.3 6.2-4 6.2-7.9V5z"/><rect x="7.4" y="9" width="5.2" height="4" rx=".8"/><path d="M8.4 9V7.8a1.6 1.6 0 0 1 3.2 0V9"/></svg>',
};

const MODES = {
  direct: { icon: I.network, bg: 'var(--teal)', title: '直接访问', text: '局域网、公网，或已经连上的 EasyTier 地址', welcome: '已经能直接打开服务器的地址：局域网、公网、已连上的 EasyTier' },
  easytier: { icon: I.link, bg: 'var(--blue)', title: '内置 EasyTier', text: 'App 自己加入网络，不用另开 EasyTier', welcome: 'App 自己启动 EasyTier，连进虚拟网络后打开网页' },
  ssh: { icon: I.shield, bg: 'var(--indigo)', title: 'SSH 转发', text: '通过 SSH 端口转发，不用开放端口', welcome: '通过 SSH 端口转发访问，服务器不用对外开放 tmux-web 的端口' },
};
const modeName = (p) => (p.mode === 'direct' ? '直接访问' : p.mode === 'easytier' ? '内置 EasyTier' : 'SSH 转发');

// ---------- the profile logic the dialogs need (the same rules as the C# side)
function directBase(url) {
  let s = (url || '').trim();
  if (!s) return null;
  if (!s.includes('://')) s = 'http://' + s;
  s = s.replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null;
    return s;
  } catch {
    return null;
  }
}
const peersOf = (t) => (t || '').split(/[,，;；\s]+/).filter(Boolean);
const validIPv4 = (t) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test((t || '').trim()) && (t || '').trim().split('.').every((x) => +x <= 255);
function validPeer(t) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:]+):(\d+)\/?$/i.exec(t);
  return !!m && +m[3] >= 1 && +m[3] <= 65535;
}
function titleOf(p) {
  const n = (p.name || '').trim();
  if (n) return n;
  if (p.mode === 'direct') {
    const b = directBase(p.directURL);
    try {
      return b ? new URL(b).hostname : p.directURL;
    } catch {
      return p.directURL;
    }
  }
  if (p.mode === 'easytier') return (p.easyTierServerIP || '').trim() || p.easyTierNetwork;
  return (p.target || '').trim();
}
const portOk = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

/** What a failure means and what to do about it, from ssh's or the network's words. */
function explain(raw, direct, easyTier) {
  const t = (raw || '').toLowerCase();
  if (easyTier && (t.includes('网络密钥') || t.includes('network secret'))) return ['EasyTier 连接失败', '检查网络名称、网络密钥和公共节点是否与服务器一致，并确认服务器虚拟 IP 填的是 tmux-web 机器在 EasyTier 里的地址。'];
  if (easyTier && (t.includes('timeout') || t.includes('超时'))) return ['EasyTier 连接超时', '确认公共节点可达、服务器也在同一个 EasyTier 网络里，并且 tmux-web 正在监听填写的端口。'];
  if (easyTier && (t.includes('connection refused') || t.includes('拒绝连接'))) return ['tmux-web 拒绝连接', 'EasyTier 的本地转发已经启动，但连不到服务器的 tmux-web：确认服务正在运行、端口填对了，且监听地址允许虚拟网络访问。'];
  if (easyTier && (t.includes('没有找到内置') || t.includes('无法启动 easytier'))) return ['EasyTier Core 不可用', '这个 App 没有可运行的 EasyTier Core：重新下载 App 后再试。'];
  if (t.includes('easytier')) return ['EasyTier 没有连上', '检查网络名称、网络密钥、公共节点和服务器虚拟 IP；下面的「详细信息」里有 Core 的输出。'];
  if (t.includes('invalid format') || t.includes('load key')) return ['私钥读不出来', 'ssh 认不出这个私钥文件的格式。确认它是完整的 OpenSSH 私钥（-----BEGIN … PRIVATE KEY----- 开头、-----END … PRIVATE KEY----- 结尾），PuTTY 的 .ppk 要先用 PuTTYgen 导出为 OpenSSH 格式。'];
  if (t.includes('permission denied') || t.includes('authentication')) return ['SSH 登录被拒绝', '检查用户名、密码或私钥。用私钥的话，确认服务器的 authorized_keys 里有对应的公钥。'];
  if (t.includes('could not resolve') || t.includes('找不到主机') || t.includes('no such host')) return ['找不到这台主机', '检查地址有没有拼错；用 EasyTier 等组网的话，确认它已经连上。'];
  if (t.includes('timed out') || t.includes('超时')) return ['连接超时', '服务器没有响应：检查网络、地址和端口，或者防火墙是不是挡住了。'];
  if (t.includes('connection refused') || t.includes('拒绝连接')) return [direct ? '服务器拒绝连接' : 'SSH 端口拒绝连接', direct ? '确认 tmux-web 正在运行，端口填对了。' : '确认 SSH 端口填对了，sshd 正在运行。'];
  if (t.includes('host key') || t.includes('identification has changed')) return ['服务器的主机密钥变了', '服务器重装过的话，在「编辑服务器 → 高级」里点「忘记主机密钥」后重试；否则可能有人冒充这台服务器。'];
  if (t.includes('已被占用')) return ['本地端口被占用', '换一个本地端口（编辑服务器 → 高级），或者关掉占用它的程序。'];
  if (t.includes('forwarding') || t.includes('open failed') || t.includes('administratively prohibited')) return ['端口转发失败', 'SSH 登录成功了，但转发不到 tmux-web：检查「服务器上 tmux-web 的端口」，以及服务器是否允许端口转发（AllowTcpForwarding）。'];
  if (t.includes('网页加载失败')) return ['网页没有打开', '连接已经建立，但页面加载失败：确认 tmux-web 正在运行，然后重试。'];
  if (t.includes('ssh.exe') || t.includes('openssh')) return ['没有 SSH 客户端', '在「设置 → 应用 → 可选功能」里添加「OpenSSH 客户端」，然后重试。'];
  if (t.includes('私钥') || t.includes('密钥')) return ['私钥有问题', '按下面的说明换一个私钥文件。'];
  return [direct ? '打不开这个地址' : easyTier ? 'EasyTier 没有连上' : '连不上服务器', direct ? '检查网址和端口，确认 tmux-web 正在运行。' : easyTier ? '检查 EasyTier 网络设置和服务器虚拟 IP；详细信息里有 Core 的输出。' : '看看下面的详细信息；需要的话编辑服务器设置后重试。'];
}

function relTime(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** a connection's color and words */
function connLook(c) {
  if (!c) return null;
  if (c.kind === 'ready') return c.pageLoaded ? ['green', '已连接'] : ['orange', '打开中'];
  if (c.kind === 'reconnecting') return ['orange', '重新连接中'];
  if (c.kind === 'failed') return ['red', '连接失败'];
  return ['orange', '连接中'];
}

const avatar = (p, cls = '') => {
  const t = titleOf(p).trim();
  return `<div class="avatar ${p.mode === 'direct' ? 'direct' : p.mode === 'easytier' ? 'easytier' : ''} ${cls}">${esc(t ? [...t][0].toUpperCase() : '+')}</div>`;
};

// ---------- toolbar

function renderBar() {
  const live = !S.showHome;
  const tabs = S.order
    .map((id) => S.profiles.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => {
      const look = connLook(S.conns[p.id]) || ['gray'];
      const on = !S.showHome && S.activeID === p.id;
      return `<button class="tab ${on ? 'on' : ''}" data-tab="${esc(p.id)}" title="${esc(titleOf(p))}"><i class="dot ${look[0]}"></i><span>${esc(titleOf(p))}</span></button>`;
    })
    .join('');
  const a = S.activeID && S.conns[S.activeID];
  const banner = !S.showHome && a && a.kind === 'reconnecting' && a.pageLoaded ? `<div class="banner"><span class="spin small"></span>${esc(a.text || '正在重新连接…')}</div>` : '';
  const upd = S.update ? `<button class="tb" data-act="showUpdate" title="有新版本 ${esc(S.update)}" style="color:var(--accent)">新版本</button>` : '';
  put($('#bar'), `
    <button class="tb ${S.showHome ? 'on' : ''}" data-act="home" title="全部服务器">${I.home}</button>
    ${tabs ? '<div class="sep"></div>' : ''}<div class="tabs">${tabs}</div>
    <div class="grow"></div>${banner}${upd}
    <button class="tb" data-act="reload" title="重新载入网页（F5）" ${live && a && a.pageLoaded ? '' : 'disabled'}>${I.reload}</button>
    <button class="tb" data-act="more" title="更多">${I.more}</button>`);
}

$('#bar').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) return post({ op: 'connect', id: t.dataset.tab });
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'home') post({ op: 'home' });
  else if (act === 'reload') post({ op: 'reload' });
  else if (act === 'showUpdate') openUpdate({ state: 'offer', version: S.update, notes: lastNotes });
  else if (act === 'more') {
    const r = b.getBoundingClientRect();
    post({ op: 'menu', x: r.right - 200, y: r.bottom + 2 });
  }
});
$('#bar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target.closest('[data-tab]');
  if (t) post({ op: 'tabMenu', id: t.dataset.tab, x: e.clientX, y: e.clientY });
});

// ---------- main area: home or a server's connecting screen

let elapsedTimer = null;

function renderMain() {
  clearInterval(elapsedTimer);
  const m = $('#main');
  if (S.showHome) return renderHome(m);
  const p = S.profiles.find((x) => x.id === S.activeID);
  const c = S.conns[S.activeID];
  if (!p || !c) return renderHome(m);
  if (c.live) {
    put(m, '');
    return;
  }
  renderConnecting(m, p, c);
}

function renderHome(m) {
  const keepFocus = document.activeElement && document.activeElement.id === 'q';
  const caret = keepFocus ? document.activeElement.selectionStart : 0;
  if (!S.profiles.length) {
    put(m, `<div class="welcome">
      <img src="icon.png" alt="">
      <div><h1>添加第一台服务器</h1><p>tmux-web 运行在你的服务器上，这个 App 打开它的网页。选择怎么连过去：</p></div>
      <div class="modes">${Object.entries(MODES)
        .map(([k, v]) => `<button class="mode" data-new="${k}"><div class="ic" style="background:${v.bg}">${v.icon}</div><b>${v.title}</b><span>${v.welcome}</span></button>`)
        .join('')}</div></div>`);
    return;
  }
  const q = query.trim().toLowerCase();
  const shown = q ? S.profiles.filter((p) => `${titleOf(p)} ${p.Address}`.toLowerCase().includes(q)) : S.profiles;
  const connected = S.profiles.filter((p) => S.conns[p.id]).length;
  const changed = put(m, `<div class="home">
    <div class="home-head">
      <div><h1>服务器</h1><div class="sub">${S.profiles.length} 台 · ${connected ? `${connected} 台已连接` : '点卡片打开'}</div></div>
      <div class="grow"></div>
      <label class="search">${I.search}<input id="q" placeholder="搜索名称或地址" value="${esc(query)}" spellcheck="false">${query ? `<button class="eye" data-clear style="width:20px;height:20px">${I.x}</button>` : ''}</label>
      <button class="btn" data-keys title="私钥统一登记在这里，多台服务器可以共用">${I.key}私钥</button>
      <button class="btn" data-share title="通过局域网把服务器和私钥交给另一台设备">${I.share}${S.share && S.share.running ? '正在共享' : '共享配置'}</button>
      <button class="btn primary" data-new="">${I.plus}新建服务器</button>
    </div>
    <div class="scroll" style="flex:1"><div class="grid">${shown.map(card).join('')}</div>${shown.length ? '' : `<div class="empty-search">没有找到「${esc(query)}」</div>`}</div>
    <div class="foot">tmux-web ${esc(S.version)} · <button class="link" data-act="checkUpdates">检查更新</button><span class="hint">关掉窗口后连接和通知照常，点右下角托盘图标回来</span></div>
  </div>`);
  if (keepFocus && changed) {
    const i = $('#q');
    i.focus();
    i.setSelectionRange(caret, caret);
  }
}

function probeHtml(pr) {
  if (!pr || pr.kind === 'checking') return '<span class="probe"><span class="spin small"></span>检测中</span>';
  if (pr.kind === 'online') return `<span class="probe"><i class="dot green"></i>在线 · ${pr.ms} ms</span>`;
  if (pr.kind === 'offline') return `<span class="probe" title="${esc(pr.text)}"><i class="dot gray"></i><span class="t">离线 · ${esc(pr.text)}</span></span>`;
  // can't tell from here (EasyTier, a jump host): the reason on hover
  return `<span class="probe" title="${esc(pr.text)}"><i class="dot gray" style="opacity:.5"></i><span class="t">${pr.text && pr.text.includes('EasyTier') ? '连接时检测' : esc(pr.text)}</span></span>`;
}

function card(p) {
  const c = S.conns[p.id];
  const look = connLook(c);
  return `<div class="card ${c ? 'used' : ''}" data-card="${esc(p.id)}">
    <div class="card-top">${avatar(p)}
      <div class="card-mid"><div class="card-name">${esc(titleOf(p))}</div><div class="card-addr" title="${esc(p.Address)}">${esc(p.Address)}</div></div>
      ${look ? `<span class="badge ${look[0]}"><i class="dot ${look[0]}"></i>${look[1]}</span>` : ''}
      <button class="tb more" data-cardmenu="${esc(p.id)}" title="编辑、复制、删除">${I.more}</button>
    </div>
    <div class="card-bottom">
      <span class="chip">${modeName(p)}</span>${probeHtml(S.probes[p.id])}
      ${p.lastUsed ? `<span class="when">上次使用 ${relTime(p.lastUsed)}</span>` : ''}
      <span class="acts">${c ? `<button class="btn small" data-disc="${esc(p.id)}">断开</button><button class="btn small primary" data-open="${esc(p.id)}">打开</button>` : `<button class="btn small primary" data-open="${esc(p.id)}">连接</button>`}</span>
    </div></div>`;
}

function cardMenu(id, x, y) {
  const p = S.profiles.find((q) => q.id === id);
  if (!p) return;
  const c = S.conns[id];
  showMenu(x, y, [
    [c ? '打开' : '连接', () => post({ op: 'connect', id })],
    c && ['断开', () => post({ op: 'disconnect', id })],
    '-',
    ['编辑…', () => openEditor({ id })],
    ['复制一份…', () => openEditor({ id, duplicate: true })],
    '-',
    ['删除…', () => confirmRemove(p), 'danger'],
  ]);
}

$('#main').addEventListener('click', (e) => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-new]'))) return openEditor({ mode: el.dataset.new || null });
  if (t.closest('[data-keys]')) return openKeys();
  if (t.closest('[data-share]')) return openShare();
  if (t.closest('[data-clear]')) {
    query = '';
    return renderMain();
  }
  if ((el = t.closest('[data-cardmenu]'))) {
    const r = el.getBoundingClientRect();
    return cardMenu(el.dataset.cardmenu, r.left, r.bottom + 4);
  }
  if ((el = t.closest('[data-disc]'))) return post({ op: 'disconnect', id: el.dataset.disc });
  if ((el = t.closest('[data-open]'))) return post({ op: 'connect', id: el.dataset.open });
  if ((el = t.closest('[data-act]'))) return act(el.dataset.act);
  if ((el = t.closest('[data-card]'))) return post({ op: 'connect', id: el.dataset.card });
});
$('#main').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-card]');
  e.preventDefault();
  if (el) cardMenu(el.dataset.card, e.clientX, e.clientY);
});
$('#main').addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    query = e.target.value;
    renderMain();
  }
});

function act(a) {
  if (a === 'checkUpdates') post({ op: 'checkUpdates' });
  else if (a === 'home') post({ op: 'home' });
  else if (a === 'retry') post({ op: 'retry' });
  else if (a === 'cancel') post({ op: 'disconnect', id: S.activeID });
  else if (a === 'editActive') openEditor({ id: S.activeID });
  else if (a === 'toggleDetails') {
    const d = $('.details pre');
    if (d) d.hidden = !d.hidden;
    const t = $('.details .toggle');
    if (t && d) t.classList.toggle('open', !d.hidden);
  }
}

function renderConnecting(m, p, c) {
  const failed = c.kind === 'failed';
  let body;
  if (failed) {
    const [title, hint] = explain(c.text, p.mode === 'direct', p.mode === 'easytier');
    body = `<div class="failure">
      <h3>${I.warn}${esc(title)}</h3><p>${esc(hint)}</p>
      <div class="details"><button class="toggle" data-act="toggleDetails">${I.chev}详细信息</button><pre hidden>${esc(c.text)}</pre></div>
      <div class="row-btns"><button class="btn" data-act="home">返回首页</button><button class="btn" data-act="editActive">编辑服务器…</button><button class="btn primary" data-act="retry">重试</button></div>
    </div>`;
  } else {
    const up = c.kind === 'ready';
    const step = (state, title, detail) =>
      `<div class="step ${state}"><div class="st">${state === 'done' ? I.check : state === 'running' ? '<span class="spin"></span>' : '<span class="ring"></span>'}</div><div><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div></div>`;
    const first = p.mode === 'direct' ? ['连接服务器', p.Address] : p.mode === 'easytier' ? ['启动 EasyTier 并连接', '不需要 TUN，也不用管理员权限'] : ['建立 SSH 连接和端口转发', '需要密码或验证码时会弹出对话框'];
    body = `<div class="steps">${step(up ? 'done' : 'running', first[0], first[1])}${step(up ? 'running' : 'waiting', '打开网页', up ? '正在加载 tmux-web…' : '')}</div>
      <div class="elapsed" id="elapsed"></div>
      <button class="btn" data-act="cancel">取消</button>`;
  }
  const changed = put(m, `<div class="connecting"><div class="cbox">
    <div class="who">${avatar(p).replace('class="avatar', 'style="width:60px;height:60px;font-size:26px;border-radius:16px" class="avatar')}<h2>${esc(titleOf(p))}</h2><div class="addr">${esc(p.Address)}</div></div>
    ${body}</div></div>`);
  if (!failed) {
    const tick = () => {
      const e = $('#elapsed');
      if (e) e.textContent = `已用 ${Math.max(0, Math.floor((Date.now() - c.started) / 1000))} 秒`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }
}

// ---------- menus on the home screen

function showMenu(x, y, items) {
  const el = $('#menu');
  el.innerHTML = items
    .filter(Boolean)
    .map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" class="${it[2] || ''}">${esc(it[0])}</button>`))
    .join('');
  el.hidden = false;
  const list = items.filter(Boolean);
  el.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    hideMenu();
    list[+b.dataset.i][1]();
  };
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
}
function hideMenu() {
  $('#menu').hidden = true;
}
addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) hideMenu();
});
addEventListener('blur', hideMenu);

// ---------- dialogs

function setModal(html) {
  const el = $('#modal');
  const was = !!el.innerHTML;
  // a re-render of the same dialog keeps where it was scrolled to (else it jumps to the top
  // and back on every key or click: a flicker)
  const scrolled = [...el.querySelectorAll('.dlg-body')].map((b) => b.scrollTop);
  // the pop-in animation is for opening only: a redraw of an open dialog (every key, every
  // click) would play it again and the dialog would blink
  el.classList.toggle('still', was && !!html);
  el.innerHTML = html;
  el.querySelectorAll('.dlg-body').forEach((b, i) => {
    if (scrolled[i]) b.scrollTop = scrolled[i];
  });
  const now = !!html;
  if (was !== now) post({ op: 'overlay', on: now });
}
function closeModal() {
  modal = null;
  setModal('');
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#menu').hidden) return hideMenu();
    if (modal && modal.kind !== 'updating') {
      e.preventDefault();
      closeModal();
    }
  }
  if (e.key === 'F5' && !S.showHome) {
    e.preventDefault();
    post({ op: 'reload' });
  }
});

function confirmBox(title, text, okText, danger) {
  return new Promise((done) => {
    modal = { kind: 'confirm' };
    setModal(`<div class="dlg narrow"><div class="dlg-body"><h2 style="margin:0;font-size:17px">${esc(title)}</h2><div>${esc(text)}</div></div>
      <div class="dlg-foot"><div class="msg"></div><button class="btn" data-no>取消</button><button class="btn primary ${danger ? 'danger-p' : ''}" data-yes>${esc(okText)}</button></div></div>`);
    const el = $('#modal');
    el.onclick = (e) => {
      if (e.target.closest('[data-yes]')) {
        closeModal();
        done(true);
      } else if (e.target.closest('[data-no]') || e.target === el) {
        closeModal();
        done(false);
      }
    };
    $('[data-yes]', el).focus();
  });
}

async function confirmRemove(p) {
  const ok = await confirmBox(`删除「${titleOf(p)}」？`, S.conns[p.id] ? '它会先断开。设置和保存的密码都会删掉。' : '它的设置和保存的密码都会删掉。', '删除', true);
  if (ok) post({ op: 'remove', id: p.id });
}

// ---------- the server editor

async function openEditor(o) {
  const r = await ask({ op: 'draft', id: o.id || null, mode: o.mode || null, duplicate: !!o.duplicate });
  showEditor(r);
}

function showEditor(r) {
  const d = r.profile;
  // a list saved with commas: a row per node
  d.easyTierPeers = peersOf(d.easyTierPeers).join('\n');
  modal = { kind: 'editor', d, isNew: r.isNew, password: r.password || '', taken: r.taken || {}, showPw: false, showSecret: false, advanced: false, test: null, keyMsg: null };
  renderEditor();
}

function edErrors(m) {
  const d = m.d;
  const e = {};
  if ((d.directURL || '').trim() && !directBase(d.directURL)) e.url = '网址不对，比如 http://10.126.126.2:8080';
  if ((d.target || '').trim().includes(' ')) e.target = '不能有空格；端口填在下面';
  if (!(d.easyTierNetwork || '').trim()) e.network = '填写 EasyTier 网络名称';
  const ip = (d.easyTierServerIP || '').trim();
  e.ip = !ip ? '填写服务器的 EasyTier 虚拟 IP' : validIPv4(ip) ? null : '要填 IPv4 地址，比如 10.144.144.30';
  const peers = peersOf(d.easyTierPeers);
  e.peers = !peers.length ? '至少填一个公共节点' : peers.find((x) => !validPeer(x)) ? `格式不对：${peers.find((x) => !validPeer(x))}` : null;
  for (const k of ['sshPort', 'remotePort', 'localPort']) if (!portOk(d[k])) e[k] = '端口在 1–65535 之间';
  if (d.mode !== 'direct' && m.taken[String(d.localPort)]) e.taken = `「${m.taken[String(d.localPort)]}」也用这个本地端口，换一个`;
  const key = S.keys.find((k) => k.id === d.keyID);
  if (key && !key.exists) e.key = `找不到私钥文件 ${key.path}，在「私钥」里更换`;
  return e;
}

function edComplete(d) {
  if (d.mode === 'direct') return !!directBase(d.directURL);
  if (d.mode === 'easytier') return !!(d.easyTierNetwork || '').trim() && validIPv4(d.easyTierServerIP) && peersOf(d.easyTierPeers).length > 0 && d.remotePort > 0 && d.localPort > 0;
  return !!(d.target || '').trim() && d.remotePort > 0 && d.localPort > 0;
}

function edCanSave(m) {
  const d = m.d;
  const e = edErrors(m);
  if (!edComplete(d)) return false;
  if (d.mode === 'direct') return !e.url;
  if (d.mode === 'easytier') return !e.network && !e.ip && !e.peers && !e.remotePort && !e.localPort && !e.taken;
  return !e.target && !e.key && !e.taken && !e.sshPort && !e.remotePort && !e.localPort;
}

function row(label, control, note, error) {
  return `<div class="frow"><label>${esc(label)}</label><div class="fc">${control}${error ? `<div class="err">${I.errDot}${esc(error)}</div>` : note ? `<div class="note">${esc(note)}</div>` : ''}</div></div>`;
}
const text = (k, v, ph, extra = '') => `<input class="field" data-k="${k}" value="${esc(v)}" placeholder="${esc(ph)}" spellcheck="false" ${extra}>`;
const num = (k, v) => `<input class="field num" data-k="${k}" data-num value="${Number.isFinite(v) ? v : ''}" inputmode="numeric">`;

function renderEditor(focusKey) {
  const m = modal;
  if (!m || m.kind !== 'editor') return;
  const d = m.d;
  const e = edErrors(m);
  const active = document.activeElement;
  const fk = focusKey || (active && active.dataset && active.dataset.k);
  const caret = active && 'selectionStart' in active ? active.selectionStart : null;
  const modes = Object.entries(MODES)
    .map(([k, v]) => `<button class="mode ${d.mode === k ? 'on' : ''}" data-mode="${k}"><div class="ic" style="background:${v.bg}">${v.icon}</div><b>${v.title}</b><span>${v.text}</span></button>`)
    .join('');
  let server = row('名称', text('name', d.name, '比如「工作站」'), d.name ? null : '不填就用地址');
  if (d.mode === 'direct') server += row('网址', text('directURL', d.directURL, 'http://10.126.126.2:8080'), null, e.url);
  else if (d.mode === 'easytier') {
    server += row('服务器虚拟 IP', text('easyTierServerIP', d.easyTierServerIP, '10.144.144.30'), 'tmux-web 这台机器在 EasyTier 网络里的 IPv4 地址', e.ip);
    server += row('tmux-web 端口', num('remotePort', d.remotePort), '服务器上 tmux-web 监听的端口', e.remotePort);
  } else {
    server += row('SSH 目标', text('target', d.target, 'user@host'), 'user@host，或 %USERPROFILE%\\.ssh\\config 里的别名', e.target);
    server += row('SSH 端口', num('sshPort', d.sshPort), null, e.sshPort);
    server += row('tmux-web 端口', num('remotePort', d.remotePort), '服务器上 tmux-web 监听的端口', e.remotePort);
  }
  let more = '';
  const adv = (rows) =>
    `<div class="group"><button class="toggle ${m.advanced || e.taken ? 'open' : ''}" data-adv>${I.chev}高级</button>${m.advanced || e.taken ? `<div class="box" style="margin-top:10px">${rows}</div>` : ''}</div>`;
  if (d.mode === 'easytier') {
    const rows = (d.easyTierPeers || '').split('\n');
    if (!rows.length) rows.push('');
    const peers =
      rows
        .map(
          (v, i) =>
            `<div class="inline"><input class="field" data-peer="${i}" value="${esc(v)}" placeholder="tcp://public.example.com:11010" spellcheck="false"><button class="eye" data-unpeer="${i}" title="去掉这个节点" style="${rows.length > 1 ? '' : 'visibility:hidden'}">${I.minus}</button></div>`,
        )
        .join('') + `<button class="link" data-addpeer style="align-self:flex-start;font-size:13px">＋ 添加节点</button>`;
    more += `<div class="group"><h4>EasyTier 网络</h4><div class="box">
      ${row('网络名称', text('easyTierNetwork', d.easyTierNetwork, 'my-network'), '和 EasyTier 客户端里填的 Network Name 一致', e.network)}
      ${row('网络密钥', `<div class="inline">${text('easyTierSecret', d.easyTierSecret, '可留空', `type="${m.showSecret ? 'text' : 'password'}"`)}<button class="eye" data-eye="showSecret" title="${m.showSecret ? '隐藏' : '显示'}网络密钥">${m.showSecret ? I.eyeOff : I.eye}</button></div>`, '只写入仅你自己能读的临时配置，不出现在进程参数里')}
      ${row('公共节点', peers, '一行一个；多填几个，一个不通时还能用别的', e.peers)}
    </div></div>`;
    more += adv(row('本地端口', num('localPort', d.localPort), '网页登录状态属于这个端口；换一台服务器就用另一个端口', e.taken || e.localPort));
  } else if (d.mode === 'ssh') {
    const key = S.keys.find((k) => k.id === d.keyID);
    const keyNote = m.keyMsg && m.keyMsg.id === d.keyID ? m.keyMsg.text : key ? `${key.path} · 在「私钥」里统一管理` : '私钥统一登记在「私钥」里，多台服务器可以共用';
    const opts = `<option value="">不指定（用 .ssh\\config 和默认密钥）</option>` + S.keys.map((k) => `<option value="${esc(k.id)}" ${k.id === d.keyID ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
    more += `<div class="group"><h4>登录</h4><div class="box">
      ${row('私钥', `<div class="inline"><select class="field" data-key>${opts}</select><button class="btn small" data-addkey title="登记一个私钥文件，并给这台服务器用">添加…</button></div>`, keyNote, e.key)}
      ${row('密码', `<div class="inline"><input class="field" data-pw value="${esc(m.password)}" placeholder="可选" type="${m.showPw ? 'text' : 'password'}"><button class="eye" data-eye="showPw" title="${m.showPw ? '隐藏' : '显示'}密码">${m.showPw ? I.eyeOff : I.eye}</button></div>`, '可选，加密保存在本机；不填则需要时弹框输入')}
    </div></div>`;
    more += adv(
      row('本地端口', num('localPort', d.localPort), '每台服务器一个固定端口，网页的登录状态才能保留', e.taken || e.localPort) +
        row('远端地址', text('remoteHost', d.remoteHost, '127.0.0.1'), 'tmux-web 在服务器看来的地址，一般不用改') +
        row('其他 ssh 参数', text('extraArgs', d.extraArgs, '可选'), '比如 -J 跳板机') +
        row('主机密钥', `<div class="inline"><button class="btn small" data-forget ${(d.target || '').trim() ? '' : 'disabled'}>忘记主机密钥</button></div>`, m.forgetMsg || '服务器重装过、连接时提示主机密钥变了，点这里后重新连接'),
    );
  }
  const t = m.test;
  const testHtml = !t
    ? ''
    : t.kind === 'checking'
      ? '<span class="probe"><span class="spin small"></span>测试中…</span>'
      : t.kind === 'online'
        ? `<span class="ok">✓ ${d.mode === 'direct' ? `tmux-web 有响应 · ${t.ms} ms` : `SSH 端口能连上 · ${t.ms} ms（登录在连接时验证）`}</span>`
        : t.kind === 'offline'
          ? `<span class="bad-t">✕ 连不上：${esc(t.text)}</span>`
          : `<span class="small-dim">${esc(t.text)}，没法提前测试，连接时就知道了</span>`;
  const can = edCanSave(m);
  setModal(`<div class="dlg">
    <div class="dlg-head">${avatar(d)}<div style="min-width:0"><h2>${m.isNew ? '新建服务器' : '编辑服务器'}</h2><div class="sub">${esc(titleOf(d) || '选好连接方式，填上地址')}</div></div></div>
    <div class="dlg-body">
      <div class="modes">${modes}</div>
      <div class="group"><h4>服务器</h4><div class="box">${server}</div></div>
      ${more}
      <div class="test"><button class="btn" data-test ${edComplete(d) && (!t || t.kind !== 'checking') ? '' : 'disabled'}>${I.bolt}测试连接</button>${testHtml}</div>
    </div>
    <div class="dlg-foot">
      ${m.isNew ? '' : '<button class="btn quiet danger" data-del>删除服务器…</button>'}
      <div class="msg"></div>
      <button class="btn" data-cancel>取消</button>
      <button class="btn" data-save ${can ? '' : 'disabled'}>保存</button>
      <button class="btn primary" data-go ${can ? '' : 'disabled'}>保存并连接</button>
    </div></div>`);
  const el = $('#modal');
  if (fk) {
    const f = el.querySelector(`[data-k="${fk}"]`) || (fk.startsWith('peer') && el.querySelector(`[data-peer="${fk.slice(4)}"]`)) || (fk === 'pw' && el.querySelector('[data-pw]'));
    if (f) {
      f.focus({ preventScroll: true });
      if (caret != null && f.setSelectionRange && f.type !== 'number') try { f.setSelectionRange(caret, caret); } catch {}
    }
  }
}

$('#modal').addEventListener('input', (e) => {
  const m = modal;
  if (!m || m.kind !== 'editor') return;
  const t = e.target;
  if (t.dataset.k) {
    const k = t.dataset.k;
    if (t.dataset.num !== undefined) {
      const v = t.value.replace(/\D/g, '');
      m.d[k] = v ? parseInt(v, 10) : NaN;
    } else m.d[k] = t.value;
    m.test = null;
    rerenderKeep(t, k);
  } else if (t.dataset.peer !== undefined) {
    const i = +t.dataset.peer;
    const rows = (m.d.easyTierPeers || '').split('\n');
    const parts = t.value.split(/[,，;；\s]+/);
    if (parts.length > 1) {
      // a pasted list ("a, b"): a row per node, and an empty row after a trailing separator
      const nodes = parts.filter(Boolean);
      if (parts[parts.length - 1] === '' || !nodes.length) nodes.push('');
      rows.splice(i, 1, ...nodes);
      m.d.easyTierPeers = rows.join('\n');
      renderEditor('peer' + (i + nodes.length - 1));
      return;
    }
    rows[i] = t.value;
    m.d.easyTierPeers = rows.join('\n');
    rerenderKeep(t, 'peer' + i);
  } else if (t.dataset.pw !== undefined) {
    m.password = t.value;
  }
});

/** re-render around the field being typed in, without losing its focus and caret */
function rerenderKeep(t, key) {
  const caret = t.selectionStart;
  renderEditor(key);
  const f = document.activeElement;
  if (f && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch {}
}

$('#modal').addEventListener('change', (e) => {
  const m = modal;
  if (!m || m.kind !== 'editor') return;
  if (e.target.dataset.key !== undefined) {
    m.d.keyID = e.target.value || null;
    renderEditor();
  }
});

$('#modal').addEventListener('keydown', (e) => {
  const m = modal;
  if (!m || m.kind !== 'editor' || e.key !== 'Enter') return;
  if (e.target.dataset.peer !== undefined) {
    e.preventDefault();
    addPeer();
  } else if (e.target.tagName === 'INPUT' && edCanSave(m)) {
    e.preventDefault();
    save(true);
  }
});

function addPeer() {
  const m = modal;
  const rows = (m.d.easyTierPeers || '').split('\n');
  if ((rows[rows.length - 1] || '').trim()) rows.push('');
  m.d.easyTierPeers = rows.join('\n');
  renderEditor('peer' + (rows.length - 1));
}

function cleaned(d) {
  const p = {};
  for (const k of ['id', 'name', 'mode', 'directURL', 'easyTierNetwork', 'easyTierSecret', 'easyTierPeers', 'easyTierServerIP', 'target', 'sshPort', 'remoteHost', 'remotePort', 'localPort', 'keyID', 'extraArgs', 'lastUsed']) p[k] = d[k];
  for (const k of ['name', 'target', 'directURL', 'easyTierNetwork', 'easyTierServerIP', 'remoteHost']) p[k] = (p[k] || '').trim();
  p.easyTierPeers = peersOf(p.easyTierPeers).join('\n');
  if (!p.remoteHost) p.remoteHost = '127.0.0.1';
  return p;
}

function save(go) {
  const m = modal;
  post({ op: 'save', profile: cleaned(m.d), password: m.d.mode === 'ssh' ? m.password : '', connect: go });
  closeModal();
}

$('#modal').addEventListener('click', async (e) => {
  const m = modal;
  if (!m || m.kind !== 'editor') return;
  const t = e.target;
  let el;
  if ((el = t.closest('[data-mode]'))) {
    m.d.mode = el.dataset.mode;
    m.test = null;
    return renderEditor();
  }
  if ((el = t.closest('[data-eye]'))) {
    m[el.dataset.eye] = !m[el.dataset.eye];
    return renderEditor(el.dataset.eye === 'showPw' ? 'pw' : 'easyTierSecret');
  }
  if (t.closest('[data-adv]')) {
    m.advanced = !m.advanced;
    return renderEditor();
  }
  if (t.closest('[data-addpeer]')) return addPeer();
  if (t.closest('[data-forget]')) {
    const r = await ask({ op: 'forgetHostKey', target: m.d.target, port: m.d.sshPort });
    if (modal !== m) return;
    m.forgetMsg = r.error || r.text;
    return renderEditor();
  }
  if ((el = t.closest('[data-unpeer]'))) {
    const rows = (m.d.easyTierPeers || '').split('\n');
    if (rows.length > 1) rows.splice(+el.dataset.unpeer, 1);
    m.d.easyTierPeers = rows.join('\n');
    return renderEditor();
  }
  if (t.closest('[data-addkey]')) {
    const path = await ask({ op: 'pickKey' });
    if (!path) return;
    const r = await ask({ op: 'addKey', path });
    if (modal !== m) return;
    if (r.error) {
      m.keyMsg = null;
      await alertBox('不能用这个文件', r.error);
      return;
    }
    m.d.keyID = r.id;
    m.keyMsg = { id: r.id, text: r.known ? `这个文件已经登记过，选的是「${r.name}」` : `已登记为「${r.name}」，别的服务器也可以选它` };
    return renderEditor();
  }
  if (t.closest('[data-test]')) {
    m.test = { kind: 'checking' };
    renderEditor();
    const r = await ask({ op: 'test', profile: cleaned(m.d) });
    if (modal !== m) return;
    m.test = r;
    return renderEditor();
  }
  if (t.closest('[data-cancel]')) return closeModal();
  if (t.closest('[data-save]')) return save(false);
  if (t.closest('[data-go]')) return save(true);
  if (t.closest('[data-del]')) {
    const p = S.profiles.find((x) => x.id === m.d.id);
    closeModal();
    if (p) confirmRemove(p);
  }
});

function alertBox(title, msg) {
  const back = modal;
  const html = $('#modal').innerHTML;
  return new Promise((done) => {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;padding:24px';
    layer.innerHTML = `<div class="dlg narrow"><div class="dlg-body"><h2 style="margin:0;font-size:17px">${esc(title)}</h2><div>${esc(msg)}</div></div><div class="dlg-foot"><div class="msg"></div><button class="btn primary">好</button></div></div>`;
    document.body.appendChild(layer);
    if (!html) post({ op: 'overlay', on: true });
    layer.querySelector('button').onclick = () => {
      layer.remove();
      if (!html && !back) post({ op: 'overlay', on: false });
      done();
    };
    layer.querySelector('button').focus();
  });
}

// ---------- the key list

function openKeys() {
  modal = { kind: 'keys', msg: null, info: {} };
  renderKeys();
}

async function loadInfo(k) {
  const m = modal;
  const r = await ask({ op: 'keyInfo', id: k.id });
  if (modal !== m || !m) return;
  m.info[k.id + '|' + k.path] = r || { problem: '读取失败' };
  const el = document.querySelector(`[data-info="${CSS.escape(k.id)}"]`);
  if (el) el.outerHTML = infoLine(k);
}

function infoLine(k) {
  const m = modal;
  const i = m.info[k.id + '|' + k.path];
  let t;
  if (!k.exists) t = `<span style="color:var(--red)">找不到文件 ${esc(k.path)}</span>`;
  else if (!i) t = '<span style="opacity:.6">正在读取…</span>';
  else if (i.problem) t = esc(i.problem);
  else t = `${esc(i.type)} · ${esc(i.fingerprint)}`;
  return `<div class="mono" data-info="${esc(k.id)}">${t}</div>`;
}

function renderKeys() {
  const m = modal;
  if (!m || m.kind !== 'keys') return;
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.kname;
  const list = S.keys.length
    ? `<div class="keys">${S.keys
        .map(
          (k) => `<div class="key"><div class="kic">${I.key}</div><div class="kmid">
          <input class="kname" data-kname="${esc(k.id)}" value="${esc(k.name)}" spellcheck="false">
          <div class="mono" title="${esc(k.file)}">${esc(k.path)}</div>${infoLine(k)}
          <div class="small-dim">${k.users.length ? `${k.users.length} 台在用：${esc(k.users.join('、'))}` : '还没有服务器在用'}</div></div>
          <button class="tb" data-kmenu="${esc(k.id)}">${I.more}</button></div>`,
        )
        .join('')}</div>`
    : `<div class="empty-keys"><div style="opacity:.4">${I.key.replace('width="15" height="15"', 'width="40" height="40"')}</div><b>还没有私钥</b><div>不登记也行：不选私钥的服务器照常用 .ssh\\config 和默认密钥。</div><button class="btn" data-kadd style="margin-top:6px">${I.plus}添加私钥…</button></div>`;
  setModal(`<div class="dlg" style="max-width:620px">
    <div class="dlg-head"><div class="avatar" style="background:var(--orange-g)">${I.key}</div><div style="min-width:0"><h2>私钥</h2><div class="sub">登记一次，编辑服务器时选它；多台服务器可以共用，在这里改了都跟着变</div></div></div>
    <div class="dlg-body" style="min-height:240px">${list}</div>
    <div class="dlg-foot">${S.keys.length ? `<button class="btn" data-kadd>${I.plus}添加私钥…</button>` : ''}<div class="msg">${esc(m.msg || '')}</div><button class="btn primary" data-kdone>完成</button></div></div>`);
  for (const k of S.keys) if (k.exists && !m.info[k.id + '|' + k.path]) loadInfo(k);
  if (focused) {
    const f = document.querySelector(`[data-kname="${CSS.escape(focused)}"]`);
    if (f) f.focus({ preventScroll: true });
  }
}

$('#modal').addEventListener('click', async (e) => {
  const m = modal;
  if (!m || m.kind !== 'keys') return;
  const t = e.target;
  let el;
  if (t.closest('[data-kdone]')) return closeModal();
  if (t.closest('[data-kadd]')) {
    const path = await ask({ op: 'pickKey' });
    if (!path) return;
    const r = await ask({ op: 'addKey', path });
    m.msg = r.error ? r.error : r.known ? `这个文件已经登记过了：「${r.name}」` : null;
    return renderKeys();
  }
  if ((el = t.closest('[data-kmenu]'))) {
    const id = el.dataset.kmenu;
    const k = S.keys.find((x) => x.id === id);
    const r = el.getBoundingClientRect();
    showMenu(r.right - 180, r.bottom + 4, [
      ['复制公钥', async () => {
        const x = await ask({ op: 'copyPublic', id });
        m.msg = x.error || '公钥已复制，加到服务器的 ~/.ssh/authorized_keys 里';
        renderKeys();
      }],
      k.exists && ['在资源管理器中显示', () => post({ op: 'reveal', id })],
      ['更换文件…', async () => {
        const path = await ask({ op: 'pickKey', title: `为「${k.name}」选择新的私钥文件` });
        if (!path) return;
        const x = await ask({ op: 'replaceKey', id, path });
        m.msg = x.error || '已更换，用它的服务器下次连接时生效';
        renderKeys();
      }],
      '-',
      ['删除…', async () => {
        const used = k.users;
        const ok = await confirmBox(`删除「${k.name}」？`, (used.length ? `${used.map((u) => `「${u}」`).join('、')}正在用它，删掉后${used.length === 1 ? '这台服务器' : '这些服务器'}改用 .ssh\\config 和默认密钥。` : '') + '只是从列表里去掉，文件本身不会删除。', '删除', true);
        if (ok) post({ op: 'removeKey', id });
        openKeys();
      }, 'danger'],
    ]);
  }
});
$('#modal').addEventListener('change', (e) => {
  if (!modal || modal.kind !== 'keys') return;
  const id = e.target.dataset.kname;
  if (id) post({ op: 'renameKey', id, name: e.target.value.trim() || '未命名' });
});

// ---------- LAN config sharing (the same protocol as the Mac and Android apps)

function openShare(tab) {
  modal = {
    kind: 'share',
    tab: tab || 0,
    pushlink: '',
    pushing: false,
    pusherr: null,
    pushed: null,
    sel: new Set(S.profiles.map((p) => p.id)),
    keys: new Set(S.keys.map((k) => k.id)),
    port: '48620',
    password: '',
    passphrase: '',
    err: null,
    host: '',
    rport: '48620',
    rpassword: '',
    busy: false,
    rerr: null,
    done: null,
  };
  renderShare();
}

function check(on) {
  return `<span class="check ${on ? 'on' : ''}">${on ? '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>' : ''}</span>`;
}

function renderShare(focus) {
  const m = modal;
  if (!m || m.kind !== 'share') return;
  const active = document.activeElement;
  const fk = focus || (active && active.dataset && active.dataset.s);
  const caret = active && 'selectionStart' in active ? active.selectionStart : null;
  const sh = S.share || {};
  let body;
  if (m.tab === 0 && sh.running) {
    const addrs = sh.addresses || [];
    body = `<div class="share-ok"><span>${I.check}</span><b>共享已开始</b><span class="small-dim" style="margin-left:auto">${sh.profileCount} 个服务器 · ${sh.keyCount} 把私钥</span></div>
      ${sh.link ? `<div class="qr-row"><div class="qr">${QR.svg(sh.link, 190)}</div><div class="qr-text">
        <b>用手机扫码</b>
        <div>在手机上打开 tmux-web App → 共享配置 → 从其他设备获取 → 扫码导入，对准左边的二维码。</div>
        <div class="small-dim">另一台电脑：复制共享链接，粘贴到它的「对方 IP」一栏。</div>
        <div><button class="btn small" data-copy="${esc(sh.link)}">复制共享链接（含密码）</button></div></div></div>` : ''}
      <div>也可以在对方那里手动填地址、端口和刚才设置的密码。</div>
      <div class="addrs"><div class="small-dim" style="font-weight:600">本机地址</div>${
        addrs.length
          ? addrs.map((ip) => `<div class="addr"><span class="mono" style="font-size:14px;color:var(--text)">${esc(ip)}:${sh.port}</span><button class="btn small" data-copy="${esc(ip)}:${sh.port}">复制</button></div>`).join('')
          : '<div style="color:var(--red)">没有找到局域网 IPv4 地址，确认这台电脑已连接网络。</div>'
      }</div>
      <div class="small-dim">Windows 防火墙如果询问是否允许 tmux-web 访问网络，选「允许」（专用网络），否则其他设备连不上。离开这个窗口后共享仍会继续，直到点「停止共享」或退出 App。只在你信任的局域网里使用。</div>
      <div><button class="btn danger" data-sstop>停止共享</button></div>`;
  } else if (m.tab === 0) {
    const portOk2 = /^\d+$/.test(m.port) && +m.port >= 1024 && +m.port <= 65535;
    const can = !sh.starting && m.sel.size > 0 && m.password.length >= 6 && portOk2;
    body = `<div class="group"><div class="box pad">
        <div class="inline" style="align-items:flex-start"><div style="flex:1"><b>选择要共享的服务器</b><div class="small-dim">会带上连接地址、账号、密码、EasyTier 网络密钥和所选的私钥。接收方会跳过完全相同的配置。</div></div>
        <button class="btn small" data-sall>全选</button><button class="btn small" data-snone>全不选</button></div>
        <div class="sel-list">${
          S.profiles.length
            ? S.profiles.map((p) => `<button class="sel" data-sp="${esc(p.id)}">${check(m.sel.has(p.id))}${avatar(p, 'sm')}<span class="sel-t"><b>${esc(titleOf(p))}</b><span>${esc(p.Address)}</span></span></button>`).join('')
            : '<div class="small-dim" style="padding:8px 0">还没有服务器配置。</div>'
        }</div></div></div>
      ${
        S.keys.length
          ? `<div class="group"><div class="box pad"><b>SSH 私钥</b><div class="small-dim">选中的服务器会尽量自动选上它使用的私钥；相同的私钥在接收端只保留一份。</div>
        <div class="sel-list">${S.keys.map((k) => `<button class="sel" data-sk="${esc(k.id)}">${check(m.keys.has(k.id))}<span class="kic" style="width:26px;height:26px">${I.key}</span><span class="sel-t"><b>${esc(k.name)}</b><span>${esc(k.path)}</span></span></button>`).join('')}</div>
        <div class="frow" style="border-top:1px solid var(--line)"><label>私钥口令</label><div class="fc"><input class="field" type="password" data-s="passphrase" value="${esc(m.passphrase)}" placeholder="可选：加密私钥的口令，随本次共享发送"><div class="note">不填时，发送这台电脑已保存的口令（从别的设备收到加密私钥时会一并保存）；接收端连接时会自动使用。</div></div></div>
        </div></div>`
          : ''
      }
      <div class="group"><div class="box pad"><b>连接方式</b>
        ${row('端口', `<div class="inline"><input class="field num" data-s="port" value="${esc(m.port)}" inputmode="numeric"><span class="note">另一台设备用这个端口连接</span></div>`, null, portOk2 ? null : '端口在 1024–65535 之间')}
        ${row('访问密码', `<div class="inline"><input class="field" type="password" data-s="password" value="${esc(m.password)}" placeholder="至少 6 位"><button class="btn small" data-srand>随机</button></div>`, m.password && m.password.length < 6 ? null : null, m.password && m.password.length < 6 ? '密码至少 6 位' : null)}
        ${m.err || sh.error ? `<div class="err">${I.errDot}${esc(m.err || sh.error)}</div>` : ''}
        <div class="inline" style="justify-content:flex-end;margin-top:8px">${sh.starting ? '<span class="spin"></span><span class="small-dim">正在启动…</span>' : ''}<button class="btn primary" data-sstart ${can ? '' : 'disabled'}>开始共享</button></div>
      </div></div>
      <div class="group"><div class="box pad"><b>或者：直接发送到正在等待的设备</b>
        <div class="small-dim">对方没有摄像头时用：让对方在「从其他设备获取」里点「等对方发过来」，复制它的接收链接，粘贴到这里，就会把上面选中的服务器和私钥发过去。</div>
        ${row('接收链接', `<input class="field" data-s="pushlink" value="${esc(m.pushlink)}" placeholder="tmuxweb://receive?…" spellcheck="false">`, null, m.pushlink.trim() && !/^tmuxweb:\/\/receive\?/.test(m.pushlink.trim()) ? '要以 tmuxweb://receive? 开头' : null)}
        ${m.pusherr ? `<div class="err">${I.errDot}${esc(m.pusherr)}</div>` : ''}
        ${m.pushed ? `<div class="share-ok"><span>${I.check}</span><b>已发送</b><span class="small-dim" style="margin-left:8px">${esc(m.pushed)}</span></div>` : ''}
        <div class="inline" style="justify-content:flex-end;margin-top:8px">${m.pushing ? '<span class="spin"></span><span class="small-dim">正在发送…</span>' : ''}<button class="btn" data-spush ${!m.pushing && m.sel.size > 0 && /^tmuxweb:\/\/receive\?/.test(m.pushlink.trim()) ? '' : 'disabled'}>发送</button></div>
      </div></div>`;
  } else if ((S.receive || {}).running) {
    const rc = S.receive;
    const addrs = rc.addresses || [];
    body = `<div class="share-ok"><span class="spin"></span><b>正在等对方发过来</b></div>
      ${rc.link ? `<div class="qr-row"><div class="qr">${QR.svg(rc.link, 190)}</div><div class="qr-text">
        <b>让对方扫这个二维码</b>
        <div>在手机上打开 tmux-web App → 共享配置 → 共享给其他设备 → 扫码发送，对准左边的二维码，选好要发的服务器后点「发送」。</div>
        <div class="small-dim">另一台电脑：复制接收链接，粘贴到它「共享给其他设备」里的「接收链接」。</div>
        <div><button class="btn small" data-copy="${esc(rc.link)}">复制接收链接（含密码）</button></div></div></div>` : '<div style="color:var(--red)">没有找到局域网 IPv4 地址，确认这台电脑已连接网络。</div>'}
      <div class="addrs"><div class="small-dim" style="font-weight:600">本机地址</div>${addrs.map((ip) => `<div class="addr"><span class="mono" style="font-size:14px;color:var(--text)">${esc(ip)}:${rc.port}</span></div>`).join('')}</div>
      <div class="small-dim">收到一份后自动停止。二维码里带着一次性的随机密码，只有扫到它的设备能发过来。Windows 防火墙如果询问是否允许 tmux-web 访问网络，选「允许」（专用网络）。</div>
      <div><button class="btn" data-rstop>取消</button></div>`;
  } else if ((S.receive || {}).result && !m.done) {
    body = `<div class="group"><div class="box pad"><div class="share-ok"><span>${I.check}</span><b>已收到并导入</b></div><div>${esc(S.receive.result)}</div><div style="margin-top:10px"><button class="btn" data-sagain>再接收一份</button></div></div></div>`;
  } else if (m.done) {
    body = `<div class="group"><div class="box pad"><div class="share-ok"><span>${I.check}</span><b>导入完成</b></div><div>${esc(m.done)}</div><div style="margin-top:10px"><button class="btn" data-sagain>再接收一份</button></div></div></div>`;
  } else {
    const rportOk = /^\d+$/.test(m.rport) && +m.rport >= 1024 && +m.rport <= 65535;
    const can = !m.busy && m.host.trim() && rportOk && m.rpassword;
    body = `<div class="group"><div class="box pad"><b>让对方扫码发过来</b>
        <div class="small-dim">这台电脑没有摄像头时用：点下面的按钮，这里会显示一个二维码，对方（手机）在「共享给其他设备」里点「扫码发送」扫它，选好服务器后发过来。</div>
        ${(S.receive || {}).error ? `<div class="err">${I.errDot}${esc(S.receive.error)}</div>` : ''}
        <div class="inline" style="justify-content:flex-end;margin-top:8px"><button class="btn primary" data-rstart>等对方发过来</button></div>
      </div></div>
      <div class="group"><div class="box pad"><b>或者：从正在共享的设备获取</b>
        <div class="small-dim">让对方开始共享，把显示的 IP 和端口填在这里，再输入对方设置的密码。也可以把对方复制的共享链接直接粘贴到「对方 IP」，会自动填好并导入。</div>
        ${row('对方 IP', `<input class="field" data-s="host" value="${esc(m.host)}" placeholder="比如 192.168.1.23，或 tmuxweb://share?… 链接" spellcheck="false">`)}
        ${row('端口', `<div class="inline"><input class="field num" data-s="rport" value="${esc(m.rport)}" inputmode="numeric"><span class="note">1024–65535</span></div>`)}
        ${row('访问密码', `<input class="field" type="password" data-s="rpassword" value="${esc(m.rpassword)}">`)}
        ${m.rerr ? `<div class="err">${I.errDot}${esc(m.rerr)}</div>` : ''}
        <div class="inline" style="justify-content:flex-end;margin-top:8px">${m.busy ? '<span class="spin"></span>' : ''}<button class="btn primary" data-sfetch ${can ? '' : 'disabled'}>${m.busy ? '正在获取…' : '获取并导入'}</button></div>
      </div></div>
      <div class="group"><div class="box pad"><b>查重规则</b><div class="small-dim">服务器按连接方式、账号、地址、端口、密码和私钥判断。完全相同的配置会跳过；同一台服务器但密码或私钥不同，会作为另一个配置导入。相同的私钥只保留一份，导入的服务器会复用它。</div></div></div>`;
  }
  setModal(`<div class="dlg" style="max-width:720px">
    <div class="dlg-head"><div class="avatar" style="background:var(--blue)">${I.share.replace('width="15" height="15"', 'width="18" height="18"')}</div><div style="min-width:0"><h2>共享配置</h2><div class="sub">在局域网里把服务器和私钥安全地交给另一台设备</div></div></div>
    <div class="seg"><button class="${m.tab === 0 ? 'on' : ''}" data-stab="0">共享给其他设备</button><button class="${m.tab === 1 ? 'on' : ''}" data-stab="1">从其他设备获取</button></div>
    <div class="dlg-body">${body}</div>
    <div class="dlg-foot"><div class="msg">共享内容用密码加密；密码不会保存在发送设备上。</div><button class="btn primary" data-sdone>完成</button></div></div>`);
  if (fk) {
    const f = document.querySelector(`[data-s="${fk}"]`);
    if (f) {
      f.focus({ preventScroll: true });
      if (caret != null && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch {}
    }
  }
}

async function shareFetch(link) {
  const m = modal;
  m.busy = true;
  m.rerr = null;
  renderShare();
  const r = await ask(link ? { op: 'shareFetch', link } : { op: 'shareFetch', host: m.host, port: +m.rport, password: m.rpassword });
  if (modal !== m) return;
  m.busy = false;
  if (r.error) m.rerr = r.error;
  else {
    m.done = r.text;
    m.rpassword = '';
  }
  renderShare();
}

$('#modal').addEventListener('input', (e) => {
  const m = modal;
  if (!m || m.kind !== 'share') return;
  const k = e.target.dataset.s;
  if (!k) return;
  m[k] = e.target.value;
  if (k === 'host' && /^tmuxweb:\/\/receive\?/.test(m.host.trim())) {
    // the other way round: a device waiting to be sent to
    m.tab = 0;
    m.pushlink = m.host.trim();
    m.host = '';
    m.pusherr = null;
    m.pushed = null;
    return renderShare('pushlink');
  }
  if (k === 'host' && /^tmuxweb:\/\/share\?/.test(m.host.trim())) {
    // a pasted share link: fill in and import
    const q = new URLSearchParams(m.host.trim().slice('tmuxweb://share?'.length));
    const link = m.host.trim();
    m.host = (q.get('h') || '').split(',')[0] || '';
    m.rport = q.get('p') || m.rport;
    m.rpassword = q.get('k') || '';
    shareFetch(link);
    return;
  }
  m.err = null;
  const t = e.target, caret = t.selectionStart;
  renderShare(k);
  const f = document.activeElement;
  if (f && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch {}
});

$('#modal').addEventListener('keydown', (e) => {
  const m = modal;
  if (!m || m.kind !== 'share' || e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  const b = document.querySelector(e.target.dataset.s === 'pushlink' ? '[data-spush]' : m.tab === 0 ? '[data-sstart]' : '[data-sfetch]');
  if (b && !b.disabled) b.click();
});

$('#modal').addEventListener('click', async (e) => {
  const m = modal;
  if (!m || m.kind !== 'share') return;
  const t = e.target;
  let el;
  if ((el = t.closest('[data-stab]'))) {
    m.tab = +el.dataset.stab;
    return renderShare();
  }
  if (t.closest('[data-sdone]')) return closeModal();
  if ((el = t.closest('[data-sp]'))) {
    const id = el.dataset.sp;
    if (m.sel.has(id)) m.sel.delete(id);
    else {
      m.sel.add(id);
      const p = S.profiles.find((x) => x.id === id);
      if (p && p.keyID) m.keys.add(p.keyID);
    }
    return renderShare();
  }
  if ((el = t.closest('[data-sk]'))) {
    const id = el.dataset.sk;
    if (m.keys.has(id)) m.keys.delete(id);
    else m.keys.add(id);
    return renderShare();
  }
  if (t.closest('[data-sall]')) {
    m.sel = new Set(S.profiles.map((p) => p.id));
    m.keys = new Set(S.keys.map((k) => k.id));
    return renderShare();
  }
  if (t.closest('[data-snone]')) {
    m.sel = new Set();
    m.keys = new Set();
    return renderShare();
  }
  if (t.closest('[data-srand]')) {
    m.password = await ask({ op: 'randomPassword' });
    return renderShare();
  }
  if (t.closest('[data-sstart]')) {
    m.err = null;
    post({ op: 'shareStart', profiles: [...m.sel], keys: [...m.keys], passphrase: m.passphrase, password: m.password, port: +m.port });
    return;
  }
  if (t.closest('[data-sstop]')) return post({ op: 'shareStop' });
  if (t.closest('[data-rstart]')) return post({ op: 'receiveStart' });
  if (t.closest('[data-rstop]')) return post({ op: 'receiveStop' });
  if (t.closest('[data-spush]')) {
    m.pushing = true;
    m.pusherr = null;
    m.pushed = null;
    renderShare();
    const r = await ask({ op: 'sharePush', link: m.pushlink.trim(), profiles: [...m.sel], keys: [...m.keys], passphrase: m.passphrase });
    if (modal !== m) return;
    m.pushing = false;
    if (r.error) m.pusherr = r.error;
    else {
      m.pushed = r.text;
      m.pushlink = '';
    }
    return renderShare();
  }
  if ((el = t.closest('[data-copy]'))) {
    post({ op: 'copy', text: el.dataset.copy });
    const was = el.textContent;
    el.textContent = '已复制';
    setTimeout(() => (el.textContent = was), 1500);
    return;
  }
  if (t.closest('[data-sfetch]')) return shareFetch(null);
  if (t.closest('[data-sagain]')) {
    if ((S.receive || {}).result) post({ op: 'receiveStop' });
    m.done = null;
    m.rerr = null;
    m.rpassword = '';
    return renderShare();
  }
});

// ---------- updates

let lastNotes = '';
let upChannel = null; // the channel picked in the dialog (the app remembers it once 更新 is clicked)
const mbs = (b) => (b / 1048576).toFixed(1) + ' MB';
const rate = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : Math.round(b / 1024) + ' KB/s');
function openUpdate(u) {
  if (u.notes) lastNotes = u.notes;
  if (u.state === 'none') {
    if (modal && modal.kind === 'update') closeModal();
    return;
  }
  if (modal && modal.kind !== 'update' && u.state === 'offer' && !u.asked) {
    // another dialog is open: the toolbar's 新版本 brings it up later
    return;
  }
  if (u.state === 'downloading') {
    const pct = +u.text || 0;
    const from = u.from || '';
    const live =
      from === '正在测速'
        ? '<div class="inline"><span class="spin"></span>正在给各个渠道测速，挑最快的…</div>'
        : `<div>正在下载 ${esc(u.version || '')}… ${pct}%</div><div class="progress"><div style="width:${pct}%"></div></div>
          <div class="small-dim">${from ? `来源：${esc(from)}` : '正在准备…'}${u.total > 0 ? ` · ${mbs(u.done || 0)} / ${mbs(u.total)}` : u.done > 0 ? ` · 已下载 ${mbs(u.done)}` : ''}${u.speed > 0 ? ` · ${rate(u.speed)}` : ''}</div>`;
    // progress comes a few times a second: only the numbers change, so the button stays clickable
    const el = modal && modal.kind === 'updating' && $('#modal .up-live');
    if (el) {
      put(el, live);
      const sw = $('#modal [data-uswitch]');
      if (sw) sw.disabled = from === '正在测速' || !from;
      return;
    }
    modal = { kind: 'updating' };
    setModal(`<div class="dlg narrow"><div class="dlg-head"><img src="icon.png" width="38" height="38" style="border-radius:9px"><div><h2>检查更新</h2></div></div>
      <div class="dlg-body"><div class="up-live" style="display:flex;flex-direction:column;gap:8px">${live}</div></div>
      <div class="dlg-foot"><div class="msg">太慢可以换一个</div><button class="btn" data-uswitch ${from && from !== '正在测速' ? '' : 'disabled'}>换一个渠道</button></div></div>`);
    $('#modal .up-live')._html = live;
    return;
  }
  modal = { kind: u.state === 'installing' ? 'updating' : 'update' };
  let body = '', foot = '';
  if (u.state === 'checking') {
    body = '<div class="inline"><span class="spin"></span>正在检查新版本…</div>';
    foot = '<button class="btn" data-ucancel>取消</button>';
  } else if (u.state === 'latest') {
    body = `<div>已经是最新版本（${esc(u.current || S.version)}）。</div>`;
    foot = '<button class="btn primary" data-ucancel>好</button>';
  } else if (u.state === 'offer') {
    const chans = [{ id: 'auto', label: '自动（测速，用最快的）' }, ...(u.channels || [])];
    const cur = chans.some((c) => c.id === upChannel) ? upChannel : chans.some((c) => c.id === u.channel) ? u.channel : 'auto';
    upChannel = cur;
    body = `<div>tmux-web ${esc(u.version)} 可以更新了（现在是 ${esc(u.current || S.version)}）。更新时 App 会退出并自动重新打开，已连接的服务器需要重新连接。</div>${lastNotes ? `<div class="notes">${esc(lastNotes)}</div>` : ''}
      <label class="row-f"><span>下载渠道</span><select class="field" data-uchan>${chans.map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <div class="small-dim">选中的渠道下载失败时，会自动换其他渠道；会记住这次的选择。</div>`;
    foot = '<button class="btn quiet" data-uskip>跳过这个版本</button><div class="msg"></div><button class="btn" data-ucancel>以后再说</button><button class="btn primary" data-ugo>更新</button>';
  } else if (u.state === 'installing') {
    body = '<div class="inline"><span class="spin"></span>正在安装，App 马上会重新打开…</div>';
  } else if (u.state === 'failed') {
    body = `<div>${esc(u.text || '更新失败')}</div>`;
    foot = '<button class="btn primary" data-ucancel>好</button>';
  }
  setModal(`<div class="dlg narrow"><div class="dlg-head"><img src="icon.png" width="38" height="38" style="border-radius:9px"><div><h2>${u.state === 'offer' ? '有新版本' : '检查更新'}</h2></div></div>
    <div class="dlg-body">${body}</div>${foot ? `<div class="dlg-foot">${foot.includes('class="msg"') ? '' : '<div class="msg"></div>'}${foot}</div>` : ''}</div>`);
}
$('#modal').addEventListener('change', (e) => {
  if (modal && modal.kind === 'update' && e.target.dataset.uchan !== undefined) upChannel = e.target.value;
});
$('#modal').addEventListener('click', (e) => {
  if (!modal || (modal.kind !== 'update' && modal.kind !== 'updating')) return;
  if (e.target.closest('[data-ucancel]')) closeModal();
  else if (e.target.closest('[data-ugo]')) post({ op: 'installUpdate', channel: upChannel || 'auto' });
  else if (e.target.closest('[data-uswitch]')) {
    const b = e.target.closest('[data-uswitch]');
    b.disabled = true;
    post({ op: 'updateSwitch' });
  } else if (e.target.closest('[data-uskip]')) {
    post({ op: 'skipUpdate' });
    closeModal();
  }
});

// ---------- from the app

function render() {
  renderBar();
  renderMain();
  if (modal && modal.kind === 'keys') renderKeys();
  else if (modal && modal.kind === 'share') renderShare();
  else if (modal && modal.kind === 'editor') {
    // the key list may have changed under it (a key added from here)
  }
}

if (host) {
  host.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'state') {
      S = m;
      render();
    } else if (m.type === 'reply') {
      const done = waiting.get(m.req);
      waiting.delete(m.req);
      if (done) done(m.data);
    } else if (m.type === 'editor') {
      showEditor(m.draft);
    } else if (m.type === 'keys') {
      openKeys();
    } else if (m.type === 'share') {
      if (!modal || modal.kind !== 'share') openShare(m.tab);
      else if (m.tab != null) {
        modal.tab = m.tab;
        renderShare();
      }
    } else if (m.type === 'update') {
      openUpdate(m);
    }
  });
  post({ op: 'ready' });
}
// relative times on the cards
setInterval(() => S.showHome && !document.activeElement?.matches?.('#q') && renderMain(), 30000);
// the shell's own context menu (Reload, Inspect…) stays off; text fields keep copy/paste via keys
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, #main')) e.preventDefault();
});
