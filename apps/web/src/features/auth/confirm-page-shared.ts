import { appConfig } from '../../app-config';
import {
  brandMarkGeometry,
  brandMarkMarkup,
} from '../../ui/components/brand-mark/brand-mark-geometry';
import { colorSchemeFor } from '../../ui/theme/theme-preference';
import { confirmPageStylesheet } from './confirm-page-style';
import { escapeHtml } from './mail/escape';
import type { PageContext } from './confirm-http-shared';

export { escapeHtml };

/** Headers for every page that can carry or follow a credential. */
export const pageHeaders = (extra: Record<string, string> = {}) => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  ...extra,
});

export const hiddenInput = (name: string, value: string | undefined) =>
  value === undefined
    ? ''
    : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

const { size: drawing } = brandMarkGeometry;

/**
 * The primary brand mark, drawn from the same geometry as
 * `ui/components/brand-mark`; its colours follow the scheme through the
 * stylesheet.
 */
const logoSvg = (size: number) =>
  `<svg class="af-logo" viewBox="0 0 ${drawing} ${drawing}" width="${size}" height="${size}" aria-hidden="true">${brandMarkMarkup({ square: 'af-logo-square', disc: 'af-logo-disc' })}</svg>`;

/** The reverse mark as the stage panel's art; its colours are in the stylesheet. */
const panelMarkSvg = () =>
  `<svg class="af-panel-mark" viewBox="0 0 ${drawing} ${drawing}" width="520" height="520" aria-hidden="true">${brandMarkMarkup({ square: 'af-panel-square', disc: 'af-panel-disc' })}</svg>`;

export type PanelContent = {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
};

/** The stage panel, hidden under the rail breakpoint (AUTH-4.7). */
const panel = (content: PanelContent | undefined) =>
  content
    ? `<aside class="af-panel" aria-hidden="true">${panelMarkSvg()}<p class="af-panel-kicker">${escapeHtml(content.kicker)}</p><p class="af-panel-title">${escapeHtml(content.title)}</p><p class="af-panel-body">${escapeHtml(content.body)}</p></aside>`
    : '';

export type AuthFrameContent = {
  readonly body: string;
  readonly footer: string;
  readonly panel?: PanelContent;
};

/**
 * Server-rendered, script-free AuthFrame layout, with no third-party or
 * external asset (the two fonts are same-origin, fixed-path files): the
 * brand row, the content column and the stage panel, matching the
 * approved design (artifact Nc1KBhwPeBhmUqK4UkqG1M). Nothing here is served
 * through the Next app's own stylesheet pipeline, so the whole visual layer
 * travels as one nonce'd `<style>` and this markup.
 */
function authFrame({ body, footer, panel: panelContent }: AuthFrameContent) {
  return (
    `<div class="af-page"><div class="af-main">` +
    `<a class="af-brand" href="/">${logoSvg(34)}<span class="af-word">${escapeHtml(appConfig.brand.displayName)}</span></a>` +
    `<div class="af-body">${body}</div>` +
    `<p class="af-foot">${footer}</p>` +
    `</div>${panel(panelContent)}</div>`
  );
}

/**
 * Server-rendered, script-free confirmation document with no third-party or
 * external asset: nothing to prefetch or leak. The `<style>` carries the
 * request's CSP nonce and is omitted entirely when no valid nonce was
 * provided (fail safe: the page still functions, just unstyled).
 */
export const confirmDocument = (
  title: string,
  content: AuthFrameContent,
  ctx: PageContext,
): string =>
  `<!doctype html><html lang="en" data-theme="${ctx.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta name="color-scheme" content="${colorSchemeFor(ctx.theme)}">${ctx.nonce ? `<style nonce="${ctx.nonce}">${confirmPageStylesheet()}</style>` : ''}<title>${escapeHtml(title)}</title></head><body><main>${authFrame(content)}</main></body></html>`;
