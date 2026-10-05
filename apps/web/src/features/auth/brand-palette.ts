/**
 * The brand palette, copied as static values from `globals.css`'s
 * `light-dark()` tokens (`brand-palette.test.ts` keeps the two equal). No CSS
 * custom property can be read outside a browser stylesheet, so the emailed
 * link (`mail/layout.ts`) and the two confirm pages, which are never served
 * through the Next app's CSS pipeline, each need these as plain values.
 */
export type BrandPalette = {
  readonly background: string;
  /** The stage panel, the same in both schemes, with its own ink. */
  readonly surfaceStage: string;
  readonly stageInk: string;
  readonly stageInkMuted: string;
  /** The reverse mark's square on the stage. */
  readonly stageAccent: string;
  readonly surfaceRaised: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly border: string;
  readonly accent: string;
  readonly accentStrong: string;
  readonly accentInk: string;
  /** Amber notice surface: no equivalent token exists in globals.css yet. */
  readonly noticeBg: string;
  readonly noticeBorder: string;
  readonly noticeInk: string;
};

export const AUTH_BRAND_PALETTE: {
  readonly light: BrandPalette;
  readonly dark: BrandPalette;
} = {
  light: {
    background: '#f5f6f8',
    surfaceStage: '#1e2230',
    stageInk: '#f5f6f8',
    stageInkMuted: '#b9bfcc',
    stageAccent: '#a5b4fc',
    surfaceRaised: '#ffffff',
    ink: '#161922',
    inkMuted: '#4a5160',
    border: '#dde0e6',
    accent: '#4338ca',
    accentStrong: '#3730a3',
    accentInk: '#ffffff',
    noticeBg: '#fdf3e2',
    noticeBorder: '#ecd19c',
    noticeInk: '#6b4a0a',
  },
  dark: {
    background: '#0f1117',
    surfaceStage: '#1e2230',
    stageInk: '#f5f6f8',
    stageInkMuted: '#b9bfcc',
    stageAccent: '#a5b4fc',
    surfaceRaised: '#1b1f2a',
    ink: '#eef0f4',
    inkMuted: '#b3b9c5',
    border: '#272c39',
    accent: '#a5b4fc',
    accentStrong: '#c7d2fe',
    accentInk: '#1e1b4b',
    noticeBg: '#2a2110',
    noticeBorder: '#5a4516',
    noticeInk: '#f2d38c',
  },
};
