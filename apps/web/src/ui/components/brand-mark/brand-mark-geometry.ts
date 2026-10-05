/**
 * The placeholder brand mark: a rounded square holding a centred disc, on a
 * 24-unit drawing. It is the one geometry both renderers read — the React
 * `BrandMark` and the string SVG on the server-rendered confirm pages — so
 * replacing the mark means replacing this module (and nothing else).
 */
export const brandMarkGeometry = {
  /** Width and height of the drawing (the SVG viewBox). */
  size: 24,
  /** Corner radius of the square. */
  cornerRadius: 6,
  /** Radius of the disc at the centre. */
  discRadius: 5,
} as const;

/** The mark's two shapes as SVG markup, with a class on each. */
export const brandMarkMarkup = ({
  square,
  disc,
}: {
  readonly square: string;
  readonly disc: string;
}): string => {
  const { size, cornerRadius, discRadius } = brandMarkGeometry;
  const centre = size / 2;
  return `<rect class="${square}" width="${size}" height="${size}" rx="${cornerRadius}"></rect><circle class="${disc}" cx="${centre}" cy="${centre}" r="${discRadius}"></circle>`;
};
