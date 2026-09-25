/** The Localpost mark: a jellyfish on a disc. Colours come from the theme (--logo-bg / --logo-fg). */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="var(--logo-bg, #1ed760)" />
      {/* bell with a scalloped rim */}
      <path
        d="M7.5 15.2C7.5 10.3 11.3 6.8 16 6.8s8.5 3.5 8.5 8.4q-1.7 1.3-3.4 0q-1.7 1.3-3.4 0q-1.7 1.3-3.4 0q-1.7 1.3-3.4 0q-1.7 1.3-3.4 0z"
        fill="var(--logo-fg, #000)"
      />
      {/* tentacles */}
      <g fill="none" stroke="var(--logo-fg, #000)" strokeWidth="1.7" strokeLinecap="round">
        <path d="M10.6 17.4c-.9 1.4.9 2.6 0 4.1" />
        <path d="M14.1 17.6c-.9 1.7.9 3.2 0 5.1-.5.9-.3 1.7.3 2.3" />
        <path d="M17.9 17.6c.9 1.7-.9 3.2 0 5.1.5.9.3 1.7-.3 2.3" />
        <path d="M21.4 17.4c.9 1.4-.9 2.6 0 4.1" />
      </g>
      {/* eyes */}
      <circle cx="13.4" cy="12.2" r="1.05" fill="var(--logo-bg, #1ed760)" />
      <circle cx="18.6" cy="12.2" r="1.05" fill="var(--logo-bg, #1ed760)" />
    </svg>
  );
}
