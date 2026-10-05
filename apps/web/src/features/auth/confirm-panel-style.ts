/**
 * The confirm pages' stage panel: the same dark stage in both schemes, with
 * its own ink, and the reverse brand mark as art. Part of
 * `confirmPageStylesheet`, which declares the `--af-*` tokens it reads.
 */
export const confirmPanelStyles = `.af-panel {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  width: 500px;
  flex-shrink: 0;
  border-radius: 16px;
  background: var(--af-surface-stage);
  color: var(--af-stage-ink);
  padding: 40px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 14px;
}

.af-panel-mark {
  position: absolute;
  top: -140px;
  right: -160px;
  width: 520px;
  height: 520px;
  z-index: -1;
}

/* Pre-mixed colours, not opacity: some engines rasterize a large,
   opacity-composited replaced element with a faint off-color box behind it
   (visible on Linux, not on macOS Chromium). Painting the already-blended
   colours directly has no layer to composite, so there is nothing to show
   through. */
.af-panel-square {
  fill: color-mix(in srgb, var(--af-stage-accent) 20%, var(--af-surface-stage));
}

.af-panel-disc {
  fill: var(--af-surface-stage);
}

.af-panel-kicker {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--af-stage-ink-muted);
}

.af-panel-title {
  margin: 0;
  font-family: var(--af-font-display);
  font-weight: 600;
  font-size: 1.9rem;
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.af-panel-body {
  margin: 0;
  color: var(--af-stage-ink-muted);
  line-height: 1.55;
}`;
