/** Diagrams: the pipeline, the GPU's inputs, and geometry drawn with its construction. */
import { draw, MAJOR, MINOR, network, type Road, triangles, view } from "./roads";
import {
  ACCENT,
  arrow,
  BLUE,
  circle,
  document,
  GROUND,
  INK,
  line,
  MUTED,
  panels,
  polygon,
  polyline,
  text,
  type XY,
} from "./svg";

/** A box with a bold title and lines of text, `w` × `h`, at `at`. */
function box(
  at: XY,
  w: number,
  h: number,
  title: string,
  lines: readonly string[] = [],
  fill = "#f7f5f0",
  code = false,
): string {
  const [x, y] = at;
  const font = code ? `font-family="Menlo, Consolas, monospace" xml:space="preserve"` : "";
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2" fill="${fill}" stroke="${INK}" stroke-width="0.3"/>`,
    text([x + 2, y + 5], title, 3.4, `font-weight="bold" fill="${INK}"`),
    ...lines.map((l, i) =>
      text([x + 2, y + 10 + i * 4.2], l, code ? 2.7 : 2.9, `fill="${INK}" ${font}`),
    ),
  ].join("");
}

function pipeline(): string {
  const steps: [string, string[]][] = [
    ["Tile", ["MLT, decoded", "to typed arrays"]],
    ["Stitch", ["with neighbours,", "cut to a margin"]],
    ["Nodes", ["shared line ends"]],
    ["Style table", ["group, rank, width,", "colours per line"]],
    ["Tessellate", ["ribbons and", "junctions"]],
    ["Upload", ["buffers and a", "style texture"]],
    ["Draw", ["casings, then", "fills, per group"]],
  ];
  const [w, h, gap] = [30, 22, 8];
  const body = steps
    .map(([t, ls], i) => {
      const x = 2 + i * (w + gap);
      const b = box([x, 2], w, h, t, ls, i === 4 ? "#fbe6c8" : "#f7f5f0");
      return i
        ? arrow(
            [x - gap + 0.6, 2 + h / 2],
            [x - 0.6, 2 + h / 2],
            2,
            `stroke="${INK}" stroke-width="0.4"`,
          ) + b
        : b;
    })
    .join("");
  const width = 4 + steps.length * w + (steps.length - 1) * gap;
  const note = text(
    [2, h + 9],
    "Once per tile, on the CPU: everything up to Upload. Every frame, on the GPU: Draw.",
    3,
    `fill="${MUTED}"`,
  );
  return document([0, 0, width, h + 12], 1000, body + note);
}

function gpu(): string {
  const body = [
    box(
      [2, 2],
      84,
      34,
      "BufferGeometry (per tile)",
      [
        "position     a centreline point",
        "aExtrude     two offset vectors e1, e2",
        "aWidthLines  the lines l1, l2 they scale by",
        "aLine        the line giving the colour",
        "index        triangles, grouped by draw group",
      ],
      undefined,
      true,
    ),
    box(
      [2, 42],
      84,
      26,
      "DataTexture, RGBA32F",
      [
        "two texels per line:",
        "fill:   r, g, b, half width",
        "casing: r, g, b, half width + outline",
      ],
      undefined,
      true,
    ),
    box(
      [2, 74],
      84,
      26,
      "Uniforms (per draw)",
      ["uPass   0 casing, 1 fill", "uClip   the tile's footprint", "uCamera, uCasingDepthOffset"],
      undefined,
      true,
    ),
    box(
      [100, 26],
      86,
      40,
      "ShaderMaterial (GLSL 3)",
      [
        "vertex shader:",
        "  w = texelFetch(style, line, pass).a",
        "  p = position + (e1·w(l1) + e2·w(l2)) × metre",
        "  casing depth: 1 m lower, along the ray",
        "fragment shader:",
        "  discard outside uClip",
        "  colour = texelFetch(style, aLine, pass).rgb",
      ],
      "#fbe6c8",
      true,
    ),
    arrow([86, 19], [100, 38], 2, `stroke="${INK}" stroke-width="0.4"`),
    arrow([86, 55], [100, 48], 2, `stroke="${INK}" stroke-width="0.4"`),
    arrow([86, 87], [100, 58], 2, `stroke="${INK}" stroke-width="0.4"`),
  ].join("");
  return document([0, 0, 188, 102], 960, body);
}

/** The casing pass alone, then with the fill pass over it. */
function passes(): string {
  const roads: Road[] = [
    {
      kind: MAJOR,
      points: [
        [-60, 0],
        [0, 0],
      ],
    },
    {
      kind: MAJOR,
      points: [
        [0, 0],
        [60, -10],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [-6, -60],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [8, 60],
      ],
    },
  ];
  const net = network(roads);
  const tris = triangles(net);
  const only = (pass: 0 | 1) =>
    tris
      .filter((t) => t.pass === pass)
      .map((t) => {
        const c = (pass ? net.table.fill : net.table.casing).subarray(t.line * 3, t.line * 3 + 3);
        const hex = `#${Array.from(c, (v) => v.toString(16).padStart(2, "0")).join("")}`;
        return polygon(t.points, `fill="${hex}" stroke="${hex}" stroke-width="0.06"`);
      })
      .join("");
  const { view: v, body } = panels(
    [
      {
        caption: "1. Every casing, at its outer width",
        body: (o) => view(o, 100, [0, 0], 26, only(0)),
      },
      {
        caption: "2. Every fill over them",
        body: (o) => view(o, 100, [0, 0], 26, only(0) + only(1)),
      },
    ],
    100,
    100,
    6,
    4.2,
  );
  return document(v, 660, body);
}

/** Offsets as terms: a straight piece, a miter, and a junction corner. */
function offsets(): string {
  const w = 6;
  const ribbon = (ps: readonly XY[]) =>
    polyline(ps, `stroke="#e9e4da" stroke-width="${2 * w}" stroke-linejoin="miter"`);
  const centre = (ps: readonly XY[]) =>
    polyline(ps, `stroke="${MUTED}" stroke-width="0.3" stroke-dasharray="1.2 0.8"`);
  const vec = (a: XY, b: XY, c = ACCENT) => arrow(a, b, 1.6, `stroke="${c}" stroke-width="0.45"`);
  const label = (at: XY, s: string, c = INK, anchor = "start") =>
    text(at, s, 3.3, `fill="${c}" text-anchor="${anchor}"`);
  // (a) straight
  const a = (o: XY) => {
    const [x, y] = o;
    const ps: XY[] = [
      [x + 8, y + 50],
      [x + 92, y + 50],
    ];
    const p: XY = [x + 50, y + 50];
    return [
      ribbon(ps),
      centre(ps),
      circle(p, 0.9, `fill="${INK}"`),
      vec(p, [p[0], p[1] - w]),
      vec(p, [p[0], p[1] + w]),
      circle([p[0], p[1] - w], 0.8, `fill="${ACCENT}"`),
      circle([p[0], p[1] + w], 0.8, `fill="${ACCENT}"`),
      label([p[0] + 2, p[1] - w - 1.5], "n × w(line)"),
      label([p[0] + 2, p[1] + 3.5], "centreline point"),
      label([x + 50, y + 76], "the same vector, scaled by each pass's width", INK, "middle"),
    ].join("");
  };
  // (b) miter at a bend of 40°
  const b = (o: XY) => {
    const [x, y] = o;
    const turn = (40 * Math.PI) / 180;
    const p: XY = [x + 45, y + 55];
    const q: XY = [p[0] + 50 * Math.cos(-turn), p[1] + 50 * Math.sin(-turn)];
    const ps: XY[] = [[x + 4, p[1]], p, q];
    const bis = -turn / 2 - Math.PI / 2;
    const k = 1 / Math.cos(turn / 2);
    const m: XY = [p[0] + w * k * Math.cos(bis), p[1] + w * k * Math.sin(bis)];
    return [
      ribbon(ps),
      centre(ps),
      circle(p, 0.9, `fill="${INK}"`),
      vec(p, m),
      circle(m, 0.8, `fill="${ACCENT}"`),
      label([m[0] - 2, m[1] - 2.5], "m × w(line)", INK, "end"),
      label([x + 50, y + 76], "|m| = 1 / cos(turn / 2)", INK, "middle"),
    ].join("");
  };
  // (c) junction corner between a (west) and b (north-east), widths wa and wb
  const c = (o: XY) => {
    const [x, y] = o;
    const p: XY = [x + 58, y + 50];
    const [wa, wb] = [7, 4];
    const ua: XY = [-1, 0];
    const tb = (-55 * Math.PI) / 180;
    const ub: XY = [Math.cos(tb), Math.sin(tb)];
    // From a round to b on the screen's clockwise side: a's left (north) edge meets b's right.
    const theta = Math.PI - 55 * (Math.PI / 180);
    const sin = Math.sin(theta);
    const cnr: XY = [
      p[0] + (wa * ub[0] + wb * ua[0]) / sin,
      p[1] + (wa * ub[1] + wb * ua[1]) / sin,
    ];
    const end = (u: XY, len: number): XY => [p[0] + u[0] * len, p[1] + u[1] * len];
    return [
      polyline([p, end(ua, 54)], `stroke="#e9e4da" stroke-width="${2 * wa}"`),
      polyline([p, end(ub, 50)], `stroke="#e9e4da" stroke-width="${2 * wb}"`),
      centre([p, end(ua, 54)]),
      centre([p, end(ub, 50)]),
      vec(p, end(ua, 14), BLUE),
      vec(p, end(ub, 14), BLUE),
      label([p[0] - 14, p[1] + 4.5], "u_a", BLUE),
      label([end(ub, 14)[0] + 2, end(ub, 14)[1] + 1], "u_b", BLUE),
      label([x + 6, p[1] + wa + 4.5], "road a, half width w_a"),
      label([end(ub, 40)[0] - 4, end(ub, 40)[1] + 1], "road b, w_b", INK, "end"),
      circle(p, 0.9, `fill="${INK}"`),
      vec(p, cnr),
      circle(cnr, 0.9, `fill="${ACCENT}"`),
      label([cnr[0] - 1.5, cnr[1] - 2], "c", ACCENT, "end"),
      label([x + 50, y + 76], "c = (u_b / sin θ) × w_a + (u_a / sin θ) × w_b", INK, "middle"),
    ].join("");
  };
  const { view: v, body } = panels(
    [
      { caption: "A straight piece: one term", body: a },
      { caption: "A miter: one term, stretched", body: b },
      { caption: "A junction corner: two terms, two lines", body: c },
    ],
    100,
    80,
    6,
    3.8,
  );
  return document(v, 1100, body);
}

/** The pieces of a junction: the node, the corners, each link's mouth, and the core. */
function anatomy(): string {
  const roads: Road[] = [
    {
      kind: MAJOR,
      points: [
        [-60, 0],
        [0, 0],
      ],
    },
    {
      kind: MAJOR,
      points: [
        [0, 0],
        [60, 0],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [-34, -50],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [20, 60],
      ],
    },
  ];
  const net = network(roads);
  const cores = triangles(net).filter((t) => t.pass === 1 && t.core);
  const corners = new Map<string, XY>();
  for (const t of cores)
    for (const p of t.points)
      if (Math.hypot(p[0], p[1]) > 0.5) corners.set(p.map((v) => v.toFixed(2)).join(), p);
  const corner = [...corners.values()].reduce((a, b) => (b[0] - b[1] > a[0] - a[1] ? b : a));
  const mouth: XY = [(corner[0] + 0) / 1, 0];
  const lead = (from: XY, to: XY, c: string) => line(from, to, `stroke="${c}" stroke-width="0.12"`);
  const note = (at: XY, s: string, c: string, anchor = "start") =>
    text(at, s, 1.25, `fill="${c}" text-anchor="${anchor}"`);
  const southMouth = [...corners.values()].filter((p) => p[1] > 0);
  const mid: XY = [(southMouth[0][0] + southMouth[1][0]) / 2, southMouth[0][1]];
  void mouth;
  const body = [
    draw(net),
    ...cores.map((t) =>
      polygon(
        t.points,
        `fill="${ACCENT}" fill-opacity="0.15" stroke="${ACCENT}" stroke-width="0.15"`,
      ),
    ),
    ...[...corners.values()].map((p) => circle(p, 0.5, `fill="${ACCENT}"`)),
    circle([0, 0], 0.5, `fill="${INK}"`),
    lead([0, 0], [-8, -11], INK),
    note([-8.4, -11.4], "node", INK, "end"),
    lead(corner, [5, -14], ACCENT),
    note([5.4, -14.4], "corner: two edges meet", ACCENT),
    lead([-1.5, 2], [-9, 12], ACCENT),
    note([-9.4, 13.4], "core: triangles", ACCENT, "end"),
    lead(mid, [9, 13], INK),
    note([9.4, 14.2], "a link's mouth", INK),
  ].join("");
  return document([0, 0, 100, 100], 560, view([0, 0], 100, [0, 0], 20, body));
}

/** The owner's outline: each end's edge as far as it runs straight, a round join round a bend. */
function outline(): string {
  const roads: Road[] = [
    {
      kind: MAJOR,
      points: [
        [-60, 14],
        [-22, 0],
        [0, 0],
      ],
    },
    {
      kind: MAJOR,
      points: [
        [0, 0],
        [45, -45],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [-4, -60],
      ],
    },
    {
      kind: MINOR,
      points: [
        [0, 0],
        [16, 60],
      ],
    },
  ];
  const net = network(roads);
  const w = MAJOR.half;
  const d = Math.SQRT1_2;
  // North-west side: a's north edge from the end of its straight run to the miter with b.
  const inner: XY[] = [
    [-22, -w],
    [-w * Math.tan(Math.PI / 8), -w],
    [45 * d - w * d, -45 * d - w * d],
  ];
  // South-east side: a's south edge, a round join from straight down to b's right normal, b's edge.
  const fan: XY[] = [];
  for (let t = Math.PI / 2; t >= Math.PI / 4 - 1e-9; t -= Math.PI / 48)
    fan.push([w * Math.cos(t), w * Math.sin(t)]);
  const outer: XY[] = [[-22, w], ...fan, [45 * d + w * d, -45 * d + w * d]];
  const dashed = `stroke="${ACCENT}" stroke-width="0.35" stroke-dasharray="1.2 0.7"`;
  const body = [
    draw(net),
    polyline(inner, dashed),
    polyline(outer, dashed),
    line([-22, -w - 3], [-22, w + 3], `stroke="${BLUE}" stroke-width="0.3"`),
    text([-21.5, w + 5.5], "the straight run ends", 2.2, `fill="${BLUE}"`),
    text([4, 9.5], "round join", 2.2, `fill="${ACCENT}"`),
    text([-21, -7], "the owner's edges", 2.2, `fill="${ACCENT}"`),
  ].join("");
  return document([0, 0, 100, 100], 520, view([0, 0], 100, [-4, 0], 28, body));
}

/** Depth for the casing: straight down from the road, against along the view ray. */
function depth(): string {
  // Side view, heights much exaggerated: x along the ground, h up.
  const cam: XY = [4, 40];
  const slope = -0.5;
  const [lower, upper, offset] = [10, 14, 8];
  const at = (h: number): XY => [cam[0] + (h - cam[1]) / slope, h];
  const panel = (alongRay: boolean) => (o: XY) => {
    const sh = ([x, h]: XY): XY => [o[0] + x, o[1] + 48 - h];
    const hitUpper = at(upper);
    const hitLower = at(lower);
    const casing: XY = alongRay ? at(upper - offset) : [hitUpper[0], upper - offset];
    const say = (p: XY, s: string, c: string, anchor = "middle") =>
      text(sh(p), s, 2.8, `fill="${c}" text-anchor="${anchor}"`);
    return [
      line(sh([0, 0]), sh([100, 0]), `stroke="${MUTED}" stroke-width="0.3"`),
      line(sh([40, lower]), sh([99, lower]), `stroke="#f4b860" stroke-width="1.6"`),
      line(sh([24, upper]), sh([68, upper]), `stroke="#b9b9b9" stroke-width="1.6"`),
      say([97, lower - 4], "road A", INK, "end"),
      say([25, upper + 2.5], "road B, a little higher", INK, "start"),
      line(sh(cam), sh(at(1)), `stroke="${BLUE}" stroke-width="0.35"`),
      circle(sh(cam), 1.3, `fill="${BLUE}"`),
      say([cam[0] + 2.5, cam[1] + 0.8], "camera", BLUE, "start"),
      say([18, 37.5], "view ray", BLUE, "start"),
      alongRay
        ? ""
        : line(
            sh(hitUpper),
            sh(casing),
            `stroke="${ACCENT}" stroke-width="0.4" stroke-dasharray="1 0.6"`,
          ),
      circle(sh(hitUpper), 0.9, `fill="${INK}"`),
      circle(sh(hitLower), 0.9, `fill="#d9821b"`),
      circle(sh(casing), 1, `fill="${ACCENT}"`),
      say(
        alongRay ? [casing[0] - 2.5, casing[1] - 2.5] : [casing[0] - 2, casing[1] - 4],
        alongRay ? "B's casing: behind A" : "B's casing: in front of A",
        ACCENT,
        "end",
      ),
    ].join("");
  };
  const { view: v, body } = panels(
    [
      { caption: "Straight down: at a low angle, B's casing hides A", body: panel(false) },
      { caption: "Along the ray: A covers B's casing from any angle", body: panel(true) },
    ],
    100,
    50,
    6,
    3.6,
  );
  return document(v, 1000, body);
}

/** A tile's buffer, the pieces of a line in two tiles, and the stitched line cut to the margin. */
function tiles(): string {
  const tile = 50;
  const buf = 4;
  const margin = 10;
  const roadPath: XY[] = [
    [10, 44],
    [40, 35],
    [62, 40],
    [92, 28],
  ];
  const clipAt = (x: number): XY => {
    if (x <= roadPath[0][0]) return roadPath[0];
    if (x >= roadPath[roadPath.length - 1][0]) return roadPath[roadPath.length - 1];
    for (let i = 1; i < roadPath.length; i++) {
      const [a, b] = [roadPath[i - 1], roadPath[i]];
      if ((a[0] - x) * (b[0] - x) <= 0) {
        const t = (x - a[0]) / (b[0] - a[0]);
        return [x, a[1] + t * (b[1] - a[1])];
      }
    }
    return roadPath[0];
  };
  const top = 12;
  const tileRect = (x: number, c: string) =>
    `<rect x="${x}" y="${top}" width="${tile}" height="${tile}" fill="${c}" stroke="${INK}" stroke-width="0.35"/>`;
  const boxAround = (x: number, pad: number, attrs: string) =>
    `<rect x="${x - pad}" y="${top - pad}" width="${tile + 2 * pad}" height="${tile + 2 * pad}" fill="none" ${attrs}/>`;
  const piece = (from: number, to: number, c: string, width: number) => {
    const inside = roadPath.filter(([x]) => x > from && x < to);
    return polyline(
      [clipAt(from), ...inside, clipAt(to)],
      `stroke="${c}" stroke-width="${width}" stroke-linecap="butt" stroke-linejoin="round"`,
    );
  };
  const left = (o: XY) =>
    `<g transform="translate(${o[0] + 12} ${o[1]})">` +
    [
      tileRect(0, "#f7f5f0"),
      tileRect(tile, "#efece4"),
      boxAround(0, buf, `stroke="${ACCENT}" stroke-width="0.3" stroke-dasharray="1 0.6"`),
      piece(-buf, tile + buf, "#c27a1a", 1.2),
      piece(tile - buf, 2 * tile, BLUE, 0.6),
      circle(clipAt(tile + buf), 0.9, `fill="${ACCENT}"`),
      circle(clipAt(tile - buf), 0.9, `fill="${ACCENT}"`),
      text([2, top + 4], "tile A", 3, `fill="${INK}"`),
      text([tile + 2, top + 4], "tile B", 3, `fill="${INK}"`),
      text([-buf, top + tile + buf + 3], "A's buffer", 2.8, `fill="${ACCENT}"`),
      text(
        [0, top + tile + margin + 6],
        "A's piece stops at a clip vertex on A's buffer;",
        3,
        `fill="${INK}"`,
      ),
      text([0, top + tile + margin + 10.5], "B's (blue) starts at one on B's.", 3, `fill="${INK}"`),
    ].join("") +
    "</g>";
  const right = (o: XY) =>
    `<g transform="translate(${o[0] + 12} ${o[1]})">` +
    [
      tileRect(0, "#f7f5f0"),
      tileRect(tile, "#efece4"),
      boxAround(0, margin, `stroke="${BLUE}" stroke-width="0.3" stroke-dasharray="1 0.6"`),
      piece(-margin, tile + margin, "#c27a1a", 1.2),
      text([2, top + 4], "tile A", 3, `fill="${INK}"`),
      text([-margin, top + tile + margin + 3], "A's margin", 2.8, `fill="${BLUE}"`),
      text(
        [0, top + tile + margin + 6],
        "Stitched into one line, then cut to A's margin:",
        3,
        `fill="${INK}"`,
      ),
      text(
        [0, top + tile + margin + 10.5],
        "A builds every junction near its edge whole.",
        3,
        `fill="${INK}"`,
      ),
    ].join("") +
    "</g>";
  const { view: v, body } = panels(
    [
      { caption: "", body: left },
      { caption: "", body: right },
    ],
    124,
    96,
    8,
    1,
  );
  return document(v, 900, body);
}

/** A short link on a fine grid and on a grid four times coarser: its direction moves. */
function rounding(): string {
  const before: XY = [-20, 1.2];
  const link: XY = [1.6, -1.3];
  const panel = (step: number) => (o: XY) => {
    const s = 14; // drawing units per metre
    const sh = (p: XY): XY => [o[0] + 50 + p[0] * s, o[1] + 52 + p[1] * s];
    const round = (p: XY): XY => [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
    const node: XY = [0.0, 0.0];
    const end = round(link);
    const prev = round(before);
    const grid: string[] = [];
    for (let gx = -3; gx <= 3; gx += step)
      grid.push(line(sh([gx, -3]), sh([gx, 2]), `stroke="#ddd9cf" stroke-width="0.2"`));
    for (let gy = -3; gy <= 2; gy += step)
      grid.push(line(sh([-3, gy]), sh([3, gy]), `stroke="#ddd9cf" stroke-width="0.2"`));
    const angle = (a: XY, b: XY) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const turn = Math.abs(angle(prev, node) - angle(node, end));
    return [
      `<rect x="${o[0]}" y="${o[1]}" width="100" height="90" fill="${GROUND}"/>`,
      ...grid,
      line(sh([-3, before[1] * (3 / 20)]), sh(node), `stroke="#f4b860" stroke-width="2.2"`),
      line(sh(node), sh(link), `stroke="${MUTED}" stroke-width="0.4" stroke-dasharray="1 0.6"`),
      line(sh(node), sh(end), `stroke="#c27a1a" stroke-width="1.2"`),
      circle(sh(link), 0.9, `fill="none" stroke="${INK}" stroke-width="0.3"`),
      circle(sh(end), 0.9, `fill="${ACCENT}"`),
      circle(sh(node), 0.9, `fill="${INK}"`),
      text([o[0] + 4, o[1] + 86], `turn at the node: ${turn.toFixed(1)}°`, 3, `fill="${INK}"`),
    ].join("");
  };
  const { view: v, body } = panels(
    [
      { caption: "Fine grid: the link's end lands near where it is", body: panel(0.25) },
      { caption: "A grid 4× coarser: the end moves, the turn changes", body: panel(1) },
    ],
    100,
    90,
    6,
    3.4,
  );
  return document(v, 760, body);
}

export function diagrams(): Record<string, string> {
  return {
    pipeline: pipeline(),
    gpu: gpu(),
    passes: passes(),
    offsets: offsets(),
    anatomy: anatomy(),
    outline: outline(),
    depth: depth(),
    tiles: tiles(),
    rounding: rounding(),
  };
}
