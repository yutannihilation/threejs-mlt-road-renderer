import type { CameraOptions } from "maplibre-gl";

/** The tiles in ./data, served and copied into builds by vite.config.ts's `serveTiles`. */
export const TILE_URL = `${import.meta.env.BASE_URL}tiles/{z}/{x}/{y}.mlt`;
export const TILE_MIN_ZOOM = 0;
export const TILE_MAX_ZOOM = 18;
export const LAYER = "roads";

export interface Scene {
  readonly name: string;
  /**
   * The camera. There is no terrain, so `elevation` (metres above sea level) is what the camera
   * looks at: the roads' own height there, not sea level.
   */
  readonly view: Required<Pick<CameraOptions, "zoom" | "pitch" | "bearing" | "elevation">> & {
    readonly center: [number, number];
  };
}

/** The three 4 km squares of swissTLM3D in ./data, each showing off a different kind of 3D. */
export const SCENES: readonly Scene[] = [
  {
    name: "Zürich Nord interchange",
    view: { center: [8.599, 47.408], zoom: 16.4, pitch: 60, bearing: 30, elevation: 437 },
  },
  {
    name: "Biaschina viaduct",
    view: { center: [8.8576, 46.4221], zoom: 16.3, pitch: 68, bearing: 60, elevation: 520 },
  },
  {
    name: "Tremola hairpins",
    view: { center: [8.5672, 46.544], zoom: 15.8, pitch: 65, bearing: 340, elevation: 1880 },
  },
];

export const DATA_ATTRIBUTION =
  'Roads: <a href="https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d" target="_blank" rel="noopener">swissTLM3D © swisstopo</a>';
