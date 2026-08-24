/* oxlint-disable react/only-export-components -- icon registry: a const map of
   tiny presentational icons plus the IconName type; fast-refresh doesn't apply. */
// Minimal stroke-icon set (no dependency). Each icon inherits currentColor.

type P = { className?: string }

const S = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-5 w-5'} aria-hidden="true">
    {children}
  </svg>
)

export const Icon = {
  dashboard: (p: P) => <S {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></S>,
  sales: (p: P) => <S {...p}><path d="M3 3h2l2.4 12.3a2 2 0 0 0 2 1.7h7.7a2 2 0 0 0 2-1.6L22 8H6" /><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /></S>,
  khata: (p: P) => <S {...p}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 3v18M12 8h5M12 12h5" /></S>,
  users: (p: P) => <S {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.5a3 3 0 0 1 0 5.6M17.5 20a5 5 0 0 0-3-4.6" /></S>,
  rupee: (p: P) => <S {...p}><path d="M7 4h10M7 8h10M15.5 4c1.8 3.6-.4 7-4.5 7H8l7 9" /></S>,
  purchase: (p: P) => <S {...p}><path d="M4 7h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8z" /><path d="M8.5 7a3.5 3.5 0 0 1 7 0" /></S>,
  inventory: (p: P) => <S {...p}><path d="M3 8l9-5 9 5-9 5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></S>,
  production: (p: P) => <S {...p}><path d="M3 21h18M4 21V10l5 3V10l5 3V6l5 3v12" /></S>,
  dispatch: (p: P) => <S {...p}><path d="M3 6h11v9H3z" /><path d="M14 9h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.6" /><circle cx="17.5" cy="18" r="1.6" /></S>,
  rokad: (p: P) => <S {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 12h.01M18 12h.01" /></S>,
  expenses: (p: P) => <S {...p}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></S>,
  reports: (p: P) => <S {...p}><path d="M4 20V4M4 20h16" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></S>,
  bell: (p: P) => <S {...p}><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></S>,
  settings: (p: P) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></S>,
  audit: (p: P) => <S {...p}><path d="M9 3h9a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7z" /><path d="M9 3v4H5M9 12h6M9 16h6" /></S>,
  plus: (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>,
  search: (p: P) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></S>,
  chevron: (p: P) => <S {...p}><path d="m9 6 6 6-6 6" /></S>,
  back: (p: P) => <S {...p}><path d="m15 6-6 6 6 6" /></S>,
  phone: (p: P) => <S {...p}><path d="M4 5c0 8 7 15 15 15l1.5-3.5-4-2-1.6 1.8A11 11 0 0 1 8.7 9.1L10.5 7.5l-2-4z" /></S>,
  whatsapp: (p: P) => <S {...p}><path d="M20 12a8 8 0 0 1-11.8 7L4 20l1-4.1A8 8 0 1 1 20 12z" /><path d="M9 9c0 4 2 6 6 6 .8 0 1-.6 1-1l-1.6-1-1 .8c-1.2-.5-2-1.3-2.4-2.4l.8-1L11 9c0-.4-.2-1-1-1s-1 .5-1 1z" /></S>,
  print: (p: P) => <S {...p}><path d="M6 9V3h12v6" /><rect x="4" y="9" width="16" height="8" rx="1.5" /><path d="M8 17h8v4H8z" /></S>,
  share: (p: P) => <S {...p}><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6" /></S>,
  check: (p: P) => <S {...p}><path d="m5 12 5 5 9-11" /></S>,
  clock: (p: P) => <S {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></S>,
  warn: (p: P) => <S {...p}><path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17h.01" /></S>,
  truck: (p: P) => <S {...p}><path d="M3 6h11v9H3z" /><path d="M14 9h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.6" /><circle cx="17.5" cy="18" r="1.6" /></S>,
  box: (p: P) => <S {...p}><path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></S>,
  close: (p: P) => <S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>,
  menu: (p: P) => <S {...p}><path d="M4 7h16M4 12h16M4 17h16" /></S>,
  filter: (p: P) => <S {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z" /></S>,
  download: (p: P) => <S {...p}><path d="M12 4v10M8 11l4 3 4-3" /><path d="M5 19h14" /></S>,
  arrowUp: (p: P) => <S {...p}><path d="M12 19V5M6 11l6-6 6 6" /></S>,
  arrowDown: (p: P) => <S {...p}><path d="M12 5v14M6 13l6 6 6-6" /></S>,
}

export type IconName = keyof typeof Icon
