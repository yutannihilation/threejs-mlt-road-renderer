export type PropValue = string | number | boolean;
/** One feature's properties, as `featureProps` reads them from the columns. */
export type Props = Readonly<Record<string, PropValue | undefined>>;

export type Rgb = readonly [number, number, number];
/** A colour: `[r, g, b]` bytes, or `#rgb`, `#rrggbb`, `rgb(r g b)` / `rgb(r, g, b)`. */
export type ColorSpec = Rgb | string;

/** How a free end (one that meets no other line) is closed. */
export type Cap = "butt" | "round" | "square";

/**
 * How roads are drawn, evaluated per feature. Widths are metres on the ground.
 *
 * Groups draw in ascending order, each as every casing then every fill, so a group's outline wraps
 * its whole network and a higher group (a bridge) draws over a lower one with its own outline.
 * Within a group, a higher rank's fill draws over a lower rank's where they cross.
 */
export interface RoadStyle {
  /** Draw only the features this accepts. Default: all. */
  readonly filter?: (props: Props) => boolean;
  /** The draw group, an integer. Default: 0. */
  readonly group?: (props: Props) => number;
  /** The order within the group, an integer. Default: 0. */
  readonly rank?: (props: Props) => number;
  /** The road's full width in metres. */
  readonly width: (props: Props) => number;
  readonly color: (props: Props) => ColorSpec;
  /** The casing drawn under the fill; `width` is per side, in metres. Default: none. */
  readonly outline?: {
    readonly width: (props: Props) => number;
    readonly color: (props: Props) => ColorSpec;
  };
  /** The cap at free ends. Default: `"butt"`. */
  readonly cap?: Cap;
}

/** A style evaluated for a tile: one slot per line, through the line's feature. */
export interface StyleTable {
  readonly lines: number;
  /** 1 for a line that is drawn; a hidden line's other slots are 0. */
  readonly visible: Uint8Array;
  readonly group: Int32Array;
  readonly rank: Int32Array;
  /** Half the fill width, metres. */
  readonly halfWidth: Float32Array;
  /** Half the fill width plus the outline, metres. */
  readonly outerHalfWidth: Float32Array;
  /** `r, g, b` per line. */
  readonly fill: Uint8Array;
  readonly casing: Uint8Array;
  /** The distinct groups of the visible lines, ascending. */
  readonly groups: readonly number[];
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB = /^rgb\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})\s*\)$/i;

/** Throws for a colour it does not understand, naming it. */
export function parseColor(spec: ColorSpec): Rgb {
  if (typeof spec !== "string") {
    const [r, g, b] = spec;
    if (spec.length !== 3 || ![r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) {
      throw new Error(`not a colour: [${spec.join(", ")}]`);
    }
    return [r, g, b];
  }
  const hex3 = HEX3.exec(spec);
  if (hex3)
    return [1, 2, 3].map((i) => Number.parseInt(hex3[i] + hex3[i], 16)) as [number, number, number];
  const hex6 = HEX6.exec(spec);
  if (hex6) return [1, 2, 3].map((i) => Number.parseInt(hex6[i], 16)) as [number, number, number];
  const rgb = RGB.exec(spec);
  if (rgb) {
    const [r, g, b] = [1, 2, 3].map((i) => Number(rgb[i]));
    if (r <= 255 && g <= 255 && b <= 255) return [r, g, b];
  }
  throw new Error(`not a colour: "${spec}"`);
}

/** One feature's evaluated style. */
interface Evaluated {
  visible: boolean;
  group: number;
  rank: number;
  halfWidth: number;
  outerHalfWidth: number;
  fill: Rgb;
  casing: Rgb;
}

function evaluateLine(style: RoadStyle, props: Props, line: number): Evaluated {
  const hidden: Evaluated = {
    visible: false,
    group: 0,
    rank: 0,
    halfWidth: 0,
    outerHalfWidth: 0,
    fill: [0, 0, 0],
    casing: [0, 0, 0],
  };
  if (style.filter && !style.filter(props)) return hidden;
  const integer = (name: string, value: number) => {
    if (!Number.isInteger(value))
      throw new Error(`line ${line}: ${name} ${value} is not an integer`);
    return value;
  };
  const metres = (name: string, value: number) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`line ${line}: ${name} ${value} is not a finite number of metres >= 0`);
    }
    return value;
  };
  const group = integer("group", style.group?.(props) ?? 0);
  const rank = integer("rank", style.rank?.(props) ?? 0);
  const halfWidth = metres("width", style.width(props)) / 2;
  const fill = parseColor(style.color(props));
  const outline = style.outline;
  const outlineWidth = outline ? metres("outline width", outline.width(props)) : 0;
  const casing = outline ? parseColor(outline.color(props)) : fill;
  return {
    visible: true,
    group,
    rank,
    halfWidth,
    outerHalfWidth: halfWidth + outlineWidth,
    fill,
    casing,
  };
}

/**
 * Evaluate `style` for each line's properties, once per distinct `Props` object: the lines of one
 * feature share theirs. Throws, naming the line, for a width that is not a finite number of
 * metres >= 0 or a group or rank that is not an integer.
 */
export function evaluateStyle(style: RoadStyle, props: readonly Props[]): StyleTable {
  const lines = props.length;
  const table = {
    lines,
    visible: new Uint8Array(lines),
    group: new Int32Array(lines),
    rank: new Int32Array(lines),
    halfWidth: new Float32Array(lines),
    outerHalfWidth: new Float32Array(lines),
    fill: new Uint8Array(lines * 3),
    casing: new Uint8Array(lines * 3),
  };
  const evaluated = new Map<Props, Evaluated>();
  const groups = new Set<number>();
  for (let line = 0; line < lines; line++) {
    let e = evaluated.get(props[line]);
    if (!e) {
      e = evaluateLine(style, props[line], line);
      evaluated.set(props[line], e);
    }
    if (!e.visible) continue;
    table.visible[line] = 1;
    table.group[line] = e.group;
    table.rank[line] = e.rank;
    table.halfWidth[line] = e.halfWidth;
    table.outerHalfWidth[line] = e.outerHalfWidth;
    table.fill.set(e.fill, line * 3);
    table.casing.set(e.casing, line * 3);
    groups.add(e.group);
  }
  return { ...table, groups: [...groups].sort((a, b) => a - b) };
}

/** Texels per row of the style texture; line `l`'s texels are `2l` and `2l + 1`, row-major. */
export const STYLE_WIDTH = 1024;

/**
 * The table as `RGBA32F` texels, two per line: the fill colour (0–1) with the half width in
 * metres, then the casing colour with the outer half width. `height` rows of `STYLE_WIDTH`.
 */
export function styleTexels(table: StyleTable): { texels: Float32Array; height: number } {
  const height = Math.max(1, Math.ceil((table.lines * 2) / STYLE_WIDTH));
  const texels = new Float32Array(STYLE_WIDTH * height * 4);
  for (let line = 0; line < table.lines; line++) {
    const t = line * 8;
    for (let c = 0; c < 3; c++) {
      texels[t + c] = table.fill[line * 3 + c] / 255;
      texels[t + 4 + c] = table.casing[line * 3 + c] / 255;
    }
    texels[t + 3] = table.halfWidth[line];
    texels[t + 7] = table.outerHalfWidth[line];
  }
  return { texels, height };
}
