# 7. A gallery of artefacts

Most of the rules in the previous posts exist because something once looked wrong. This post
collects those flaws in one place, roughly in the order we met them: what you would see, why it
happened, and what the renderer does now. If you are changing the junction code, this is the list
of things to check you have not brought back.

### Outlines through every junction

**Seen:** every link outlined on its own; outlines crossing the middle of junctions; a notch where a
road bends between two links.
**Cause:** drawing each road's casing and fill together, road by road.
**Now:** all casings of a draw group, then all fills ([post 4](04-one-outline.md)), and junctions
built from the topology ([post 5](05-junctions.md)).
See `figures/outlines.svg`.

### A junction cut in half by a tile boundary

**Seen:** at a tile edge, a road protruding past a junction on one side and clipped short on the
other; outlines with a hairline gap along the boundary.
**Cause:** each tile was built only from its own lines, which its tiler had clipped a couple of
metres past its edge, too little for a junction to be complete.
**Now:** tiles are built from their neighbours' lines too, stitched and cut to a margin
([post 6](06-tiles.md)).

### A wedge between two side roads

**Seen:** where two side roads leave a main road close together, a wedge of the main road's colour
running out between them, far beyond the main road's edge.
**Cause:** the junction's whole polygon was filled in the owner's colour, and the corner between
two side roads at a sharp angle can lie tens of metres out.
**Now:** the owner fills only up to its own outline; the side roads draw their own mouths and the
gap between them ([post 5](05-junctions.md)). See `figures/lower-roads.svg`, left.

### A spike past a corner neither road reaches

**Seen:** a thin spike of colour pointing out from a junction where two roads leave nearly
parallel.
**Cause:** their edges meet far out, past the point where both roads bend away, and the polygon
was filled to that corner.
**Now:** a corner beyond where both of its links stop running straight is no boundary; the outline
bounds the owner beside it.

### A zigzag at a change of width

**Seen:** where a road widens or narrows at a junction, its edge stepping in and out between the
side roads.
**Cause:** the owner's outline followed a round join on a side that was nearly straight.
**Now:** the round join is used only where the road turns by 15° or more; elsewhere the mouths of
the side roads bound it.

### A gap on the outside of a bend

**Seen:** on the outside of a bend at a junction, a sliver of the side road's colour, or bare
ground, between the main road and its outline.
**Cause:** the polygon's straight edge cut across the inside of the round join.
**Now:** beside corners that do not bound the owner, the side follows the outline itself, round the
join, and each end's body is filled out to the node. See `figures/bends.svg`.

### A bump where a short link ends

**Seen:** a side road's mouth cutting a small wedge into a main road, a couple of metres from a
junction.
**Cause:** the owner's outline stopped where its first segment ended, and the data had split the
main road there, a few metres past the junction, for an attribute that did not change its drawing.
**Now:** the outline runs as far as the road runs straight: through vertices and through nodes of
two into links drawn alike, while it turns by less than 15° ([post 5](05-junctions.md)).

### A slip road drawn over the main road

**Seen:** a road merging at a shallow angle drawn on top of the road it joins, for the whole length
of their overlap.
**Cause:** the merging road had the higher rank, and rank alone ordered the fills.
**Now:** a road ending at a junction owned by another road is lowered beneath it, along with the
links it continues into ([post 4](04-one-outline.md)). See `figures/lower-roads.svg`, right.

### A jagged notch at a steep pitch

**Seen:** at a high camera pitch, a road slightly above another cutting a ragged notch out of it;
the notch grew as the camera tilted, though the geometry had not changed.
**Cause:** the casing's depth was taken one metre straight down, which counts for only
`cos(pitch)` metres along the line of sight.
**Now:** the casing's depth is taken one metre lower along the vertex's own view ray
([post 4](04-one-outline.md)). See `figures/depth.svg`.

### A junction that changes with the zoom level

**Seen:** a main road running through a crossing at one zoom level and cut by the side road at the
next.
**Cause:** at the coarser tile grid, a short link's rounded coordinates turned the main road's
slight bend into one just past the limit for running through, and a straight side road took the
junction.
**Now:** rank comes before running straight ([posts 5](05-junctions.md) and
[6](06-tiles.md)). See `figures/ownership.svg` and `figures/rounding.svg`.

### Two side roads notching a wide road

**Seen:** two side roads meeting each other at the middle of a wide road, and a notch in the wide
road's edge between them.
**Cause:** their shared corner lay inside the wide road, and the owner filled only up to it.
**Now:** where two other roads meet against one of the owner's straight edges, their corner is
pushed out onto that edge. See `figures/lower-roads.svg`, middle.

### A twisted crossing

**Seen:** a road ending in a pointed wedge just short of a crossing, the crossing road seeming to
take over the junction.
**Cause:** the last few metres of the road were a separate, narrower link, shorter than the taper
it needed; tapered, the whole link became a wedge.
**Now:** such a link is drawn as the road it continues ([post 5](05-junctions.md)). See
`figures/widths.svg`.

## Things that are not artefacts

A few effects look like bugs but are honest renderings of the data:

- **Roads disappearing under other roads.** A road several metres above another hides it, outline
  and all. That is a flyover, seen from above.
- **A road narrowing in the distance.** Widths are in metres, so at a steep pitch roads narrow
  towards the horizon, as the ground does.
- **Basemap symbols on top.** Labels and icons from a basemap can end up drawn over the road
  layer. An icon with a white centre sitting on a crossing can look remarkably like a white road
  crossing over a coloured one.
