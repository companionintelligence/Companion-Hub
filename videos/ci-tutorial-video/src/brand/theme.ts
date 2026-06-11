/**
 * Companion Intelligence brand tokens.
 * Source of truth: /Users/liam/devel/ci/HUB/style.MD (Unified Style Guide),
 * which unifies CI-Hub globals.css, CI-Portal globals.css, and the ci.computer palette.
 */

export const color = {
  // Brand core ramp (ci.computer)
  tealLight: '#ABD4D8', // c1 — Hub dark --primary
  sageTeal: '#85C3B4', // c2
  mint: '#58EBBF', // c3 — energy accent, focus ring
  tealMid: '#409B9B', // c4
  tealDeep: '#2C676D', // c5 — dark border
  navy: '#244859', // c6
  tealNavy: '#1D5F6E', // c7
  brandTeal: '#0F717A', // c8 — primary
  tealBright: '#079D99', // c9
  cyanBright: '#82FFFF', // c10 — max energy accent
  siteCanvas: '#01100D', // near-black green
  sitePanel: '#064035',
  coral: '#F47C6C', // single warm contrast — emphasis only

  // Dark appliance signature (the CI look)
  bg: '#041620',
  bgDeep: '#031017',
  surface: '#081D28',
  surface2: '#0B2430',
  card: '#0A222E',
  cardHover: '#0E2A37',
  text: '#EEFCFF',
  textSoft: '#C5DADE',
  textMuted: '#9BB4BB',
  textDim: '#88A29E',
  border: '#2C676D',
  borderSoft: 'rgba(64,155,155,0.18)',
  borderStrong: 'rgba(64,155,155,0.32)',
  accent: '#82FCFC',
  accent2: '#19C6C8',
  accentGlow: 'rgba(130,252,252,0.24)',

  // Status (dark)
  success: '#20E887',
  warning: '#FFB020',
  danger: '#FF5263',
  offline: '#6F808A',
} as const;

export const gradient = {
  // Primary CTA button (Portal dark)
  button: 'linear-gradient(180deg, #129FA4, #0B6E74)',
  // Website accents
  cyanSweep: 'linear-gradient(90deg, #82FFE1, #409B9B)',
  tealCta: 'linear-gradient(90deg, #0F717A, #079D99)',
  orb: 'radial-gradient(circle, #82FFFF 0%, #58EBBF 50%, #079D99 100%)',
  // Hub dark body depth — whisper of teal lift over the flat canvas
  bgDepth:
    'radial-gradient(1200px circle at 50% -20%, rgba(45,90,110,0.14) 0%, transparent 52%)',
  iconChip:
    'radial-gradient(circle at 30% 20%, rgba(130,252,252,0.28), transparent 60%)',
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 10, // --radius base
  xl: 14,
} as const;

export const font = {
  family: 'Montserrat, system-ui, sans-serif',
  weight: {
    display: 200, // ExtraLight — large display headings, hero numerals
    body: 400,
    medium: 500, // buttons, labels
    semibold: 600, // section headings, card titles
    bold: 700, // page titles
  },
} as const;

export const shadow = {
  card: '0 12px 28px -22px rgba(1,9,14,0.40)',
  cardHover: '0 18px 34px -24px rgba(1,9,14,0.40)',
  glowMint: '0 0 40px rgba(88,235,191,0.45)',
  glowCyan: '0 0 60px rgba(130,255,255,0.35)',
} as const;

export const VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;
