import { AUTH_BRAND_PALETTE } from './brand-palette';
import { confirmPanelStyles } from './confirm-panel-style';

/** Same-origin, fixed paths (AUTH-4.7): this route cannot see build hashes. */
const INSTRUMENT_SANS_PATH = '/fonts/instrument-sans-latin.woff2';

const lightDark = (key: keyof typeof AUTH_BRAND_PALETTE.light) =>
  `light-dark(${AUTH_BRAND_PALETTE.light[key]}, ${AUTH_BRAND_PALETTE.dark[key]})`;

/**
 * The confirm pages' entire visual layer: one class-based stylesheet, no
 * external files, meant to sit behind a request's CSP nonce. Tokens use
 * `light-dark()` exactly like `globals.css` (ADR 0027), driven by the same
 * `data-theme` attribute the app's `<html>` carries.
 */
export function confirmPageStylesheet(): string {
  return `
:root, :root[data-theme='dark'] { color-scheme: dark; }
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='system'] { color-scheme: light dark; }

:root {
  --af-background: ${lightDark('background')};
  --af-surface-stage: ${lightDark('surfaceStage')};
  --af-stage-ink: ${lightDark('stageInk')};
  --af-stage-ink-muted: ${lightDark('stageInkMuted')};
  --af-surface-raised: ${lightDark('surfaceRaised')};
  --af-ink: ${lightDark('ink')};
  --af-ink-muted: ${lightDark('inkMuted')};
  --af-border: ${lightDark('border')};
  --af-accent: ${lightDark('accent')};
  --af-accent-strong: ${lightDark('accentStrong')};
  --af-accent-ink: ${lightDark('accentInk')};
  --af-stage-accent: ${lightDark('stageAccent')};
  --af-notice-bg: ${lightDark('noticeBg')};
  --af-notice-border: ${lightDark('noticeBorder')};
  --af-notice-ink: ${lightDark('noticeInk')};
  --af-font-display: var(--af-font-body);
  --af-font-body: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

@font-face {
  font-family: 'Instrument Sans';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('${INSTRUMENT_SANS_PATH}') format('woff2');
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  background: var(--af-background);
  color: var(--af-ink);
  font-family: var(--af-font-body);
}

body {
  min-height: 100vh;
  display: flex;
}

/* main is body's one flex item: without an explicit flex-basis it sizes
   to its content, so the frame stops short of the viewport and the panel
   floats mid-page instead of sitting flush right. */
main {
  flex: 1;
  display: flex;
  min-width: 0;
}

.af-page {
  flex: 1;
  display: flex;
  gap: 24px;
  padding: 24px;
}

.af-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 48px;
  padding: 16px 64px 32px;
}

.af-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--af-ink);
  text-decoration: none;
  align-self: flex-start;
}

.af-logo {
  flex-shrink: 0;
}
.af-logo-square { fill: var(--af-accent); }
.af-logo-disc { fill: var(--af-accent-ink); }

.af-word {
  font-family: var(--af-font-display);
  font-weight: 600;
  font-size: 1.25rem;
  letter-spacing: -0.015em;
}

.af-body {
  max-width: 26rem;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.af-eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--af-accent);
}

.af-eyebrow.af-muted {
  color: var(--af-ink-muted);
}

.af-body h1 {
  margin: 0;
  font-family: var(--af-font-display);
  font-weight: 600;
  font-size: 2.25rem;
  line-height: 1.1;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.af-lede {
  margin: 0;
  font-size: 1.0625rem;
  line-height: 1.55;
}

.af-why {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.55;
  color: var(--af-ink-muted);
}

.af-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
}

.af-btn {
  font: inherit;
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  background: var(--af-accent);
  color: var(--af-accent-ink);
  border: 0;
  border-radius: 8px;
  padding: 14px 22px;
  align-self: flex-start;
  transition: background 150ms ease;
}

.af-btn:hover {
  background: var(--af-accent-strong);
}

.af-btn:focus-visible,
.af-link:focus-visible,
.af-input:focus-visible {
  outline: 3px solid var(--af-accent);
  outline-offset: 3px;
}

.af-link {
  color: var(--af-ink);
  font-weight: 600;
  text-underline-offset: 3px;
}

.af-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  font-size: 0.95rem;
}

.af-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.af-field label {
  font-size: 0.875rem;
  font-weight: 600;
}

.af-input {
  font: inherit;
  font-size: 1rem;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--af-surface-raised);
  color: var(--af-ink);
  border: 1px solid var(--af-border);
}

.af-notice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--af-notice-bg);
  border: 1px solid var(--af-notice-border);
  color: var(--af-notice-ink);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 0.925rem;
  line-height: 1.5;
}

.af-notice-icon {
  font-weight: 700;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
}

.af-notice p {
  margin: 0;
}

.af-foot {
  font-size: 0.875rem;
  color: var(--af-ink-muted);
  line-height: 1.5;
}

${confirmPanelStyles}

/* The rail breakpoint (globals.css --breakpoint-rail): hide the panel and
   let the content column take the full width. This alone must not trigger
   the phone-only rules below (a 1024 px laptop or tablet keeps the design's
   normal button and heading sizes; only a narrow phone gets the stretched
   button and smaller heading). */
@media (max-width: 1100px) {
  .af-panel { display: none; }
  .af-main { padding: 8px 8px 16px; gap: 40px; }
}

/* Phone-only, matching the mock's own narrow breakpoint, down to 320 px
   reflow. */
@media (max-width: 480px) {
  .af-page { padding: 16px; }
  .af-body h1 { font-size: 1.9rem; }
  .af-btn { align-self: stretch; }
}

@media (prefers-reduced-motion: reduce) {
  .af-btn { transition: none; }
}
`;
}
