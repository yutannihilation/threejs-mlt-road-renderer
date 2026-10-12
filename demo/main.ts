import { RoadLayer } from "../src";
import { LAYER, SCENES, TILE_MAX_ZOOM, TILE_MIN_ZOOM, TILE_URL } from "./config";
import { createMap } from "./map";
import { createPanel } from "./panel";
import { attachPopup } from "./popup";
import { presetStyle } from "./roadStyle";

const map = createMap(document.getElementById("map")!);
const panel = createPanel(document.body, {
  scenes: SCENES,
  onScene: (scene) => map.jumpTo(scene.view),
  onChange(preset, outline) {
    roads.setStyle(presetStyle(preset, outline));
  },
  onCentrelines: (visible) => roads.setCentrelines(visible),
});
const roads = new RoadLayer({
  url: TILE_URL,
  layer: LAYER,
  minzoom: TILE_MIN_ZOOM,
  maxzoom: TILE_MAX_ZOOM,
  style: presetStyle("map", true),
  onStats: (stats) => panel.setStats(stats),
});
map.on("load", () => {
  map.addLayer(roads);
  attachPopup(map, roads);
});
// For poking at the layer from the console during development.
if (import.meta.env.DEV) Object.assign(window, { map, roads });
