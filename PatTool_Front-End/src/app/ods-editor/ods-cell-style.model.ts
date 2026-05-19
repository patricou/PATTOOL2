/** Style de cellule extrait d’un ODS (FO / OpenDocument). */
export interface OdsCellStyle {
  backgroundColor?: string;
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textAlign?: string;
  textDecoration?: string;
  fontSize?: string;
  fontFamily?: string;
  verticalAlign?: string;
  whiteSpace?: string;
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}

/** Propriétés brutes d’un style ODF avant résolution d’héritage. */
export interface OdfStyleRecord {
  parent?: string;
  family?: string;
  tableCell: Record<string, string>;
  text: Record<string, string>;
}

export function odsStyleToAgGridCss(
  style: OdsCellStyle | undefined,
  displayFontSizePx?: number
): Record<string, string> | undefined {
  const css: Record<string, string> = {};
  if (!style && displayFontSizePx == null) {
    return undefined;
  }
  if (!style) {
    return { fontSize: `${displayFontSizePx}px` };
  }
  if (style.backgroundColor) {
    css['backgroundColor'] = style.backgroundColor;
  }
  if (style.color) {
    css['color'] = style.color;
  }
  if (style.fontWeight) {
    css['fontWeight'] = style.fontWeight;
  }
  if (style.fontStyle) {
    css['fontStyle'] = style.fontStyle;
  }
  if (style.textAlign) {
    css['textAlign'] = style.textAlign;
  }
  if (style.textDecoration) {
    css['textDecoration'] = style.textDecoration;
  }
  if (style.fontSize && displayFontSizePx == null) {
    css['fontSize'] = style.fontSize;
  }
  if (style.fontFamily) {
    css['fontFamily'] = style.fontFamily;
  }
  if (style.verticalAlign) {
    css['verticalAlign'] = style.verticalAlign;
  }
  if (style.whiteSpace) {
    css['whiteSpace'] = style.whiteSpace;
  }
  if (style.borderTop) {
    css['borderTop'] = style.borderTop;
  }
  if (style.borderRight) {
    css['borderRight'] = style.borderRight;
  }
  if (style.borderBottom) {
    css['borderBottom'] = style.borderBottom;
  }
  if (style.borderLeft) {
    css['borderLeft'] = style.borderLeft;
  }
  if (displayFontSizePx != null) {
    css['fontSize'] = `${displayFontSizePx}px`;
  }
  return Object.keys(css).length ? css : undefined;
}
