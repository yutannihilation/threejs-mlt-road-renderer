import {
  type CoveringTilesOptions,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
  MercatorCoordinate,
} from "maplibre-gl";
import * as THREE from "three";
import { centrelineGeometry, centrelineMaterial, centrelineSegments } from "./centrelines";
import { elevationRange, unionRange } from "./elevation";
import { type GroupGeometry, roadGeometries, roadMaterial, styleTexture } from "./gpu";
import type { Lines } from "./lines";
import { pickRoad, type RoadHit } from "./pick";
import { allProps } from "./props";
import { type StitchSource, stitchedLines } from "./stitch";
import { collapseStubs } from "./stubs";
import { evaluateStyle, type Props, type RoadStyle, type StyleTable, styleTexels } from "./style";
import { continueShortLinks, type RoadMesh, tessellateRoads } from "./tessellate";
import { fetchLineTile, type LineTile, tileUrl } from "./tile";
import { type LineNodes, lineNodes } from "./topology";
import {
  cameraPosition,
  metreFrame,
  type TileFrame,
  type TileIndex,
  unitsPerMetre,
} from "./transform";

export type { RoadHit } from "./pick";

// Pass the colours through untouched.
THREE.ColorManagement.enabled = false;

export interface RoadLayerOptions {
  /** The MapLibre layer id. Default: `"roads"`. */
  readonly id?: string;
  /** The tile URL template, with `{z}`, `{x}` and `{y}`. */
  readonly url: string;
  /** The name of the line layer in the tiles. */
  readonly layer: string;
  /** The zoom range the tiles exist at; beyond `maxzoom` they are overzoomed. */
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly style: RoadStyle;
  /** Tile size in CSS pixels for choosing tiles. Default: 512. */
  readonly tileSize?: number;
  /**
   * How far below a road, in metres, its casing counts for the depth test, measured along each
   * pixel's ray. A road's fill covers the casings of roads within this height of it there, from
   * any angle, so connected roads share one outline; a road higher than this keeps its own outline
   * over the roads beneath. Default: 1.
   */
  readonly casingDepthOffset?: number;
  /**
   * How far past each tile, in tile units, the tiler kept its lines, cutting them there: vertices
   * on that box are where a line was cut, not where it ends. Default: 64. A vertex beyond it fails
   * the tile.
   */
  readonly tileBuffer?: number;
  /**
   * How far past a tile, in metres, the lines it is built from reach: as far as a junction or
   * ribbon drawn in the tile can depend on. Where the tile's own buffer falls short, the lines of
   * its neighbours at the same zoom are stitched to its own. Default: 40.
   */
  readonly stitchMargin?: number;
  /**
   * Whether to draw each line's own centreline, as in the data, as a thin translucent red line
   * over the roads: for seeing how the data is split into lines. Default: false.
   */
  readonly centrelines?: boolean;
  /** Tiles kept in memory beyond those in view. Default: 256. */
  readonly cacheSize?: number;
  /** Called on the map's `idle` event with what is drawn. */
  readonly onStats?: (stats: RoadStats) => void;
}

export interface RoadStats {
  tiles: number;
  lines: number;
  vertices: number;
  triangles: number;
  /** Meshes drawn in the last frame: covering tiles × groups × 2 passes, and one per tile for centrelines. */
  drawCalls: number;
}

/** What a tile's style determines: rebuilt by `setStyle`. */
interface TileGpu {
  readonly table: StyleTable;
  readonly mesh: RoadMesh;
  readonly geometries: GroupGeometry[];
  readonly texture: THREE.DataTexture;
  readonly material: THREE.ShaderMaterial;
}

/** A tile as decoded, for building it and its neighbours. */
interface LoadedTile {
  readonly tile: LineTile;
  readonly props: Props[];
}

/**
 * A tile ready to draw: the lines it is drawn from (its own, stitched to its neighbours'), and
 * what the style makes of them. It keeps its lines, so neighbours may be evicted.
 */
interface BuiltTile {
  readonly index: TileIndex;
  readonly extent: number;
  readonly lines: Lines;
  /** The tile's frame, for z in metres. */
  readonly frame: TileFrame;
  readonly nodes: LineNodes;
  gpu: TileGpu;
  /** Meshes by world copy, group, pass and clip rectangle; they hold no GPU resources. */
  readonly meshes: Map<string, THREE.Mesh>;
  /** The data's centrelines, built when first shown, by world copy and clip rectangle. */
  centrelines?: { geometry: THREE.BufferGeometry; objects: Map<string, THREE.LineSegments> };
}

type TileEntry =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "error"; error: unknown }
  | { state: "ready"; loaded: LoadedTile; built?: BuiltTile };

/** A tile drawn this frame, clipped to the footprint it stands in for. */
interface Drawn {
  tile: BuiltTile;
  wrap: number;
  /** `x0, y0, x1, y1` in the tile's own units. */
  clip: readonly [number, number, number, number];
  /** Local positions to clip space. */
  matrix: THREE.Matrix4;
}

function key({ z, x, y }: TileIndex): string {
  return `${z}/${x}/${y}`;
}

function builtOf(entry: TileEntry | undefined): BuiltTile | undefined {
  return entry?.state === "ready" ? entry.built : undefined;
}

/** The tiles a tile is built from, once they have all loaded. */
interface Neighbourhood {
  readonly sources: StitchSource[];
  readonly extent: number;
  /** The stitch margin in tile units. */
  readonly margin: number;
}

/**
 * A MapLibre custom layer drawing a 3D line layer of MLT tiles as flat road ribbons with
 * Three.js, on the map's own WebGL context.
 *
 * Each tile is built once its neighbours at the same zoom have loaded, from its lines stitched to
 * theirs, so junctions and ribbons across tile boundaries are whole. It is tessellated into
 * centreline vertices with extrude vectors; the GPU applies
 * each line's width from a style texture, so the same geometry draws the casing and the fill.
 * Draw order is by style group, each group's casings before its fills, and within a draw by
 * rank, so outlines wrap whole networks and higher ranks cross over lower ones.
 */
export class RoadLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom";
  readonly renderingMode = "3d";

  private readonly options: RoadLayerOptions;
  private style: RoadStyle;
  private map!: MapLibreMap;
  private renderer!: THREE.WebGLRenderer;
  /** One metre in Mercator units at the equator. */
  private metre = 0;
  private readonly scene = new THREE.Scene();
  /** Every mesh carries its full model-view-projection matrix, so the camera is the identity. */
  private readonly camera = new THREE.Camera();
  private readonly tiles = new Map<string, TileEntry>();
  /** Tile keys by last use, least recent first. */
  private readonly lru = new Set<string>();
  private drawCalls = 0;
  /** The tiles of the last frame, for picking. */
  private drawn: Drawn[] = [];
  /** The lowest and highest road seen in any tile loaded so far, in metres. */
  private elevations: readonly [number, number] | undefined;
  private showCentrelines: boolean;
  /** Shared by every tile's centrelines; `uScale` and `uClip` are set per draw. */
  private readonly centrelineMaterial = centrelineMaterial();

  constructor(options: RoadLayerOptions) {
    this.options = options;
    this.id = options.id ?? "roads";
    this.style = options.style;
    this.showCentrelines = options.centrelines ?? false;
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene.matrixWorldAutoUpdate = false;
    this.metre = MercatorCoordinate.fromLngLat([0, 0], 1).z;
    map.on("idle", this.reportStats);
  }

  onRemove(): void {
    this.map.off("idle", this.reportStats);
    for (const entry of this.tiles.values()) {
      const built = builtOf(entry);
      if (built) releaseTile(built);
    }
    this.tiles.clear();
    this.lru.clear();
    this.centrelineMaterial.dispose();
  }

  /** Show or hide the data's centrelines over the roads (see `RoadLayerOptions.centrelines`). */
  setCentrelines(visible: boolean): void {
    this.showCentrelines = visible;
    this.map?.triggerRepaint();
  }

  /** Re-evaluate the style for every loaded tile; the geometry is rebuilt where the order changed. */
  setStyle(style: RoadStyle): void {
    this.style = style;
    for (const entry of this.tiles.values()) {
      const built = builtOf(entry);
      if (!built) continue;
      release(built.gpu);
      built.gpu = this.gpuFor(built);
      built.meshes.clear();
    }
    this.map?.triggerRepaint();
  }

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    options: CustomRenderMethodInput,
  ): void {
    const main = new THREE.Matrix4().fromArray(options.defaultProjectionData.mainMatrix);
    const drawn = this.tilesToDraw().map(({ tile, wrap, clip }) => ({
      tile,
      wrap,
      clip,
      matrix: main
        .clone()
        .multiply(
          new THREE.Matrix4().makeTranslation(tile.frame.origin[0] + wrap, tile.frame.origin[1], 0),
        ),
    }));
    this.drawn = drawn;
    this.renderer.resetState();
    this.renderDraw(drawn);
  }

  /**
   * The road under a point in CSS pixels of the map canvas, anywhere on its ribbon or within
   * centreline, as drawn in the last frame; with the line's properties.
   */
  pick(x: number, y: number, radius = 3): RoadHit | null {
    const canvas = this.map.getCanvas();
    const view = { width: canvas.clientWidth, height: canvas.clientHeight };
    const targets = this.drawn.map(({ tile, matrix, clip }) => ({
      index: tile.index,
      lines: tile.lines,
      frame: tile.frame,
      table: tile.gpu.table,
      matrix: matrix.elements,
      clip,
    }));
    return pickRoad(targets, x, y, view, this.metre, radius);
  }

  private renderDraw(drawn: Drawn[]): void {
    this.scene.clear();
    this.drawCalls = 0;
    for (const { tile, wrap, clip, matrix } of drawn) {
      const eye = cameraPosition(matrix.elements);
      for (const { group, geometry } of tile.gpu.geometries) {
        for (const pass of [0, 1]) {
          const mesh = this.meshFor(tile, geometry, wrap, group, pass, clip);
          mesh.matrixWorld.copy(matrix);
          (mesh.userData.eye as THREE.Vector3).set(...eye);
          this.scene.add(mesh);
          this.drawCalls++;
        }
      }
      if (this.showCentrelines) {
        const lines = this.centrelinesFor(tile, wrap, clip);
        lines.matrixWorld.copy(matrix);
        this.scene.add(lines);
        this.drawCalls++;
      }
    }
    this.camera.projectionMatrix.identity();
    this.renderer.render(this.scene, this.camera);
  }

  private meshFor(
    tile: BuiltTile,
    geometry: THREE.BufferGeometry,
    wrap: number,
    group: number,
    pass: number,
    clip: Drawn["clip"],
  ): THREE.Mesh {
    const k = `${wrap}/${group}/${pass}/${clip.join(",")}`;
    let mesh = tile.meshes.get(k);
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, tile.gpu.material);
      // Its matrixWorld is the full projection, set each frame, so Three.js must neither recompute nor cull it.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      // Groups in ascending order, each one's casings (pass 0) before its fills (pass 1).
      mesh.renderOrder = group * 2 + pass;
      // The camera's eye in the tile's local units, set each frame.
      mesh.userData.eye = new THREE.Vector3();
      const eye = mesh.userData.eye as THREE.Vector3;
      const [x0, y0, x1, y1] = clip;
      mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
        const m = material as THREE.ShaderMaterial;
        m.uniforms.uPass.value = pass;
        (m.uniforms.uCamera.value as THREE.Vector3).copy(eye);
        // Casings write depth; fills only test it.
        m.depthWrite = pass === 0;
        (m.uniforms.uClip.value as THREE.Vector4).set(x0, y0, x1, y1);
        m.uniformsNeedUpdate = true;
      };
      tile.meshes.set(k, mesh);
    }
    return mesh;
  }

  private centrelinesFor(tile: BuiltTile, wrap: number, clip: Drawn["clip"]): THREE.LineSegments {
    tile.centrelines ??= {
      geometry: centrelineGeometry(centrelineSegments(tile.lines, tile.frame, this.metre)),
      objects: new Map(),
    };
    const { geometry, objects } = tile.centrelines;
    const k = `${wrap}/${clip.join(",")}`;
    let lines = objects.get(k);
    if (!lines) {
      lines = new THREE.LineSegments(geometry, this.centrelineMaterial);
      lines.frustumCulled = false;
      lines.matrixAutoUpdate = false;
      lines.matrixWorldAutoUpdate = false;
      const [x0, y0, x1, y1] = clip;
      const scale = tile.frame.scale;
      lines.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
        const m = material as THREE.ShaderMaterial;
        m.uniforms.uScale.value = scale;
        (m.uniforms.uClip.value as THREE.Vector4).set(x0, y0, x1, y1);
        m.uniformsNeedUpdate = true;
      };
      objects.set(k, lines);
    }
    return lines;
  }

  /**
   * The tile at `index` with the neighbours its margin reaches into, once they have all settled;
   * until then, request them. `undefined` while waiting.
   */
  private neighbourhood(index: TileIndex, loaded: LoadedTile): Neighbourhood | undefined {
    const { tileBuffer = 64, stitchMargin = 40 } = this.options;
    const { extent } = loaded.tile.layer;
    const margin = stitchMargin * unitsPerMetre(index, extent, this.metre);
    const radius = Math.max(0, Math.ceil((margin - tileBuffer) / extent));
    const tiles = 2 ** index.z;
    const sources: StitchSource[] = [];
    let settled = true;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = index.y + dy;
      if (y < 0 || y >= tiles) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const offset: [number, number] = [dx * extent, dy * extent];
        if (dx === 0 && dy === 0) {
          sources.push({ ...loaded, offset });
          continue;
        }
        const x = (((index.x + dx) % tiles) + tiles) % tiles;
        const neighbour = { z: index.z, x, y };
        this.request(neighbour);
        const entry = this.tiles.get(key(neighbour))!;
        if (entry.state === "loading") settled = false;
        else if (entry.state === "ready") {
          if (entry.loaded.tile.layer.extent !== extent) {
            throw new Error(
              `tile ${key(neighbour)} has extent ${entry.loaded.tile.layer.extent}, its neighbour ${key(index)} ${extent}`,
            );
          }
          sources.push({ ...entry.loaded, offset });
        }
      }
    }
    return settled ? { sources, extent, margin } : undefined;
  }

  private build(index: TileIndex, { sources, extent, margin }: Neighbourhood): BuiltTile {
    const start = performance.now();
    const lines = stitchedLines(sources, extent, this.options.tileBuffer ?? 64, margin);
    const tile = {
      index,
      extent,
      lines,
      frame: metreFrame(index, extent),
      nodes: lineNodes(lines),
    };
    const gpu = this.gpuFor(tile);
    performance.measure(`roads build ${key(index)}`, { start });
    return { ...tile, gpu, meshes: new Map() };
  }

  private gpuFor({
    index,
    lines,
    frame,
    nodes,
  }: Pick<BuiltTile, "index" | "lines" | "frame" | "nodes">): TileGpu {
    const start = performance.now();
    // Stubs depend on the widths, so the network drawn is the style's; picking keeps the tile's.
    const collapsed = collapseStubs(
      lines,
      frame,
      this.metre,
      evaluateStyle(this.style, lines.props),
      nodes,
    );
    const drawn = collapsed.lines;
    const drawnNodes = drawn === lines ? nodes : lineNodes(drawn);
    const table = continueShortLinks(drawn, frame, this.metre, collapsed.table, drawnNodes);
    const mesh = tessellateRoads(
      drawn,
      frame,
      this.metre,
      table,
      drawnNodes,
      this.style.cap ?? "butt",
    );
    const { texels, height } = styleTexels(table);
    performance.measure(`roads tessellate ${key(index)}`, { start });
    const texture = styleTexture(texels, height);
    return {
      table,
      mesh,
      geometries: roadGeometries(mesh),
      texture,
      material: roadMaterial(frame, texture, this.metre, this.options.casingDepthOffset ?? 1),
    };
  }

  /**
   * The covering tiles, each drawn by itself or, until it is built, by its nearest built ancestor.
   * One covering tile whose neighbours have loaded is built a frame, the rest on the frames after.
   */
  private tilesToDraw(): Omit<Drawn, "matrix">[] {
    const { minzoom, maxzoom, tileSize = 512 } = this.options;
    const covering = this.covering(tileSize, minzoom, maxzoom);
    const out: Omit<Drawn, "matrix">[] = [];
    let built = false;
    let waiting = false;
    for (const id of covering) {
      const index: TileIndex = { z: id.canonical.z, x: id.canonical.x, y: id.canonical.y };
      this.request(index);
      const own = this.tiles.get(key(index))!;
      if (own.state === "ready" && !own.built) {
        try {
          const neighbourhood = this.neighbourhood(index, own.loaded);
          if (neighbourhood && built) waiting = true;
          else if (neighbourhood) {
            own.built = this.build(index, neighbourhood);
            built = true;
          }
        } catch (error) {
          console.error(`tile ${key(index)}:`, error);
          this.tiles.set(key(index), { state: "error", error });
        }
      }
      for (let z = index.z; z >= minzoom; z--) {
        const shift = index.z - z;
        const ancestor = { z, x: index.x >> shift, y: index.y >> shift };
        const entry = this.tiles.get(key(ancestor));
        const tile = builtOf(entry);
        if (tile) {
          out.push({ tile, wrap: id.wrap, clip: footprint(index, ancestor, tile.extent) });
          break;
        }
        // An empty or failed tile has nothing to show, and no ancestor should stand in for it.
        if (entry?.state === "empty" || entry?.state === "error") break;
      }
    }
    if (waiting) this.map.triggerRepaint();
    return out;
  }

  /**
   * The tiles covering the view. MapLibre culls tiles as boxes from sea level up to the ground's
   * elevation, but these roads lie at their true elevations, which may be hundreds of metres up:
   * tiles near the camera would be left out. So each box is given the elevations of every road seen
   * so far, through the option MapLibre's own terrain uses for this (`terrain.getMinMaxElevation`),
   * which its public types leave out.
   */
  private covering(tileSize: number, minzoom: number, maxzoom: number) {
    const range = this.elevations;
    const elevations = {
      getMinMaxElevation: () => (range ? { minElevation: range[0], maxElevation: range[1] } : {}),
    };
    return this.map.coveringTiles({
      tileSize,
      minzoom,
      maxzoom,
      terrain: elevations,
    } as CoveringTilesOptions);
  }

  private request(index: TileIndex): void {
    const k = key(index);
    this.lru.delete(k);
    this.lru.add(k);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, { state: "loading" });
    fetchLineTile(tileUrl(this.options.url, index), index, this.options.layer)
      .then((tile) => {
        if (!tile) {
          this.tiles.set(k, { state: "empty" });
          return;
        }
        this.tiles.set(k, { state: "ready", loaded: { tile, props: allProps(tile.layer) } });
        this.elevations = unionRange(this.elevations, elevationRange(tile));
      })
      .catch((error: unknown) => {
        console.error(`tile ${k}:`, error);
        this.tiles.set(k, { state: "error", error });
      })
      .finally(() => {
        this.evict();
        this.map.triggerRepaint();
      });
  }

  private evict(): void {
    const max = this.options.cacheSize ?? 256;
    for (const k of this.lru) {
      if (this.tiles.size <= max) break;
      const entry = this.tiles.get(k);
      if (entry?.state === "loading") continue;
      const built = builtOf(entry);
      if (built) releaseTile(built);
      this.tiles.delete(k);
      this.lru.delete(k);
    }
  }

  private readonly reportStats = () => {
    const onStats = this.options.onStats;
    if (!onStats) return;
    const { minzoom, maxzoom, tileSize = 512 } = this.options;
    const covering = this.covering(tileSize, minzoom, maxzoom);
    const stats: RoadStats = {
      tiles: 0,
      lines: 0,
      vertices: 0,
      triangles: 0,
      drawCalls: this.drawCalls,
    };
    for (const id of covering) {
      const built = builtOf(this.tiles.get(key(id.canonical)));
      if (!built) continue;
      stats.tiles++;
      stats.lines += built.lines.props.length;
      stats.vertices += built.lines.vertices.length / 3;
      stats.triangles += built.gpu.mesh.indices.length / 3;
    }
    onStats(stats);
  };
}

/** The footprint of `child` within `ancestor`, in the ancestor's tile units. */
function footprint(
  child: TileIndex,
  ancestor: TileIndex,
  extent: number,
): [number, number, number, number] {
  const shift = child.z - ancestor.z;
  const size = extent / 2 ** shift;
  const x0 = (child.x - (ancestor.x << shift)) * size;
  const y0 = (child.y - (ancestor.y << shift)) * size;
  return [x0, y0, x0 + size, y0 + size];
}

function releaseTile(tile: BuiltTile): void {
  release(tile.gpu);
  tile.centrelines?.geometry.dispose();
}

function release(gpu: TileGpu): void {
  for (const { geometry } of gpu.geometries) geometry.dispose();
  gpu.texture.dispose();
  gpu.material.dispose();
}
