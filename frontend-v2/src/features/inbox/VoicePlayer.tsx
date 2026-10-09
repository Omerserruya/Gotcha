'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import styles from './Inbox.module.css';

/** 02's bars: fixed heights, filled as it plays. */
const BARS = [7, 13, 19, 11, 22, 15, 9, 17, 21, 12, 6, 14, 18, 10, 16, 8, 13, 20, 11, 7];

/**
 * 02's voice note: a black disc to play, a waveform that fills as it plays,
 * and the time - over an `<audio>` nobody sees. One control, not the
 * browser's beside the design's.
 */
export function VoicePlayer({
  src,
  id,
  playLabel,
  pauseLabel,
}: {
  readonly src: string;
  readonly id: string;
  readonly playLabel: string;
  readonly pauseLabel: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(null);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const time = () => setAt(el.currentTime);
    const meta = () => setLength(Number.isFinite(el.duration) ? el.duration : null);
    const end = () => {
      setPlaying(false);
      setAt(0);
    };
    el.addEventListener('timeupdate', time);
    el.addEventListener('loadedmetadata', meta);
    el.addEventListener('ended', end);
    return () => {
      el.removeEventListener('timeupdate', time);
      el.removeEventListener('loadedmetadata', meta);
      el.removeEventListener('ended', end);
    };
  }, []);

  const shown = playing || at > 0 ? at : (length ?? 0);
  const done = length ? at / length : 0;
  return (
    <span className={styles.voice} data-testid={`audio-${id}`}>
      <button
        type="button"
        className={styles.voiceMark}
        aria-label={playing ? pauseLabel : playLabel}
        data-testid={`voice-play-${id}`}
        onClick={() => {
          const el = audio.current;
          if (!el) return;
          if (playing) {
            el.pause();
            setPlaying(false);
          } else {
            void el.play().then(
              () => setPlaying(true),
              () => setPlaying(false),
            );
          }
        }}
      >
        {playing ? <Pause size={12} strokeWidth={2.5} /> : <Play size={12} strokeWidth={2.5} />}
      </button>
      <span className={styles.wave} aria-hidden="true">
        {BARS.map((h, i) => (
          <span
            key={i}
            style={{ blockSize: `${h}px` }}
            data-played={i / BARS.length < done ? 'yes' : undefined}
          />
        ))}
      </span>
      <span className={styles.voiceTime}>{clock(shown)}</span>
      <audio ref={audio} src={src} preload="metadata" hidden />
    </span>
  );
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
