export type { Lines } from "./lines";
export { RoadLayer, type RoadLayerOptions, type RoadStats } from "./layer";
export { pickRoad, type PickTarget, type RoadHit } from "./pick";
export { allProps, featureProps } from "./props";
export { type StitchSource, stitchedLines } from "./stitch";
export {
  type Cap,
  type ColorSpec,
  evaluateStyle,
  parseColor,
  type Props,
  type PropValue,
  type Rgb,
  type RoadStyle,
  type StyleTable,
} from "./style";
export { type GroupRange, type RoadMesh, type Term, tessellateRoads } from "./tessellate";
export { type LineNodes, lineNodes, type NodeEnd } from "./topology";
export type { TileIndex } from "./transform";
