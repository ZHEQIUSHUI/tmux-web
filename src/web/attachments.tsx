import { useState } from 'preact/hooks';
import { attachmentHint, type Attachment, type AttachmentKind } from './attachment';
import { filePreviewHref } from './lib';
import { shown } from './markdown';

const q = (p: string) => encodeURIComponent(p);

/** An icon for the file kind; the extension is shown beside it. */
export function FileKindIcon({ kind }: { kind: AttachmentKind }) {
  const common = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
  if (kind === 'audio')
    return (
      <svg {...common} class="att-kind audio" aria-hidden="true">
        <path d="M9 18V6l9-2v12" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="15.5" cy="16" r="2.5" />
      </svg>
    );
  if (kind === 'video')
    return (
      <svg {...common} class="att-kind video" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
      </svg>
    );
  if (kind === 'image')
    return (
      <svg {...common} class="att-kind image" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="M5 18l5-5 3 3 2-2 4 4" />
      </svg>
    );
  if (kind === 'archive')
    return (
      <svg {...common} class="att-kind archive" aria-hidden="true">
        <path d="M4 7h16v13H4zM3 3h18v4H3zM10 11h4" />
        <path d="M12 7v4" />
      </svg>
    );
  if (kind === 'sheet')
    return (
      <svg {...common} class="att-kind sheet" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11M15 9v11M3 14h18" />
      </svg>
    );
  if (kind === 'slides')
    return (
      <svg {...common} class="att-kind slides" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M12 16v4M8 20h8M9 9l3-2 3 2v3H9z" />
      </svg>
    );
  if (kind === 'code')
    return (
      <svg {...common} class="att-kind code" aria-hidden="true">
        <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
      </svg>
    );
  if (kind === 'pdf' || kind === 'text' || kind === 'document')
    return (
      <svg {...common} class={`att-kind ${kind}`} aria-hidden="true">
        <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
        <path d="M9 12h6M9 15h6M9 18h4" />
      </svg>
    );
  return (
    <svg {...common} class="att-kind other" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6zM14 3v4h4" />
    </svg>
  );
}

function FileCard({ sid, item }: { sid: number; item: Attachment }) {
  return (
    <a
      class={`chat-att chat-att-file kind-${item.kind}`}
      href={filePreviewHref(sid, item.path)}
      target="_blank"
      rel="noopener noreferrer"
      title={`在新页面打开 ${item.name}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span class="chat-att-icon">
        <FileKindIcon kind={item.kind} />
      </span>
      <span class="chat-att-main">
        <span class="chat-att-name">{item.name}</span>
        <span class="chat-att-meta">{attachmentHint(item)}</span>
      </span>
      <span class="chat-att-open" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

function ImageCard({ sid, item }: { sid: number; item: Attachment }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <FileCard sid={sid} item={item} />;
  const url = `/_tw/api/sessions/${sid}/file-image?path=${q(item.path)}`;
  return (
    <a
      class="md-img chat-att chat-att-image"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${item.name}（点开查看）`}
      onClick={(e) => e.stopPropagation()}
    >
      <img src={shown(url, 512)} alt={item.name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      <span class="chat-att-image-name">
        <FileKindIcon kind="image" />
        <span>{item.name}</span>
      </span>
    </a>
  );
}

function MediaCard({ sid, item }: { sid: number; item: Attachment }) {
  const media = item.kind as 'audio' | 'video';
  const url = `/_tw/api/sessions/${sid}/file-media?path=${q(item.path)}`;
  return (
    <div class={`chat-att chat-att-media ${media}`} onClick={(e) => e.stopPropagation()}>
      <div class="chat-att-media-head">
        <FileKindIcon kind={media} />
        <a href={filePreviewHref(sid, item.path)} target="_blank" rel="noopener noreferrer" title="在新页面打开">
          {item.name}
        </a>
      </div>
      {media === 'audio' ? <audio controls preload="metadata" src={url} title={item.name} /> : <video controls preload="metadata" src={url} title={item.name} />}
    </div>
  );
}

/** Thumbnails, players and file cards for paths found in a user's message. */
export function ChatAttachments({ sid, list }: { sid: number; list: Attachment[] }) {
  if (!list.length) return null;
  return (
    <div class="chat-attachments">
      {list.map((item) =>
        item.kind === 'image' ? (
          <ImageCard key={item.path} sid={sid} item={item} />
        ) : item.kind === 'audio' || item.kind === 'video' ? (
          <MediaCard key={item.path} sid={sid} item={item} />
        ) : (
          <FileCard key={item.path} sid={sid} item={item} />
        ),
      )}
    </div>
  );
}
