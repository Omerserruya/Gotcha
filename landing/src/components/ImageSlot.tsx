import React from 'react';
import slots from '@/generated/image-slots.json';

type Slot = { src: string; scale: number; x: number; y: number };

/**
 * The design's <image-slot> resolved to the photo it was actually filled with.
 *
 * image-slot.js sized the image to `cover` × the view scale and centred it at
 * (50 + x)% / (50 + y)% of the frame. `object-fit: cover` reproduces the cover
 * baseline, and `translate(x%, y%) scale(s)` reproduces the rest: the translate
 * percentages resolve against the image's own box, which fills the frame, so
 * they move it by the same fraction of the frame the slot used.
 */
export default function ImageSlot({ id, style }: { id: string; style?: React.CSSProperties }) {
  const slot = (slots as Record<string, Slot>)[id];
  if (!slot) return <div style={style} />;

  return (
    <div style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%', ...style }}>
      <img
        src={slot.src}
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate(${slot.x}%, ${slot.y}%) scale(${slot.scale})`,
        }}
      />
    </div>
  );
}
