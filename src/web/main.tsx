import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Me } from './api';
import { coarsePointer } from './lib';
import { Shell } from './shell';
import './style.css';

// ---------------- login ----------------

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [shake, setShake] = useState(0);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    setBusy(true);
    setErr('');
    try {
      onLogin(await api<Me>('POST', '/_tw/api/login', { username: f.get('username'), password: f.get('password') }));
    } catch (e: any) {
      setErr(e.message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <div class="login-box">
        <img class="login-logo" src="/_tw/icon-192.png" alt="" width="64" height="64" />
        <h1>tmux-web</h1>
        <p class="login-sub">登录后管理你的 agent 会话</p>
        <form onSubmit={submit} class={`login-form ${shake ? 'shake' : ''}`} key={shake}>
          <input name="username" class="login-input" placeholder="账号" autocomplete="username" autocapitalize="off" spellcheck={false} required autoFocus={!coarsePointer} />
          <div class="login-pw">
            <input name="password" class="login-input" type={(show ? 'text' : 'password') as 'password'} placeholder="密码" autocomplete="current-password" required />
            <button type="button" class="login-eye" onClick={() => setShow((v) => !v)} aria-label={show ? '隐藏密码' : '显示密码'}>
              {show ? '隐藏' : '显示'}
            </button>
          </div>
          {err && <p class="login-err">{err}</p>}
          <button class="primary login-btn" disabled={busy}>
            {busy ? <span class="spinner" /> : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [me, setMe] = useState<Me | null | false>(null);
  useEffect(() => {
    api<Me>('GET', '/_tw/api/me').then(setMe, () => setMe(false));
    const out = () => setMe(false);
    addEventListener('tw:logout', out);
    return () => removeEventListener('tw:logout', out);
  }, []);
  if (me === null) return null;
  if (me === false) return <Login onLogin={setMe} />;
  return <Shell me={me} onLogout={() => setMe(false)} />;
}

// iOS doesn't shrink the layout when the keyboard opens; size the app to the visible viewport
// so the input box stays above the keyboard.
const vv = window.visualViewport;
if (vv && coarsePointer) {
  const fitViewport = () => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  fitViewport();
}

render(<App />, document.getElementById('app')!);
