import { FileText, MapPin, TriangleAlert } from 'lucide-react';

import type { InboxMessage } from '@/api/contracts/inbox';
import { UserText } from '@/design-system/primitives/text/UserText';

import {
  fileLabelOf,
  fileSizeOf,
  isLocationMessage,
  mediaKind,
  messageLocation,
  safeMediaUrl,
} from './media';
import { VoicePlayer } from './VoicePlayer';
import styles from './Inbox.module.css';

/**
 * A message's attachment in the stream, as 02 draws it: a photo as a picture
 * inside the bubble (open it to see it whole), a voice note as something to
 * play, a video with its controls, a file by its name to download. Media that
 * could not be fetched says so - WhatsApp's expire - never a blank bubble.
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
    | 'media.sticker'
    | 'media.video'
    | 'media.document'
    | 'fileSize.kb'
    | 'fileSize.mb'
    | 'location.title'
    | 'location.open'
    | 'location.unreadable'
    | 'products'
    | 'product.view'
    | 'product.soldOut',
  values?: { readonly size: number },
) => string;

/**
 * ★ W9b: the product cards a message carried - the web chat's WooCommerce
 * ones and the storefront's - as the agent needs them: picture, name, price
 * (and the old one when it is on sale), sold out said, a link to the product.
 * Several are a row to scroll, as the visitor saw them.
 */
export function ProductCards({
  message,
  t,
  money,
}: {
  readonly message: InboxMessage;
  readonly t: T;
  /** The stream's own number formatter: a price in its currency, or the amount alone. */
  readonly money: (amount: string, currency: string | null) => string;
}) {
  const products = message.metadata?.commerce?.products ?? [];
  if (products.length === 0) return null;
  return (
    <ul
      className={products.length > 1 ? styles.productRow : styles.products}
      aria-label={t('products')}
      data-testid={`products-${message.id}`}
    >
      {products.map((p) => {
        const image = safeMediaUrl(p.imageUrl ?? null);
        const link = safeMediaUrl(p.productUrl ?? null);
        const sale =
          p.price !== null &&
          p.compareAtPrice !== null &&
          Number(p.compareAtPrice) > Number(p.price);
        return (
          <li
            key={p.productId}
            className={styles.product}
            data-testid={`product-${message.id}-${p.productId}`}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={styles.productImage} src={image} alt="" loading="lazy" />
            ) : (
              <span className={styles.productImage} aria-hidden="true" />
            )}
            <span className={styles.productText}>
              <span className={styles.productTitle}>
                <UserText>{p.title}</UserText>
              </span>
              {p.price !== null ? (
                <bdi dir="ltr" className={styles.productPrice}>
                  {money(p.price, p.currency ?? null)}
                  {sale ? (
                    <s className={styles.productWas}>
                      {money(p.compareAtPrice!, p.currency ?? null)}
                    </s>
                  ) : null}
                </bdi>
              ) : null}
              {p.available ? null : (
                <span className={styles.productOut}>{t('product.soldOut')}</span>
              )}
              {link ? (
                <a
                  className={styles.contactLink}
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('product.view')}
                </a>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

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
          {t(`media.${kind}`)}
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
  // A file by the name its sender gave it, and how big it is (Backend 9e68eb03).
  const name = fileLabelOf(message);
  const size = fileSizeOf(message.metadata?.media?.byteSize);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={name ?? undefined}
      className={styles.file}
      data-testid={`file-${message.id}`}
    >
      <FileText size={16} aria-hidden="true" />
      <span className={styles.fileName}>
        {/* The sender's name for it, in its own direction; ours when there is none. */}
        {name ? <UserText>{name}</UserText> : t('file')}
      </span>
      {size ? (
        <>
          {' '}
          <span className={styles.fileSize} data-testid={`file-size-${message.id}`}>
            {t(`fileSize.${size.unit}`, { size: size.size })}
          </span>
        </>
      ) : null}
    </a>
  );
}

/** A shared contact: who, and each number - to ring, or to write on WhatsApp when Meta knows it. */
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
 * so a voice note says it cannot be read out - never an empty transcript an
 * agent would take for a failed one.
 */
function VoiceNote({ id, t }: { readonly id: string; readonly t: T }) {
  return (
    <p className={styles.mediaNote} data-testid={`voice-${id}`}>
      {t('voiceNoTranscript')}
    </p>
  );
}

/**
 * A shared location (WhatsApp, 2026-10-09): the place's name and address when
 * the provider sent them, and a way to the map - never `[Location: …]`.
 */
export function LocationCard({ message, t }: { readonly message: InboxMessage; readonly t: T }) {
  if (!isLocationMessage(message)) return null;
  const place = messageLocation(message);
  if (!place) {
    // A location with no usable point (`[Shared location]`): said, not printed raw.
    return (
      <p className={styles.mediaNote} data-testid={`location-${message.id}`}>
        {t('location.unreadable')}
      </p>
    );
  }
  return (
    <div className={styles.contact} data-testid={`location-${message.id}`}>
      <span className={styles.contactName}>
        <MapPin size={13} aria-hidden="true" />{' '}
        {place.name ? <UserText>{place.name}</UserText> : t('location.title')}
      </span>
      {place.address ? (
        <span className={styles.contactOrg}>
          <UserText>{place.address}</UserText>
        </span>
      ) : null}
      {place.name || place.address ? null : (
        <span className={styles.contactOrg}>
          <bdi dir="ltr">
            {place.latitude}, {place.longitude}
          </bdi>
        </span>
      )}
      <span className={styles.contactPhone}>
        <a
          className={styles.contactLink}
          href={place.mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`location-${message.id}-map`}
        >
          {t('location.open')}
        </a>
      </span>
    </div>
  );
}
