# Design notes

These notes explain how `threejs-mlt-road-renderer` turns road centrelines from vector tiles into
road symbols on a MapLibre map, and why it is built the way it is. They read as a short series:
each post builds on the ones before it, but each can also be read on its own.

1. [Drawing roads, not lines](01-drawing-roads.md): what the library does, what makes it hard, and
   the pipeline from a tile to pixels.
2. [Three.js inside MapLibre](02-threejs-in-maplibre.md): how the layer shares MapLibre's WebGL
   context and which Three.js APIs it uses, and how.
3. [Modelling a road](03-modelling-roads.md): lines, nodes, the style table, and ribbons whose width
   is applied on the GPU.
4. [One outline for a network](04-one-outline.md): casings and fills, draw groups, and getting the
   depth test right from every camera angle.
5. [Junctions](05-junctions.md): corners, who owns a junction, and how far the owner's colour may
   reach.
6. [Tiles without seams](06-tiles.md): stitching neighbouring tiles, and what changes when the tile
   grid gets coarser.
7. [A gallery of artefacts](07-artefacts.md): each visual flaw we ran into, what caused it, and what
   fixed it.

## The figures

Every figure is an SVG in [`figures/`](figures/). The road pictures are not drawings: they are small
synthetic networks tessellated by the library itself and painted in the order the GPU draws them,
so they show exactly what the renderer does. The diagrams are drawn from the same geometry.
Regenerate them all with:

```bash
bun scripts/figures/render.ts
```
