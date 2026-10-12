/**
 * Writes the design notes' figures to docs/design/figures/: run with `bun scripts/figures/render.ts`.
 * Road figures are synthetic networks tessellated by the library itself; the others are diagrams
 * of the same geometry.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagrams } from "./diagrams";
import {
  draw,
  drawSeparately,
  MAJOR,
  MINOR,
  NARROW,
  network,
  PATH,
  type Road,
  view,
  wireframe,
} from "./roads";
import { ACCENT, document, panels, type XY } from "./svg";

const OUT = join(import.meta.dirname, "../../docs/design/figures");

const SIZE = 100;
const GAP = 6;
const CAPTION = 4.2;

/** Panels of road views, each `radius` metres around its centre. */
function roadPanels(
  items: readonly {
    roads: readonly Road[];
    caption: string;
    centre?: XY;
    radius?: number;
    body?: (roads: readonly Road[]) => string;
  }[],
): string {
  const { view: box, body } = panels(
    items.map(
      ({ roads, caption, centre = [0, 0], radius = 30, body = (r) => draw(network(r)) }) => ({
        caption,
        body: (origin: XY) => view(origin, SIZE, centre, radius, body(roads)),
      }),
    ),
    SIZE,
    SIZE,
    GAP,
    CAPTION,
  );
  return document(box, Math.min(1000, items.length * 330), body);
}

const r = (kind: Road["kind"], ...points: XY[]): Road => ({ kind, points });

const figures: Record<string, string> = {};

// A main road with a slight bend, crossed by a side road, and a branch.
const town = [
  r(MAJOR, [-70, 2], [0, 0]),
  r(MAJOR, [0, 0], [28, -4]),
  r(MAJOR, [28, -4], [70, -12]),
  r(MINOR, [0, 0], [-2, -60]),
  r(MINOR, [0, 0], [4, 60]),
  r(MINOR, [28, -4], [44, -60]),
];
figures["outlines"] = roadPanels([
  {
    roads: town,
    caption: "Each link drawn on its own",
    centre: [12, 0],
    radius: 42,
    body: drawSeparately,
  },
  { roads: town, caption: "One outline for the whole network", centre: [12, 0], radius: 42 },
]);

const ribbon = [r(MINOR, [-45, 18], [-12, 14], [10, 9], [30, -22])];
const crossing = [
  r(MAJOR, [-60, 0], [0, 0]),
  r(MAJOR, [0, 0], [60, 0]),
  r(MINOR, [0, 0], [0, -60]),
  r(MINOR, [0, 0], [0, 60]),
];
figures["triangles"] = roadPanels([
  {
    roads: ribbon,
    caption: "A ribbon: a miter, then a round join",
    centre: [-5, 0],
    body: (roads) => {
      const net = network(roads);
      return draw(net) + wireframe(net, ACCENT);
    },
  },
  {
    roads: crossing,
    caption: "A crossing: the junction core tinted",
    radius: 18,
    body: (roads) => {
      const net = network(roads);
      return draw(net) + wireframe(net, ACCENT);
    },
  },
]);

figures["ownership"] = roadPanels([
  { roads: crossing, caption: "The higher rank runs through", radius: 25 },
  {
    roads: [
      r(MAJOR, [-60, 0], [0, 0]),
      r(MAJOR, [0, 0], [56, -20]),
      r(MINOR, [0, 0], [0, -60]),
      r(MINOR, [0, 0], [0, 60]),
    ],
    caption: "It still does when it bends",
    radius: 25,
  },
  {
    roads: [r(MAJOR, [-60, 0], [0, 0]), r(MINOR, [0, -60], [0, 0]), r(MINOR, [0, 0], [0, 60])],
    caption: "A road ending meets the road running on",
    radius: 25,
  },
]);

const shortLink = [
  r(MINOR, [-60, 0], [-5, 0]),
  r(NARROW, [-5, 0], [0, 0]),
  r(MINOR, [0, 0], [60, 0]),
  r(PATH, [0, 0], [-6, -60]),
  r(PATH, [0, 0], [6, 60]),
];
figures["widths"] = roadPanels([
  {
    roads: [r({ ...MINOR, half: 5 }, [-60, 0], [0, 0]), r(MINOR, [0, 0], [60, 0])],
    caption: "A change of width: a 1 : 3 taper",
    radius: 22,
  },
  {
    roads: shortLink,
    caption: "A 5 m narrower link, tapered",
    radius: 22,
    body: (roads) => draw(network(roads, false)),
  },
  { roads: shortLink, caption: "The same link drawn as its road", radius: 22 },
]);

figures["lower-roads"] = roadPanels([
  {
    roads: [
      r(MAJOR, [-60, 0], [0, 0]),
      r(MAJOR, [0, 0], [60, 0]),
      r(MINOR, [0, 0], [-20, -60]),
      r(MINOR, [0, 0], [-2, -60]),
    ],
    caption: "Two side roads parting at a sharp angle",
    centre: [-6, -10],
    radius: 30,
  },
  {
    roads: [
      r({ ...MAJOR, half: 8 }, [-60, 0], [0, 0]),
      r({ ...MAJOR, half: 8 }, [0, 0], [60, 0]),
      r(MINOR, [0, 0], [-4, -60]),
      r(NARROW, [0, 0], [-60, -18]),
    ],
    caption: "Two side roads meeting inside a wide road",
    centre: [-10, -6],
    radius: 30,
  },
  {
    roads: [r(MAJOR, [-60, 0], [0, 0]), r(MAJOR, [0, 0], [60, 0]), r(MINOR, [0, 0], [60, 8])],
    caption: "A road merging at a shallow angle",
    centre: [20, 2],
    radius: 30,
  },
]);

figures["bends"] = roadPanels([
  {
    roads: [r(MAJOR, [-60, 0], [0, 0]), r(MAJOR, [0, 0], [42, -42]), r(MINOR, [0, 0], [10, 60])],
    caption: "A side road on the outside of a bend",
    radius: 24,
  },
  {
    roads: [r(MAJOR, [-60, 0], [0, 0]), r(MAJOR, [0, 0], [42, -42]), r(MINOR, [0, 0], [-10, -60])],
    caption: "A side road on the inside of a bend",
    radius: 24,
  },
]);

Object.assign(figures, diagrams());

mkdirSync(OUT, { recursive: true });
for (const [name, svg] of Object.entries(figures)) writeFileSync(join(OUT, `${name}.svg`), svg);
console.log(`${Object.keys(figures).length} figures in ${OUT}`);
