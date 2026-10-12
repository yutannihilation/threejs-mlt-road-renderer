import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DATA_ATTRIBUTION, SCENES, type Scene } from "./config";

/** No basemap: the roads on a plain background. */
const STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#f1efe9" } }],
};

/** The scene nearest to `[lng, lat]`; the scenes are far enough apart for degrees to do. */
export function nearestScene([lng, lat]: readonly [number, number]): Scene {
  const distance = ({ view: { center } }: Scene) => Math.hypot(center[0] - lng, center[1] - lat);
  return SCENES.reduce((a, b) => (distance(b) < distance(a) ? b : a));
}

/** The map, opening on the first scene unless the URL hash says otherwise. */
export function createMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: STYLE,
    ...SCENES[0].view,
    // Keep the centre at the scene's elevation rather than at the (absent) ground.
    centerClampedToGround: false,
    maxPitch: 85,
    // MSAA for the shared WebGL context: ribbon edges look jagged without it.
    canvasContextAttributes: { antialias: true },
    hash: true,
    attributionControl: { compact: false, customAttribution: DATA_ATTRIBUTION },
  });
  // The hash holds no elevation and resets it to sea level: take the nearest scene's.
  const { lng, lat } = map.getCenter();
  map.setCenterElevation(nearestScene([lng, lat]).view.elevation);
  map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
  return map;
}
