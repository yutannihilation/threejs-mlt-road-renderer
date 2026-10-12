import { geometryStarts, type MltColumnLayer, MltGeometryType } from "@maplibre/mlt-wasm";
import type { Props } from "./style";

/**
 * The lines of a layer, numbered in vertex order, as the two side buffers the GPU needs next
 * to the layer's own vertex buffer.
 *
 * `lineOfVertex` is read at element offsets 0 and 1 by consecutive instances: a segment whose
 * ends name different lines straddles two lines and is not drawn. The same number indexes
 * the per-line style texture and is what picking reads back. `featureOfLine` maps it to the
 * feature whose properties it carries.
 */
export interface LineIds {
  readonly lineOfVertex: Uint32Array;
  readonly featureOfLine: Uint32Array;
  /** Where each line starts: line `l` has vertices `lineStart[l] .. lineStart[l + 1]`. */
  readonly lineStart: Uint32Array;
  /**
   * Where each feature's lines start: feature `f` has lines
   * `featureLineStart[f] .. featureLineStart[f + 1]`.
   */
  readonly featureLineStart: Uint32Array;
}

/** The lines `[start, end)` of feature `feature`, which are contiguous. */
export function featureLines(ids: LineIds, feature: number): [number, number] {
  return [ids.featureLineStart[feature], ids.featureLineStart[feature + 1]];
}

/** Throws when a feature is not a line: this renderer draws nothing else. */
export function lineIds(layer: MltColumnLayer): LineIds {
  const { types } = layer.geometry;
  for (let f = 0; f < layer.featureCount; f++) {
    if (types[f] !== MltGeometryType.LineString && types[f] !== MltGeometryType.MultiLineString) {
      const kind = MltGeometryType[types[f]] ?? `type ${types[f]}`;
      throw new Error(`feature ${f} of layer "${layer.name}" is a ${kind}, expected a line`);
    }
  }
  // In a layer of lines, each geometry is a line: the starts are the line ids' ranges.
  const { featureGeometries, geometryVertices } = geometryStarts(layer.geometry);
  const lines = geometryVertices.length - 1;
  const lineOfVertex = new Uint32Array(geometryVertices[lines]);
  for (let line = 0; line < lines; line++) {
    lineOfVertex.fill(line, geometryVertices[line], geometryVertices[line + 1]);
  }
  const featureOfLine = new Uint32Array(lines);
  for (let f = 0; f < layer.featureCount; f++) {
    featureOfLine.fill(f, featureGeometries[f], featureGeometries[f + 1]);
  }
  return {
    lineOfVertex,
    featureOfLine,
    lineStart: geometryVertices,
    featureLineStart: featureGeometries,
  };
}

/**
 * Lines ready to draw: what topology, tessellation and picking read. Line `l` has vertices
 * `lineStart[l] .. lineStart[l + 1]`, each `x, y, z` in tile units and the z the tile's frame
 * maps to metres.
 */
export interface Lines {
  readonly vertices: Float64Array;
  readonly lineStart: Uint32Array;
  /** Each line's properties. */
  readonly props: readonly Props[];
  /**
   * Per line, `1` where its first (last) vertex is not where it ends but where the data runs out:
   * such an end joins no node and gets no cap.
   */
  readonly startClipped: Uint8Array;
  readonly endClipped: Uint8Array;
}
