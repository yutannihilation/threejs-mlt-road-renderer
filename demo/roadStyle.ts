import type { Props, RoadStyle } from "../src";

/**
 * Road styles for swissTLM3D's roads and paths (`TLM_STRASSE`). Its `OBJEKTART` names each line's
 * class, and for ordinary roads and paths the class is its width: "10m Strasse" is a road 10 m
 * wide, "2m Weg" a path 2 m wide. Motorways are one line per carriageway.
 *
 * Other roads whose carriageways are separated (`RICHTUNGSG` "Wahr") are one line per carriageway
 * too, but their class is the width of the road as a whole: the two lines often run under 3 m
 * apart. Each is drawn at half that width, so the two lie side by side, each in its own class.
 */

const GREY = "#5c5c5c";

/** A line's width in metres, as its `OBJEKTART` gives it, and whether it gets an outline. */
interface Symbol {
  readonly width: number;
  readonly outlined: boolean;
}

/** Each `OBJEKTART`'s symbol. */
const SYMBOLS: Record<string, Symbol> = {
  Autobahn: { width: 9, outlined: true },
  Autostrasse: { width: 8, outlined: true },
  Einfahrt: { width: 6, outlined: true },
  Ausfahrt: { width: 6, outlined: true },
  // Short connectors joining roads within junctions; their class is their network's.
  Verbindung: { width: 4, outlined: true },
  Raststaette: { width: 5, outlined: true },
  Dienstzufahrt: { width: 4, outlined: true },
  Zufahrt: { width: 4, outlined: true },
  "10m Strasse": { width: 10, outlined: true },
  "8m Strasse": { width: 8, outlined: true },
  "6m Strasse": { width: 6, outlined: true },
  "4m Strasse": { width: 4, outlined: true },
  "3m Strasse": { width: 3, outlined: true },
  Platz: { width: 6, outlined: true },
  "2m Weg": { width: 2, outlined: false },
  "1m Weg": { width: 1.2, outlined: false },
  "1m Wegfragment": { width: 1.2, outlined: false },
  "2m Wegfragment": { width: 2, outlined: false },
};

const UNKNOWN: Symbol = { width: 2, outlined: false };

function symbol(p: Props): Symbol {
  return SYMBOLS[String(p.OBJEKTART)] ?? UNKNOWN;
}

/** Motorway carriageways: their symbols' widths are per carriageway already. */
const MOTORWAYS = new Set(["Autobahn", "Autostrasse", "Einfahrt", "Ausfahrt"]);
const RAMPS = new Set(["Einfahrt", "Ausfahrt"]);

/**
 * A road's class, as swisstopo's own base map (`ch.swisstopo.base.vt`) classes swissTLM3D: by
 * width, and for roads of 6 m and less by their traffic importance (`VERKEHRSBD`), the network of
 * through roads ("Durchgangsstrasse") and connecting roads ("Verbindungsstrasse") they belong to.
 * A connector has no width class; it takes its network's class, so it does not break a road.
 */
type RoadClass = "motorway" | "ramp" | "primary" | "secondary" | "tertiary" | "minor" | "path";

function roadClass(p: Props): RoadClass {
  const kind = String(p.OBJEKTART);
  const importance = p.VERKEHRSBD;
  const important = importance === "Durchgangsstrasse" || importance === "Verbindungsstrasse";
  if (RAMPS.has(kind)) return "ramp";
  if (MOTORWAYS.has(kind)) return "motorway";
  if (!symbol(p).outlined) return "path";
  switch (kind) {
    case "Verbindung":
      if (importance === "Hochleistungsstrasse") return "ramp";
      if (importance === "Durchgangsstrasse") return "primary";
      return importance === "Verbindungsstrasse" ? "secondary" : "minor";
    case "10m Strasse":
    case "8m Strasse":
      return "primary";
    case "6m Strasse":
      return important ? "secondary" : "minor";
    case "4m Strasse":
    case "3m Strasse":
      return important ? "tertiary" : "minor";
    default:
      return "minor";
  }
}

const MOTORWAY = "#e8846b";

/** Each class's fill and rank: higher ranks cross over lower ones. */
const CLASSES: Record<RoadClass, { readonly fill: string; readonly rank: number }> = {
  motorway: { fill: MOTORWAY, rank: 6 },
  ramp: { fill: MOTORWAY, rank: 5 },
  primary: { fill: "#f6c95b", rank: 4 },
  secondary: { fill: "#fbe39a", rank: 3 },
  tertiary: { fill: "#fdf3d2", rank: 2 },
  minor: { fill: "#ffffff", rank: 1 },
  path: { fill: "#b4b0a8", rank: 0 },
};

/** The width a line is drawn at, in metres: one carriageway's share of a separated road. */
function drawnWidth(p: Props): number {
  const { width } = symbol(p);
  const separated = p.RICHTUNGSG === "Wahr" && !MOTORWAYS.has(String(p.OBJEKTART));
  return separated ? width / 2 : width;
}

/** Tunnels and covered ways: a pale fill inside the outline. */
const tunnel = (p: Props) => p.KUNSTBAUTE === "Tunnel";

/** The outline, per side: one width for every road that has one. */
const OUTLINE = 0.5;

/**
 * Map-like symbols, coloured by class as swisstopo's base map does (see `roadClass`), drawn at
 * their widths; paths as thin grey lines.
 * Every road is in one draw group: bridges and underpasses join the network exactly, and their
 * elevation sets them apart in 3D.
 */
export function mapStyle(outline: boolean): RoadStyle {
  return {
    rank: (p) => CLASSES[roadClass(p)].rank,
    width: drawnWidth,
    color: (p) => (tunnel(p) ? "#f4f2ee" : CLASSES[roadClass(p)].fill),
    outline: {
      width: (p) => (outline && symbol(p).outlined ? OUTLINE : 0),
      color: () => GREY,
    },
    cap: "round",
  };
}

const COLOR_BY_WIDTH: Record<string, string> = {
  "≥ 9 m": "#414487",
  "8 m": "#2a788e",
  "6 m": "#22a884",
  "3–4 m": "#7ad151",
  paths: "#fde725",
};

function widthClass(p: Props): string {
  const { width } = symbol(p);
  if (width >= 9) return "≥ 9 m";
  if (width >= 8) return "8 m";
  if (width >= 5) return "6 m";
  if (width >= 3) return "3–4 m";
  return "paths";
}

/** Colour by width, wider roads crossing over narrower. */
export function widthClassStyle(outline: boolean): RoadStyle {
  return {
    rank: (p) => Math.round(symbol(p).width),
    width: drawnWidth,
    color: (p) => COLOR_BY_WIDTH[widthClass(p)],
    outline: outline ? { width: () => OUTLINE, color: () => "#333333" } : undefined,
    cap: "round",
  };
}

export type Preset = "map" | "widthClass";

export function presetStyle(preset: Preset, outline: boolean): RoadStyle {
  return preset === "map" ? mapStyle(outline) : widthClassStyle(outline);
}

export const LEGENDS: Record<Preset, Record<string, string>> = {
  map: {
    motorway: MOTORWAY,
    primary: CLASSES.primary.fill,
    secondary: CLASSES.secondary.fill,
    tertiary: CLASSES.tertiary.fill,
    minor: CLASSES.minor.fill,
    path: CLASSES.path.fill,
  },
  widthClass: COLOR_BY_WIDTH,
};
