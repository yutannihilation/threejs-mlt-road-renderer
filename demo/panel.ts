import type { RoadStats } from "../src";
import type { Scene } from "./config";
import { LEGENDS, type Preset } from "./roadStyle";
import "./style.css";

export interface Panel {
  setStats(stats: RoadStats): void;
}

export interface PanelOptions {
  readonly scenes: readonly Scene[];
  readonly onScene: (scene: Scene) => void;
  readonly onChange: (preset: Preset, outline: boolean) => void;
  /** The debug toggle drawing the data's own centrelines. */
  readonly onCentrelines: (visible: boolean) => void;
}

/**
 * The scene buttons, preset switch, outline and centreline toggles, legend and stats overlaid on
 * `container`.
 */
export function createPanel(
  container: HTMLElement,
  { scenes, onScene, onChange, onCentrelines }: PanelOptions,
): Panel {
  const panel = document.createElement("div");
  panel.className = "panel";
  const legend = (preset: Preset) =>
    Object.entries(LEGENDS[preset])
      .map(
        ([name, color]) =>
          `<span class="item"><span class="swatch" style="background: ${color}"></span>${name}</span>`,
      )
      .join(" ");
  panel.innerHTML = `
    <h1>3D MLT roads as ribbons</h1>
    <div class="scenes">${scenes.map((scene, i) => `<button type="button" data-scene="${i}">${scene.name}</button>`).join("")}</div>
    <fieldset class="modes">
      <label><input type="radio" name="preset" value="map" checked /> map symbols</label>
      <label><input type="radio" name="preset" value="widthClass" /> colour by width</label>
    </fieldset>
    <label class="toggle"><input type="checkbox" name="outline" checked /> outline</label>
    <label class="toggle"><input type="checkbox" name="centrelines" /> centrelines (debug)</label>
    <div class="legend" data-preset="map">${legend("map")}</div>
    <div class="legend" data-preset="widthClass" hidden>${legend("widthClass")}</div>
    <p class="stats">Loading tiles…</p>
    <p class="note">Widths are metres on the ground; the GPU applies them to centreline vertices tessellated once per tile. MapLibre + Three.js.</p>
  `;
  const read = () => {
    const preset = panel.querySelector<HTMLInputElement>("input[name=preset]:checked")!
      .value as Preset;
    const outline = panel.querySelector<HTMLInputElement>("input[name=outline]")!.checked;
    for (const el of panel.querySelectorAll<HTMLElement>(".legend")) {
      el.hidden = el.dataset.preset !== preset;
    }
    onChange(preset, outline);
  };
  for (const input of panel.querySelectorAll<HTMLInputElement>(
    "input[name=preset], input[name=outline]",
  )) {
    input.addEventListener("change", read);
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>("button[data-scene]")) {
    button.addEventListener("click", () => onScene(scenes[Number(button.dataset.scene)]));
  }
  const centrelines = panel.querySelector<HTMLInputElement>("input[name=centrelines]")!;
  centrelines.addEventListener("change", () => onCentrelines(centrelines.checked));
  const stats = panel.querySelector<HTMLParagraphElement>(".stats")!;
  container.append(panel);
  return {
    setStats({ tiles, lines, vertices, triangles, drawCalls }) {
      const fmt = (n: number) => n.toLocaleString("en-US");
      stats.textContent = `${fmt(tiles)} tiles · ${fmt(lines)} lines · ${fmt(vertices)} vertices · ${fmt(triangles)} triangles · ${fmt(drawCalls)} draws`;
    },
  };
}
