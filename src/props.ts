import { columnValue, type MltColumnLayer } from "@maplibre/mlt-wasm";
import type { Props, PropValue } from "./style";

/**
 * Feature `feature`'s properties as a plain object, one key per column that has a value for it;
 * `bool` columns come as booleans. Throws when `feature` is not a feature of the layer.
 */
export function featureProps(layer: MltColumnLayer, feature: number): Props {
  if (!Number.isInteger(feature) || feature < 0 || feature >= layer.featureCount) {
    throw new RangeError(`feature ${feature} is not a feature of layer "${layer.name}"`);
  }
  const out: Record<string, PropValue> = {};
  for (const column of layer.properties) {
    const value = columnValue(column, feature);
    if (value === undefined) continue;
    out[column.name] = column.type === "bool" ? value === 1 : value;
  }
  return out;
}

/** Every feature's properties, in feature order. */
export function allProps(layer: MltColumnLayer): Props[] {
  return Array.from({ length: layer.featureCount }, (_, f) => featureProps(layer, f));
}
