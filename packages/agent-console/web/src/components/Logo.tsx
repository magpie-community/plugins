// Agent Console logo (same drawing as assets/icon.svg; strokes a little bolder so it still reads at 16–20px).
export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#26292b" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5.2">
        <path d="M14 20.5 25 31 14 41.5" stroke="#fff" />
        <path d="M29.14 23.61A12 12 0 1 1 46.63 39.92L48.6 47.6 39.85 42.93A12 12 0 0 1 29.14 38.39" stroke="#fff" />
        <path d="M35.6 35.4h6" stroke="#2dd4bf" />
      </g>
    </svg>
  );
}
