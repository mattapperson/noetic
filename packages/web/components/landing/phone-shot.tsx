import type { ReactNode } from 'react';

interface PhoneShotProps {
  src: string;
  alt: string;
  caption?: string;
  width?: number;
}

export function PhoneShot({ src, alt, caption, width = 250 }: PhoneShotProps): ReactNode {
  return (
    <figure
      style={{
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${width}px`,
          borderRadius: '32px',
          border: '1px solid var(--color-tui-border-bright)',
          background: 'var(--color-tui-bg-deep)',
          padding: '8px',
          boxShadow: '0 0 40px rgba(57, 255, 20, 0.07)',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          width={554}
          height={1206}
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            borderRadius: '24px',
          }}
        />
      </span>
      {caption ? (
        <figcaption
          style={{
            fontSize: '11px',
            color: 'var(--color-tui-muted)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
