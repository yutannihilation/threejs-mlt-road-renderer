import { decodeTileColumns, type MltColumnLayer } from "@maplibre/mlt-wasm";
import { type LineIds, lineIds } from "./lines";
import { type TileFrame, type TileIndex, tileFrame } from "./transform";

/** A decoded tile: the layer as `decodeTileColumns` returns it, plus the line ids and the frame. */
export interface LineTile {
  readonly index: TileIndex;
  readonly layer: MltColumnLayer;
  readonly ids: LineIds;
  readonly frame: TileFrame;
  /** The layer's z grid: metres are `toElevation(z, zStep)`. */
  readonly zStep: number;
}

export function tileUrl(template: string, { z, x, y }: TileIndex): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

/** Throws when the layer is missing, repeated, not 3D, or holds anything but lines. */
export function lineTile(data: Uint8Array, index: TileIndex, layerName: string): LineTile {
  const { layers } = decodeTileColumns(data, { layers: [layerName] });
  if (layers.length !== 1) {
    throw new Error(`tile has ${layers.length} layers named "${layerName}", expected one`);
  }
  const [layer] = layers;
  const { extent, geometry } = layer;
  if (geometry.dimension !== 3) throw new Error(`layer "${layerName}" has no z coordinates`);
  return {
    index,
    layer,
    ids: lineIds(layer),
    frame: tileFrame(index, extent, geometry.zStep),
    zStep: geometry.zStep,
  };
}

/**
 * `null` for a tile with nothing to draw: one the server has no data for (404 or 204), or with
 * fewer than two vertices, which make no segment.
 */
export async function fetchLineTile(
  url: string,
  index: TileIndex,
  layerName: string,
  signal?: AbortSignal,
): Promise<LineTile | null> {
  const response = await fetch(url, { signal });
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const tile = lineTile(new Uint8Array(await response.arrayBuffer()), index, layerName);
  return tile.ids.lineOfVertex.length >= 2 ? tile : null;
}
