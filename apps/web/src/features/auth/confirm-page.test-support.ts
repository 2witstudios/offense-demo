/** The shape both confirm pages' script- and asset-free, single-h1 documents must have. */
export const singleH1PageShape = (html: string, token: string) => ({
  mains: (html.match(/<main/g) ?? []).length,
  h1s: (html.match(/<h1/g) ?? []).length,
  tokenOccurrences: (html.match(new RegExp(token, 'g')) ?? []).length,
  hasScriptOrAsset: /<script|<link|<img|<iframe/i.test(html),
});

export const EXPECTED_SINGLE_H1_PAGE_SHAPE = {
  mains: 1,
  h1s: 1,
  tokenOccurrences: 1,
  hasScriptOrAsset: false,
};
