import { useEffect, useState } from 'preact/hooks';
import { THEME_LABEL, ThemePref, copyText, useTheme } from './lib';

/** Compact cycling button for the desktop sidebar. */
export function ThemeCycle() {
  const [pref, set] = useTheme();
  const next: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };
  const icon = { auto: '◐', light: '☀', dark: '☾' }[pref];
  return (
    <button class="ghost small" onClick={() => set(next[pref])} title={`外观：${THEME_LABEL[pref]}（点击切换）`}>
      {icon}
    </button>
  );
}

export function ThemeSwitch() {
  const [pref, set] = useTheme();
  return (
    <div class="tabs theme-switch">
      {(['auto', 'light', 'dark'] as ThemePref[]).map((t) => (
        <button key={t} class={pref === t ? 'on' : ''} onClick={() => set(t)}>
          {THEME_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

export const Icon = {
  back: () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  chat: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  ),
  term: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  ),
  globe: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </svg>
  ),
  more: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
  plus: () => (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  send: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  keys: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" stroke-linecap="round" />
    </svg>
  ),
  clip: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7L14 4.5a3.5 3.5 0 015 5L10.5 18a2 2 0 01-3-3L15 7.5" />
    </svg>
  ),
  folderPlus: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  ),
  folder: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  ),
  copy: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  ),
  check: () => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  ),
  gear: () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  gauge: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  ),
  inbox: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 01-1 1H5a1 1 0 01-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </svg>
  ),
  files: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
      <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v3" />
      <path d="M3 6v12a2 2 0 002 2h7" />
      <circle cx="17" cy="16" r="3" />
      <path d="M19.2 18.2L21 20" />
    </svg>
  ),
  file: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  ),
  user: () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" stroke-linecap="round" />
    </svg>
  ),
  clock: () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
};

// ---------------- modals ----------------

export function Modal({ title, onClose, children, class: cls }: { title: string; onClose: () => void; children: any; class?: string }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal card ${cls ?? ''}`}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button class="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Chevron = ({ open }: { open: boolean }) => (
  <svg class={`chev ${open ? 'open' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** A small copy button; `text` may be fetched on click (e.g. the full text of a cut-off message). */
export function CopyBtn({ text, label, class: cls, title }: { text: string | (() => Promise<string>); label?: string; class?: string; title?: string }) {
  const [done, setDone] = useState<'' | 'ok' | 'fail'>('');
  return (
    <button
      type="button"
      class={`copy-btn ${done} ${cls ?? ''}`}
      title={title ?? '复制'}
      aria-label={title ?? '复制'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={async (e) => {
        e.stopPropagation();
        let ok = false;
        try {
          ok = await copyText(typeof text === 'string' ? text : await text());
        } catch {
          /* fetching the text failed */
        }
        setDone(ok ? 'ok' : 'fail');
        setTimeout(() => setDone(''), 1500);
      }}
    >
      {label ? (done === 'ok' ? '已复制' : done === 'fail' ? '复制失败' : label) : done === 'ok' ? <Icon.check /> : <Icon.copy />}
    </button>
  );
}
