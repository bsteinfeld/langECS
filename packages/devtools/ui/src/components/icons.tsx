// Inline SVG icons — stroke-based, 1em-sized, inheriting currentColor.
// All decorative: consumers put aria-labels on the surrounding <button>.

interface IconProps {
  size?: number;
}

function svgProps(size = 14) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
}

/** Hexagon-with-core product mark. */
export function MarkIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)} className="icon-mark" aria-hidden="true">
      <path d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6Z" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlayIcon({ size }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M4.5 2.8v10.4L13 8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DownloadIcon({ size }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M8 2.5v7.5M5 7.5 8 10.5l3-3M2.5 13h11" />
    </svg>
  );
}

export function CopyIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

export function CloseIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

export function ChevronIcon({ size = 11, open = false }: IconProps & { open?: boolean }) {
  return (
    <svg
      {...svgProps(size)}
      className={open ? 'icon-chevron open' : 'icon-chevron'}
      aria-hidden="true"
    >
      <path d="M5.5 3 11 8l-5.5 5" />
    </svg>
  );
}

export function PlusIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  );
}

export function TrashIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M2.5 4h11M6.5 2h3M5.5 4l.6 9.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8L11.5 4" />
    </svg>
  );
}

export function PencilIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="m9.8 2.8 3.4 3.4-7.6 7.6-3.8.4.4-3.8ZM8.6 4l3.4 3.4" />
    </svg>
  );
}

/** Raised hand for AwaitingHuman badges. */
export function HandIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M5 7.2V3.4a1 1 0 0 1 2 0V7m0-4.4a1 1 0 0 1 2 0V7m0-3.4a1 1 0 0 1 2 0v5.6c0 2.8-1.6 4.6-4 4.6S3.4 12.4 3 10L2.2 7.6a1 1 0 0 1 1.9-.7L5 9" />
    </svg>
  );
}

export function AlertIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M8 1.8 15 14H1Z" />
      <path d="M8 6.2v3.6M8 11.8v.4" />
    </svg>
  );
}

export function SendIcon({ size = 13 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M1.8 8 14.2 2.2 11 13.8 7.4 9.6Zm5.6 1.6 6.8-7.4" />
    </svg>
  );
}

export function HistoryIcon({ size = 12 }: IconProps) {
  return (
    <svg {...svgProps(size)} aria-hidden="true">
      <path d="M2.2 8a5.8 5.8 0 1 1 1.7 4.1M2.2 8H1m1.2 0 1.1-2M8 4.8V8l2.2 1.6" />
    </svg>
  );
}
