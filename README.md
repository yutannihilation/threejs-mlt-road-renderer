# threejs-mlt-road-renderer

A [MapLibre](https://maplibre.org/) custom layer that draws 3D road centrelines from
[MapLibre Tiles (MLT)](https://github.com/maplibre/maplibre-tile-spec) as road symbols, with
[Three.js](https://threejs.org/):

- per-feature widths in metres and colours, with an outline;
- one outline round the whole road network, not round each link;
- clean junctions, where the more important road runs through and the others stop at its edges;
- smooth curves, round joins, and graceful changes of width;
- true elevation: bridges pass over roads, and a road several metres above another keeps its own
  outline from any camera angle;
- no seams at tile boundaries.

![One outline for the whole network](docs/design/figures/outlines.svg)

## Usage

```ts
import { RoadLayer } from "threejs-mlt-road-renderer";

const roads = new RoadLayer({
  url: "https://example.com/tiles/{z}/{x}/{y}.mlt",
  layer: "roads", // the line layer in the tiles
  minzoom: 0,
  maxzoom: 14,
  style: {
    group: (p) => (p.bridge ? 1 : 0), // draw level
    rank: (p) => ({ primary: 2, secondary: 1 })[String(p.class)] ?? 0,
    width: (p) => Number(p.width) || 4, // full width, metres
    color: (p) => (p.class === "primary" ? "#f4b860" : "#ffffff"),
    outline: { width: () => 0.6, color: () => "#5c5c5c" }, // metres per side
    cap: "round",
  },
});
map.addLayer(roads);

roads.setStyle(otherStyle); // restyle every loaded tile
const hit = roads.pick(x, y); // the road under a point on the canvas, or null
```

Style functions receive one feature's properties as a plain object. Widths are metres on the
ground at every zoom. See [`src/style.ts`](src/style.ts) for the full contract and
[`src/layer.ts`](src/layer.ts) for the layer's options:

| option              | default |                                                                                           |
| ------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `tileSize`          | `512`   | tile size in CSS pixels, for choosing tiles                                               |
| `tileBuffer`        | `64`    | how far past each tile, in tile units, the tiler kept its lines                           |
| `stitchMargin`      | `40`    | how far past a tile, in metres, the lines it is built from reach                          |
| `casingDepthOffset` | `1`     | how far below a road, in metres, its outline counts for the depth test                    |
| `cacheSize`         | `256`   | tiles kept in memory beyond those in view                                                 |
| `centrelines`       | `false` | draw the data's own centrelines as thin red lines, for debugging; also `setCentrelines()` |
| `onStats`           |         | called when the map is idle with what is drawn                                            |

## Data

The layer expects MLT tiles with a layer of 3D line strings: road centrelines whose links share
exact end points where they meet, with z as elevation in metres (on a grid given by the tile's z
step). Every zoom level should hold the detail you want to draw at it. Properties are free-form;
your style reads them.

## How it works

The [design notes](docs/design/README.md) explain the renderer in a short series of posts: the
pipeline, how it uses Three.js inside MapLibre, how roads and junctions are modelled, how outlines
and the depth test work, how tiles are stitched, and a gallery of the visual flaws the design
avoids.

## Development

`@maplibre/mlt-wasm` is linked from a sibling checkout of
[maplibre-tile-spec](https://github.com/maplibre/maplibre-tile-spec) at the tag
[`mlt-wasm-js-v0.1.44`](https://github.com/maplibre/maplibre-tile-spec/releases/tag/mlt-wasm-js-v0.1.44),
built with `npm run build` in `rust/mlt-wasm` (the package on npm ships without its wasm):

```text
repo/
├── maplibre-tile-spec/          at mlt-wasm-js-v0.1.44
└── threejs-mlt-road-renderer/   this repository
```

```bash
vp install
vp dev            # the demo on http://localhost:5173/
vp check          # format, lint, typecheck
vp test           # unit tests
vp run build:lib  # dist/index.js, with three, maplibre-gl and @maplibre/mlt-wasm external
vp build          # the demo, with its tiles, in dist-demo/
bun scripts/figures/render.ts  # regenerate the design notes' figures
```

Pushes to `main` deploy the demo to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)),
building `@maplibre/mlt-wasm` from maplibre-tile-spec at the tagged commit pinned there.

### Demo data

The demo shows three 4 × 4 km squares of
[swissTLM3D](https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d) (© swisstopo, free to
use with attribution), chosen for their height differences: the motorway interchange of Zürich Nord,
the Biaschina viaduct high above a switchbacking road, and the Tremola hairpins below the Gotthard
Pass. The roads are drawn at their true elevations on a plain background, with no terrain; the panel
jumps between the scenes, aiming the camera at each one's height. The demo reads tiles from
`./data/{z}/{x}/{y}.mlt`, served at `tiles/` in development and copied there into builds. To rebuild them,
stream each square's roads out of the national download with GDAL (3.11 or later), merge them, and
tile them with the fork's `mlt` tool:

```bash
area() {
  gdal vector pipeline --config CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.zip \
    read "/vsizip//vsicurl/https://data.geo.admin.ch/ch.swisstopo.swisstlm3d/swisstlm3d_2026-02/swisstlm3d_2026-02_2056_5728.shp.zip/TLM_STRASSEN/swissTLM3D_TLM_STRASSE.shp" \
    ! filter --bbox "$2" \
    ! select --fields _ogr_geometry_,OBJEKTART,KUNSTBAUTE,STUFE,RICHTUNGSG,KREISEL,BELAGSART,BEFAHRBARK,WANDERWEGE,VERKEHRSBE,VERKEHRSBD,NAME \
    ! set-geom-type --dim XYZ \
    ! reproject --output-crs EPSG:4326 \
    ! write "data/source/$1.geojson" --lco RFC7946=YES --lco COORDINATE_PRECISION=7
}
area zurichnord 2685500,1249500,2689500,1253500
area biaschina 2706500,1141500,2710500,1145500
area tremola 2684500,1153500,2688500,1157500
gdal vector concat --mode single --output-layer roads \
  -i data/source/zurichnord.geojson -i data/source/biaschina.geojson -i data/source/tremola.geojson \
  data/source/roads.geojson --lco RFC7946=YES --lco COORDINATE_PRECISION=7
../maplibre-tile-spec/rust/target/release/mlt convert --mlt-version 2 --max-zoom 18 \
  --layer roads --z-step -2 data/source/roads.geojson data/tiles
mv data/tiles/* data/ && rmdir data/tiles
```

GDAL reads only the roads layer out of the remote zip, but has to stream through all of it, about
a minute and a half per square. Clicking a road in the demo shows its properties.

## Limits

- Tiles are decoded, stitched and tessellated on the main thread; a worker would remove the hitch
  for large tiles.
- Colours are opaque: overlapping triangles would show through translucent ones.
- Ribbons lie in the ground plane: no banking, and no minimum width in pixels when zoomed out.
- Where roads of different draw groups meet at a node, the lower group's outline can show along the
  junction's edge ([design notes, post 4](docs/design/04-one-outline.md#limits)).
