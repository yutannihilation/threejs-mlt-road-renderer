import { type Map as MapLibreMap, Popup } from "maplibre-gl";
import type { RoadLayer } from "../src";

function escape(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/** A click on a road opens a popup with its properties, for inspecting the data. */
export function attachPopup(map: MapLibreMap, roads: RoadLayer): void {
  const popup = new Popup({ maxWidth: "360px" });
  map.on("click", (e) => {
    const hit = roads.pick(e.point.x, e.point.y);
    if (!hit) {
      popup.remove();
      return;
    }
    const { z, x, y } = hit.index;
    const rows = Object.entries(hit.props)
      .map(([k, v]) => `<tr><th>${escape(k)}</th><td>${escape(String(v))}</td></tr>`)
      .join("");
    popup
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="popup"><div class="where">tile ${z}/${x}/${y} · line ${hit.line} · ${hit.distance.toFixed(1)} px</div><table>${rows}</table></div>`,
      )
      .addTo(map);
  });
  map.getCanvas().style.cursor = "crosshair";
}
