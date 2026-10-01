import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type Folder, type Group, type HostInfo, type Me, type SessionInfo } from './api';
import { AGENT_LABEL, coarsePointer, relTime, shortPath, store } from './lib';
import { Modal } from './ui';
import { restartAgent } from './chat';

export function useGroups(me: Me) {
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    api<Group[]>('GET', '/_tw/api/groups').then(setGroups, () => {});
  }, []);
  return me.role === 'admin' ? groups : groups.filter((g) => me.groups.includes(g.id));
}

export function ShareFields({ groups, groupId, share }: { groups: Group[]; groupId?: number | null; share?: string }) {
  if (!groups.length) return null;
  return (
    <div class="row2">
      <label>
        共享给分组
        <select name="groupId" defaultValue={groupId ? String(groupId) : ''}>
          <option value="">不共享</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        分组权限
        <select name="share" defaultValue={share || 'view'}>
          <option value="view">只读</option>
          <option value="control">可操作</option>
        </select>
      </label>
    </div>
  );
}

export function useHosts() {
  const [hosts, setHosts] = useState<HostInfo[] | null>(null);
  const load = useCallback(() => api<HostInfo[]>('GET', '/_tw/api/hosts').then(setHosts, () => setHosts([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return [hosts, load] as const;
}

export interface ExistingTmux {
  socket: string;
  name: string;
  cwd: string;
  command: string;
  agent: 'claude' | 'codex' | 'bash';
  claudeSession?: string;
  attached: boolean;
  adoptedAs?: number;
}

/** Existing tmux sessions on a host that can be shown in tmux-web as they are. */
export function AdoptList({ hostId, onAdopted }: { hostId: number; onAdopted: (id: number) => void }) {
  const [list, setList] = useState<ExistingTmux[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    setList(null);
    api<ExistingTmux[]>('GET', `/_tw/api/hosts/${hostId}/tmux`).then(setList, (e) => {
      setList([]);
      setErr(e.message);
    });
  }, [hostId]);
  const adopt = async (t: ExistingTmux) => {
    setBusy(t.name);
    setErr('');
    try {
      const { id } = await api<{ id: number }>('POST', `/_tw/api/hosts/${hostId}/adopt`, { name: t.name, socket: t.socket });
      onAdopted(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div class="form">
      <p class="dim small">直接接管主机上已有的 tmux 会话：里面的程序不会重启，你在自己终端里照常 attach，网页上同时可见。在网页里删除只会停止接管，不会关闭它。</p>
      {list === null && <p class="dim small">读取中…</p>}
      {list?.length === 0 && !err && <p class="dim small">这台主机上没有 tmux 会话</p>}
      {err && <p class="error small">{err}</p>}
      <div class="table">
        {list?.map((t) => (
          <div class="user-row" key={t.name}>
            <div>
              <b>{t.name}</b> <span class="tag">{t.claudeSession ? 'Claude' : t.command}</span>
              {t.attached && <span class="tag">已在别处打开</span>}
              <div class="dim small">{t.cwd}</div>
            </div>
            <div class="row-actions">
              {t.adoptedAs ? (
                <button type="button" onClick={() => onAdopted(t.adoptedAs!)}>
                  已导入，打开
                </button>
              ) : (
                <button type="button" class="primary" disabled={!!busy} onClick={() => adopt(t)}>
                  {busy === t.name ? '导入中…' : '导入'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ClaudeHistory {
  id: string;
  cwd: string;
  title: string;
  lastPrompt: string;
  mtime: number;
  size: number;
  running?: { tmux?: string };
  openAs?: number;
}

/** Pick an earlier Claude Code conversation on the host to continue (claude --resume). */
export function ClaudeHistoryPicker({ hostId, selected, onSelect }: { hostId: number; selected: ClaudeHistory | null; onSelect: (h: ClaudeHistory | null) => void }) {
  const [list, setList] = useState<ClaudeHistory[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    setList(null);
    setErr('');
    api<ClaudeHistory[]>('GET', `/_tw/api/hosts/${hostId}/claude-history`).then(setList, (e) => {
      setList([]);
      setErr(e.message);
    });
  }, [hostId]);
  const f = filter.trim().toLowerCase();
  const shown = (list || []).filter((h) => !f || `${h.title} ${h.lastPrompt} ${h.cwd}`.toLowerCase().includes(f));
  return (
    <div class="hist">
      <div class="hist-head">
        <span>从历史会话继续</span>
        {list && list.length > 5 && <input value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} placeholder="搜索标题、内容、目录" />}
      </div>
      <div class="hist-list">
        <button type="button" class={`hist-item ${selected ? '' : 'on'}`} onClick={() => onSelect(null)}>
          <span class="hist-title">新会话</span>
          <span class="hist-sub">不基于历史，在下面的目录里开始</span>
        </button>
        {list === null && <p class="dim small pad">读取历史会话…</p>}
        {err && <p class="error small pad">{err}</p>}
        {shown.map((h) => (
          <button type="button" key={h.id} class={`hist-item ${selected?.id === h.id ? 'on' : ''}`} onClick={() => onSelect(h)}>
            <span class="hist-title">
              {h.title || h.lastPrompt || h.id.slice(0, 8)}
              {h.running && <span class="tag warn">运行中{h.running.tmux ? ` · ${h.running.tmux}` : ''}</span>}
              {h.openAs && <span class="tag">已在 tmux-web</span>}
            </span>
            {h.title && h.lastPrompt && <span class="hist-sub">最近：{h.lastPrompt}</span>}
            <span class="hist-sub mono">
              {shortPath(h.cwd)} · {relTime(h.mtime)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function NewSession({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: (id: number) => void }) {
  const [mode, setMode] = useState<'new' | 'adopt'>('new');
  const [agent, setAgent] = useState<keyof typeof AGENT_LABEL>('claude');
  // extra launch options: remembered per agent type, presets toggle in and out
  const [args, setArgs] = useState(() => store.get('tw:args:claude') ?? '');
  useEffect(() => setArgs(store.get(`tw:args:${agent}`) ?? ''), [agent]);
  const [resume, setResume] = useState<ClaudeHistory | null>(null);
  const [hosts] = useHosts();
  const [hostId, setHostId] = useState<number | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = useGroups(me);
  useEffect(() => {
    if (hosts?.length && hostId === null) setHostId((hosts.find((h) => h.ok) ?? hosts[0]).id);
  }, [hosts]);
  useEffect(() => {
    if (hostId === null) return;
    setDirs([]);
    api<string[]>('GET', `/_tw/api/hosts/${hostId}/dirs`).then(setDirs, () => {});
  }, [hostId]);
  const host = hosts?.find((h) => h.id === hostId);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    setBusy(true);
    setErr('');
    try {
      const fromHistory = agent === 'claude' && resume;
      const { id } = await api<{ id: number }>('POST', '/_tw/api/sessions', {
        ...f,
        ...(fromHistory ? { resumeId: resume.id, cwd: resume.cwd, fork: !!resume.running, name: f.name || resume.title || '' } : {}),
        hostId,
        groupId: f.groupId ? Number(f.groupId) : null,
        share: f.groupId ? f.share : 'none',
      });
      store.set(`tw:args:${agent}`, args.trim() || null);
      onCreated(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="新建会话" onClose={onClose}>
      <div class="tabs mode-tabs">
        <button class={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          新建
        </button>
        <button class={mode === 'adopt' ? 'on' : ''} onClick={() => setMode('adopt')}>
          导入已有 tmux
        </button>
      </div>
      {mode === 'adopt' && hosts && hosts.length > 1 && (
        <label class="form">
          主机
          <select value={String(hostId ?? '')} onChange={(e) => setHostId(Number((e.target as HTMLSelectElement).value))}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === 'adopt' && hostId !== null && <AdoptList hostId={hostId} onAdopted={onCreated} />}
      <form onSubmit={submit} class="form" style={mode === 'adopt' ? 'display:none' : ''}>
        <label>
          类型
          <select name="agent" value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value as keyof typeof AGENT_LABEL)}>
            {(Object.keys(AGENT_LABEL) as (keyof typeof AGENT_LABEL)[]).map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        {hosts && hosts.length > 1 && (
          <label>
            主机
            <select value={String(hostId ?? '')} onChange={(e) => setHostId(Number((e.target as HTMLSelectElement).value))}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.ok === false ? '（离线）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {host && host.ok === false && <p class="error small">这台主机当前连不上：{host.error}</p>}
        {agent === 'claude' && hostId !== null && <ClaudeHistoryPicker key={hostId} hostId={hostId} selected={resume} onSelect={setResume} />}
        {agent === 'claude' && resume?.running && (
          <p class="small hint">
            这个会话正在{resume.running.tmux ? ` tmux「${resume.running.tmux}」` : '别处'}运行。两个进程同时写同一个对话会互相干扰，所以会<b>复制一份</b>再继续（--fork-session），原会话不受影响。
            {resume.openAs ? (
              <>
                {' '}
                也可以
                <button type="button" class="link" onClick={() => onCreated(resume.openAs!)}>
                  直接打开 tmux-web 里的那个会话
                </button>
                。
              </>
            ) : (
              ' 想直接操作原会话的话，用「导入已有 tmux」。'
            )}
          </p>
        )}
        <label style={agent === 'claude' && resume ? 'display:none' : ''}>
          工作目录
          <input name="cwd" list="dirs" key={hostId ?? 0} defaultValue={dirs[0] || ''} placeholder="~/项目，不存在会自动创建" required={!(agent === 'claude' && resume)} />
          <datalist id="dirs">
            {dirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label>
          名称
          <input name="name" placeholder={agent === 'claude' && resume?.title ? resume.title : '留空则用 agent + 目录名'} maxLength={60} />
        </label>
        <label>
          额外启动参数
          <input name="args" value={args} onInput={(e) => setArgs((e.target as HTMLInputElement).value)} placeholder="点下面的常用项，或自己填写" autocapitalize="off" spellcheck={false} />
        </label>
        {ARG_PRESETS[agent] && <ArgPresets presets={ARG_PRESETS[agent]!} args={args} onChange={setArgs} />}
        <ShareFields groups={groups} />
        {err && <p class="error">{err}</p>}
        <button class="primary" disabled={busy || hostId === null}>
          {busy ? '创建中…' : agent === 'claude' && resume ? (resume.running ? '复制一份并继续' : '继续这个会话') : '创建'}
        </button>
      </form>
    </Modal>
  );
}

export function SessionSettings({ me, session, folders, onClose }: { me: Me; session: SessionInfo; folders: Folder[]; onClose: () => void }) {
  const [err, setErr] = useState('');
  const groups = useGroups(me);
  const owner = me.role === 'admin' || session.owner === me.username;
  const save = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    try {
      const patch: Record<string, unknown> = {};
      if (session.access === 'control') patch.note = f.note ?? '';
      if (owner) Object.assign(patch, { name: f.name, groupId: f.groupId ? Number(f.groupId) : null, share: f.groupId ? f.share : 'none' });
      if (Object.keys(patch).length) await api('PATCH', `/_tw/api/sessions/${session.id}`, patch);
      const folderId = f.folderId ? Number(f.folderId) : null;
      if (folderId !== session.folderId) await api('PUT', `/_tw/api/sessions/${session.id}/folder`, { folderId });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const restartClaude = async () => {
    try {
      if (await restartAgent(session, session.status)) onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const restart = async () => {
    if (!confirm(session.adopted ? `重启会关闭你原来的 tmux 会话「${session.tmux}」，然后在 tmux-web 里恢复对话。继续？` : '重启会话？正在运行的任务会被中断，对话会自动恢复。')) return;
    try {
      await api('POST', `/_tw/api/sessions/${session.id}/restart`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = async () => {
    if (!confirm(session.adopted ? `停止接管「${session.name}」？你原来的 tmux 会话不受影响。` : `删除会话「${session.name}」？tmux 里的进程会被结束（agent 的对话记录文件会保留）。`)) return;
    try {
      await api('DELETE', `/_tw/api/sessions/${session.id}`);
      location.hash = '';
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title="会话设置" onClose={onClose}>
      <form onSubmit={save} class="form">
        <p class="dim small">
          {AGENT_LABEL[session.agent]} · {session.host}:{session.cwd} · 创建者 {session.owner}
        </p>
        {session.adopted && <p class="small">接管自你的 tmux 会话 <code>{session.tmux}</code>。删除只是停止接管；「重启」会关掉原会话，并在 tmux-web 里恢复对话。</p>}
        {owner && (
          <label>
            名称
            <input name="name" defaultValue={session.name} maxLength={60} />
          </label>
        )}
        {session.access === 'control' && (
          <label>
            备注
            <textarea name="note" rows={2} maxLength={500} defaultValue={session.note} placeholder="显示在会话名下面，比如在做什么、注意事项" />
          </label>
        )}
        <label>
          文件夹
          <select name="folderId" defaultValue={session.folderId ? String(session.folderId) : ''}>
            <option value="">未分组</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {!folders.length && <small>还没有文件夹，可以在会话列表上方新建</small>}
        </label>
        {owner && <ShareFields groups={groups} groupId={session.groupId} share={session.share === 'none' ? 'view' : session.share} />}
        <button class="primary">保存</button>
        {err && <p class="error">{err}</p>}
        <div class="row-actions">
          {session.access === 'control' && session.agent === 'claude' && (
            <button type="button" onClick={restartClaude} title="只重启 claude 进程，对话接着继续（更新版本后用）">
              重启 Claude
            </button>
          )}
          {session.access === 'control' && (
            <button type="button" onClick={restart} title="关闭整个 tmux 会话再重建">
              {session.adopted ? '迁移到 tmux-web' : '重建会话'}
            </button>
          )}
          {owner && (
            <button type="button" class="danger" onClick={remove}>
              {session.adopted ? '停止接管' : '删除'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export interface ApiToken {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

/** Tokens for apps (e.g. the phone app) and scripts: Authorization: Bearer ... */
export function TokensModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ApiToken[]>([]);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<ApiToken[]>('GET', '/_tw/api/tokens').then(setList, (e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const create = async (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    try {
      setFresh(await api('POST', '/_tw/api/tokens', { name: new FormData(form).get('name') }));
      form.reset();
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const revoke = async (t: ApiToken) => {
    if (!confirm(`吊销「${t.name}」？用它登录的设备会立刻失效。`)) return;
    await api('DELETE', `/_tw/api/tokens/${t.id}`).catch((e) => setErr(e.message));
    load();
  };
  return (
    <Modal title="API 令牌" onClose={onClose}>
      <p class="dim small">给手机 App、脚本等用的长期凭证（请求头 Authorization: Bearer 令牌）。令牌只在创建时显示一次。</p>
      {fresh && (
        <div class="keybox">
          <div class="small">「{fresh.name}」的令牌，请现在复制保存：</div>
          <pre>{fresh.token}</pre>
          <button type="button" onClick={() => navigator.clipboard?.writeText(fresh.token).catch(() => {})}>
            复制
          </button>
        </div>
      )}
      <div class="table" style="margin-top:10px">
        {list.map((t) => (
          <div class="user-row" key={t.id}>
            <div>
              <b>{t.name}</b>
              <div class="dim small">
                创建于 {new Date(t.created_at).toLocaleString()} · {t.last_used_at ? `最近使用 ${relTime(t.last_used_at)}` : '还没用过'}
              </div>
            </div>
            <button class="danger" onClick={() => revoke(t)}>
              吊销
            </button>
          </div>
        ))}
        {!list.length && <p class="dim small">还没有令牌</p>}
      </div>
      {err && <p class="error">{err}</p>}
      <form class="input-row" style="margin-top:12px" onSubmit={create}>
        <input name="name" placeholder="名字，比如「我的手机」" required maxLength={40} />
        <button class="primary">创建</button>
      </form>
    </Modal>
  );
}

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const [msg, setMsg] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    try {
      await api('POST', '/_tw/api/me/password', { oldPassword: f.get('old'), newPassword: f.get('new') });
      setMsg('已修改');
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <Modal title="修改密码" onClose={onClose}>
      <form onSubmit={submit} class="form">
        <label>
          原密码
          <input name="old" type="password" autocomplete="current-password" required />
        </label>
        <label>
          新密码
          <input name="new" type="password" autocomplete="new-password" minLength={6} required />
        </label>
        {msg && <p class="small">{msg}</p>}
        <button class="primary">确定</button>
      </form>
    </Modal>
  );
}

export function AdminModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [hosts, loadHosts] = useHosts();
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const load = () => {
    api<Me[]>('GET', '/_tw/api/users').then(setUsers, (e) => setErr(e.message));
    api<Group[]>('GET', '/_tw/api/groups').then(setGroups, () => {});
    loadHosts();
  };
  useEffect(() => {
    api<{ publicKey: string }>('GET', '/_tw/api/ssh-key').then((r) => setKey(r.publicKey || ''), () => {});
  }, []);
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const create = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = new FormData(form);
    run(async () => {
      await api('POST', '/_tw/api/users', {
        username: f.get('username'),
        password: f.get('password'),
        role: f.get('role'),
        groups: f.getAll('groups').map(Number),
      });
      form.reset();
    });
  };
  const addHost = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    run(async () => {
      const h = await api<HostInfo>('POST', '/_tw/api/hosts', { ...f, port: Number(f.port || 22), ownerId: f.ownerId ? Number(f.ownerId) : null });
      if (h.ok === false) setErr(`已添加，但暂时连不上：${h.error}`);
      form.reset();
    });
  };
  const copyKey = () => navigator.clipboard?.writeText(`echo '${key}' >> ~/.ssh/authorized_keys`).catch(() => {});
  const toggleGroup = (u: Me, gid: number) =>
    run(() => api('PATCH', `/_tw/api/users/${u.id}`, { groups: u.groups.includes(gid) ? u.groups.filter((g) => g !== gid) : [...u.groups, gid] }));
  const resetPassword = (u: Me) => {
    const p = prompt(`为 ${u.username} 设置新密码（至少 6 位）`);
    if (p) run(() => api('PATCH', `/_tw/api/users/${u.id}`, { password: p }));
  };
  const addGroup = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = new FormData(form).get('name');
    run(async () => {
      await api('POST', '/_tw/api/groups', { name });
      form.reset();
    });
  };

  return (
    <Modal title="主机、账号与分组" onClose={onClose}>
      {err && <p class="error">{err}</p>}
      <h3>主机</h3>
      <div class="table">
        {(hosts || []).map((h) => (
          <div class="user-row" key={h.id}>
            <div>
              <span class={`dot ${h.ok ? 'idle' : 'waiting'}`} /> <b>{h.name}</b>{' '}
              <span class="dim small">{h.kind === 'local' ? '本进程直接运行' : `${h.user}@${h.address}:${h.port}`}</span>
              {h.ownerId !== null && <span class="tag">仅 {users.find((u) => u.id === h.ownerId)?.username ?? '?'}</span>}
              <div class={`small ${h.ok ? 'dim' : 'error'}`}>{h.ok ? `${h.tmux} · ${h.home}` : h.error || '未检测'}</div>
            </div>
            <div class="row-actions">
              <button onClick={() => run(() => api('POST', `/_tw/api/hosts/${h.id}/check`))}>检测</button>
              <button class="danger" onClick={() => confirm(`删除主机 ${h.name}？`) && run(() => api('DELETE', `/_tw/api/hosts/${h.id}`))}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      {key && (
        <div class="keybox">
          <div class="small dim">在每台主机上，把这把公钥加进对应 SSH 用户的 authorized_keys：</div>
          <pre>echo '{key}' &gt;&gt; ~/.ssh/authorized_keys</pre>
          <button type="button" onClick={copyKey}>
            复制命令
          </button>
        </div>
      )}
      <form onSubmit={addHost} class="form boxed">
        <h3>添加主机</h3>
        <div class="row2">
          <label>
            名称
            <input name="name" required maxLength={40} placeholder="例如 gpu-server" />
          </label>
          <label>
            可用账号
            <select name="ownerId">
              <option value="">所有人</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  仅 {u.username}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="row3">
          <label>
            地址
            <input name="address" required placeholder="192.168.1.10" autocapitalize="off" spellcheck={false} />
          </label>
          <label>
            端口
            <input name="port" type="number" defaultValue="22" min={1} max={65535} />
          </label>
          <label>
            SSH 用户
            <input name="user" required autocapitalize="off" spellcheck={false} />
          </label>
        </div>
        <button class="primary">添加并检测</button>
      </form>
      <h3>账号</h3>
      <div class="table">
        {users.map((u) => (
          <div class="user-row" key={u.id}>
            <div>
              <b>{u.username}</b> {u.role === 'admin' && <span class="tag">管理员</span>}
              {u.disabled && <span class="tag warn">已停用</span>}
              {groups.length > 0 && (
                <div class="chips">
                  {groups.map((g) => (
                    <button key={g.id} class={`chip ${u.groups.includes(g.id) ? 'on' : ''}`} onClick={() => toggleGroup(u, g.id)}>
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div class="row-actions">
              <button onClick={() => resetPassword(u)}>改密码</button>
              {u.id !== me.id && (
                <>
                  <button onClick={() => run(() => api('PATCH', `/_tw/api/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? '启用' : '停用'}</button>
                  <button
                    class="danger"
                    onClick={() => confirm(`删除账号 ${u.username}？它创建的会话、只给它用的主机也会被删除（主机上的文件不受影响）。`) && run(() => api('DELETE', `/_tw/api/users/${u.id}`))}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={create} class="form boxed">
        <h3>新建账号</h3>
        <div class="row2">
          <label>
            用户名
            <input name="username" required pattern="[a-z][a-z0-9_\-]{1,30}" autocapitalize="off" title="小写字母开头，2-31 位" />
          </label>
          <label>
            密码
            <input name="password" type="password" minLength={6} required autocomplete="new-password" />
          </label>
        </div>
        <label>
          角色
          <select name="role">
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        {groups.length > 0 && (
          <div class="chips">
            {groups.map((g) => (
              <label key={g.id} class="chip-check">
                <input type="checkbox" name="groups" value={g.id} /> {g.name}
              </label>
            ))}
          </div>
        )}
        <button class="primary">创建账号</button>
      </form>
      <h3>分组</h3>
      <div class="chips">
        {groups.map((g) => (
          <span key={g.id} class="chip on">
            {g.name}
            <button class="ghost x" onClick={() => confirm(`删除分组 ${g.name}？`) && run(() => api('DELETE', `/_tw/api/groups/${g.id}`))}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={addGroup} class="input-row">
        <input name="name" placeholder="新分组名" required maxLength={40} />
        <button>添加</button>
      </form>
    </Modal>
  );
}

/** Create / rename / annotate / delete a folder. */
export function FolderModal({ folder, onClose }: { folder: Folder | null; onClose: () => void }) {
  const [err, setErr] = useState('');
  const save = async (e: Event) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>;
    try {
      if (folder) await api('PATCH', `/_tw/api/folders/${folder.id}`, f);
      else await api('POST', '/_tw/api/folders', f);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = async () => {
    if (!folder || !confirm(`删除文件夹「${folder.name}」？里面的会话会移到「未分组」，不会被删除。`)) return;
    try {
      await api('DELETE', `/_tw/api/folders/${folder.id}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <Modal title={folder ? '编辑文件夹' : '新建文件夹'} onClose={onClose}>
      <form class="form" onSubmit={save}>
        <label>
          名称
          <input name="name" defaultValue={folder?.name ?? ''} required maxLength={40} autoFocus={!coarsePointer} />
        </label>
        <label>
          备注
          <textarea name="note" rows={3} maxLength={500} defaultValue={folder?.note ?? ''} placeholder="比如这组会话是做什么的" />
        </label>
        {err && <p class="error">{err}</p>}
        <button class="primary">{folder ? '保存' : '创建'}</button>
        {folder && (
          <div class="row-actions">
            <button type="button" class="danger" onClick={remove}>
              删除文件夹
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

interface ArgPreset {
  /** what is added to the command line */
  arg: string;
  label: string;
  /** presets in the same group exclude each other */
  group?: string;
  danger?: boolean;
}

/** Common launch options per agent (checked against `claude --help` / `codex --help`). */
const ARG_PRESETS: Partial<Record<keyof typeof AGENT_LABEL, ArgPreset[]>> = {
  claude: [
    { arg: '--dangerously-skip-permissions', label: '跳过所有确认', group: 'perm', danger: true },
    { arg: '--permission-mode acceptEdits', label: '自动接受编辑', group: 'perm' },
    { arg: '--permission-mode plan', label: '计划模式', group: 'perm' },
    { arg: '--permission-mode auto', label: '自动模式', group: 'perm' },
    { arg: '--model opus', label: 'Opus', group: 'model' },
    { arg: '--model sonnet', label: 'Sonnet', group: 'model' },
    { arg: '--model fable', label: 'Fable', group: 'model' },
    { arg: '--effort high', label: '思考 high', group: 'effort' },
    { arg: '--effort max', label: '思考 max', group: 'effort' },
  ],
  codex: [
    { arg: '--dangerously-bypass-approvals-and-sandbox', label: '跳过确认和沙箱', group: 'perm', danger: true },
    { arg: '-s workspace-write', label: '可写工作区沙箱', group: 'perm' },
    { arg: '--search', label: '联网搜索' },
  ],
};

const norm1 = (s: string) => ` ${s.trim().replace(/\s+/g, ' ')} `;

/** Toggle chips for common options; they edit the same text the input shows. */
function ArgPresets({ presets, args, onChange }: { presets: ArgPreset[]; args: string; onChange: (s: string) => void }) {
  const has = (p: ArgPreset) => norm1(args).includes(` ${p.arg} `);
  const remove = (text: string, p: ArgPreset) => norm1(text).replace(` ${p.arg} `, ' ');
  const toggle = (p: ArgPreset) => {
    let text = args;
    if (has(p)) text = remove(text, p);
    else {
      // one per group: drop the others first
      for (const o of presets) if (o.group && o.group === p.group && has(o)) text = remove(text, o);
      text = `${text} ${p.arg}`;
    }
    onChange(text.trim().replace(/\s+/g, ' '));
  };
  return (
    <div class="arg-presets">
      {presets.map((p) => (
        <button type="button" key={p.arg} class={`chip ${has(p) ? 'on' : ''} ${p.danger ? 'danger' : ''}`} title={p.arg} onClick={() => toggle(p)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}
