/**
 * Small helpers for writing SVG figures in a coordinate system of metres, y pointing down
 * (south), as in tile space.
 */

export type XY = readonly [number, number];

export const INK = "#333333";
export const MUTED = "#8a8a8a";
export const ACCENT = "#d2453b";
export const BLUE = "#2f6db5";
export const PAPER = "#ffffff";
export const GROUND = "#f1efe9";

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? "0" : n.toFixed(3).replace(/\.?0+$/, ""));

export const pts = (ps: readonly XY[]) => ps.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");

export function polygon(ps: readonly XY[], attrs: string): string {
  return `<polygon points="${pts(ps)}" ${attrs}/>`;
}

export function polyline(ps: readonly XY[], attrs: string): string {
  return `<polyline points="${pts(ps)}" fill="none" ${attrs}/>`;
}

export function line(a: XY, b: XY, attrs: string): string {
  return `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(b[0])}" y2="${fmt(b[1])}" ${attrs}/>`;
}

export function circle(c: XY, r: number, attrs: string): string {
  return `<circle cx="${fmt(c[0])}" cy="${fmt(c[1])}" r="${fmt(r)}" ${attrs}/>`;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text at `at`, `size` in the figure's units. */
export function text(at: XY, s: string, size: number, attrs = ""): string {
  return `<text x="${fmt(at[0])}" y="${fmt(at[1])}" font-size="${fmt(size)}" ${attrs}>${escape(s)}</text>`;
}

/** An arrow from `a` to `b` with a head of length `head`. */
export function arrow(a: XY, b: XY, head: number, attrs: string): string {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const d = Math.hypot(dx, dy);
  const [ux, uy] = [dx / d, dy / d];
  const base: XY = [b[0] - ux * head, b[1] - uy * head];
  const wing = head * 0.45;
  const tip = polygon(
    [b, [base[0] - uy * wing, base[1] + ux * wing], [base[0] + uy * wing, base[1] - ux * wing]],
    attrs.replace(/stroke=/, "fill="),
  );
  return line(a, base, attrs) + tip;
}

/** A complete SVG document: `width` CSS pixels wide, the view box in figure units. */
export function document(
  view: readonly [number, number, number, number],
  width: number,
  body: string,
  background = PAPER,
): string {
  const [x, y, w, h] = view;
  const height = Math.round((width * h) / w);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${background}"/>`,
    body,
    "</svg>",
    "",
  ].join("\n");
}

/** Several panels side by side, each `w` × `h` units, with a caption under each. */
export function panels(
  items: readonly { body: (origin: XY) => string; caption: string }[],
  w: number,
  h: number,
  gap: number,
  caption: number,
): { view: [number, number, number, number]; body: string } {
  const body = items
    .map(({ body, caption: c }, i) => {
      const x = i * (w + gap);
      return (
        body([x, 0]) +
        text([x + w / 2, h + caption * 1.4], c, caption, `text-anchor="middle" fill="${INK}"`)
      );
    })
    .join("\n");
  return { view: [0, 0, items.length * w + (items.length - 1) * gap, h + caption * 2], body };
}
