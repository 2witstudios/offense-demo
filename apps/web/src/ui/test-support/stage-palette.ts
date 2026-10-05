/**
 * Test support: the page-palette colour classes in rendered markup. The
 * stage is dark in both schemes, so in light the page's `text-ink`,
 * `text-accent` or `border-border` draw dark on dark there; stage content
 * takes the stage tokens instead.
 */
const pageColour =
  /^(?:[a-z-]+:)*(?:text|bg|border|fill|stroke|from|via|to|ring|outline|decoration)-(?:ink|ink-muted|ink-faint|accent|accent-strong|accent-soft|accent-ink|background|surface|surface-raised|surface-overlay|surface-sunken|border|border-strong)(?:\/\d+)?$/;

export const pageColourClasses = (html: string): readonly string[] =>
  [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap(([, list]) => (list ?? '').split(/\s+/))
    .filter((name) => pageColour.test(name));

/** The page-palette colour classes in an auth frame's stage panel. */
export const panelPageColours = (page: string): readonly string[] =>
  pageColourClasses(page.slice(page.indexOf('<aside')));
