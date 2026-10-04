import { FileText, TriangleAlert } from 'lucide-react';

import type { InboxMessage } from '@/api/contracts/inbox';

import { mediaKind, safeMediaUrl } from './media';
import { VoicePlayer } from './VoicePlayer';
import styles from './Inbox.module.css';

/**
 * A message's attachment in the stream, as 02 draws it: a photo as a picture
 * inside the bubble (open it to see it whole), a voice note as something to
 * play, a video with its controls, a file by its name to download. Media that
 * could not be fetched says so — WhatsApp's expire — never a blank bubble.
 */
/** The stream's own translator, narrowed to what this needs. */
type T = (
  key:
    | 'mediaUnavailable'
    | 'openPhoto'
    | 'file'
    | 'contact'
    | 'call'
    | 'voiceNoTranscript'
    | 'play'
    | 'pause'
    | 'media.image'
    | 'media.video'
    | 'media.document',
) => string;

export function MessageMedia({ message, t }: { readonly message: InboxMessage; readonly t: T }) {
  const url = safeMediaUrl(message.mediaUrl);
  const kind = mediaKind(message);

  if (!url) {
    if (message.metadata?.mediaError) {
      return (
        <p className={styles.mediaGone} data-testid={`media-gone-${message.id}`}>
          <TriangleAlert size={14} aria-hidden="true" />
          {t('mediaUnavailable')}
        </p>
      );
    }
    // No file came with it and none failed: say what it was, in words.
    if (kind === 'audio') return <VoiceNote id={message.id} t={t} />;
    if (kind === 'image' || kind === 'sticker' || kind === 'video' || kind === 'document') {
      return (
        <p className={styles.mediaNote} data-testid={`media-${message.id}`}>
          {t(kind === 'sticker' ? 'media.image' : `media.${kind}`)}
        </p>
      );
    }
    return null;
  }

  if (kind === 'image' || kind === 'sticker') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={kind === 'sticker' ? styles.sticker : styles.photo}
        aria-label={t('openPhoto')}
        data-testid={`photo-${message.id}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a customer's file, from our host or theirs */}
        <img src={url} alt={message.fileName ?? ''} loading="lazy" />
      </a>
    );
  }
  if (kind === 'video') {
    return (
      <video
        className={styles.video}
        src={url}
        controls
        preload="metadata"
        data-testid={`video-${message.id}`}
      />
    );
  }
  if (kind === 'audio') {
    return (
      <>
        <VoicePlayer src={url} id={message.id} playLabel={t('play')} pauseLabel={t('pause')} />
        <VoiceNote id={message.id} t={t} />
      </>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={message.fileName ?? undefined}
      className={styles.file}
      data-testid={`file-${message.id}`}
    >
      <FileText size={16} aria-hidden="true" />
      <span className={styles.fileName}>{message.fileName ?? t('file')}</span>
    </a>
  );
}

/** A shared contact: who, and each number — to ring, or to write on WhatsApp when Meta knows it. */
export function ContactCards({ message, t }: { readonly message: InboxMessage; readonly t: T }) {
  const contacts = message.metadata?.contacts ?? [];
  if (contacts.length === 0) return null;
  return (
    <div className={styles.contacts} data-testid={`contacts-${message.id}`}>
      {contacts.map((c, i) => (
        <div key={i} className={styles.contact}>
          <span className={styles.contactName}>{c.name || t('contact')}</span>
          {c.organization ? <span className={styles.contactOrg}>{c.organization}</span> : null}
          {c.phones.map((p, j) =>
            p.number ? (
              <span key={j} className={styles.contactPhone}>
                <bdi dir="ltr">{p.number}</bdi>
                <a className={styles.contactLink} href={`tel:${p.number.replace(/[^\d+]/g, '')}`}>
                  {t('call')}
                </a>
                {p.waId ? (
                  <a
                    className={styles.contactLink}
                    href={`https://wa.me/${p.waId.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp
                  </a>
                ) : null}
              </span>
            ) : null,
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing transcribes audio yet (the Deepgram key exists without a client),
 * so a voice note says it cannot be read out — never an empty transcript an
 * agent would take for a failed one.
 */
function VoiceNote({ id, t }: { readonly id: string; readonly t: T }) {
  return (
    <p className={styles.mediaNote} data-testid={`voice-${id}`}>
      {t('voiceNoTranscript')}
    </p>
  );
}
