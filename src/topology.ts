import type { Lines } from "./lines";

/** One end of a line at a node. */
export interface NodeEnd {
  readonly line: number;
  /** Whether it is the line's last vertex (`true`) or its first. */
  readonly atEnd: boolean;
}

/** Which node each line starts and ends at, and the line ends meeting at each node. */
export interface LineNodes {
  /** The node of each line's first vertex; `-1` for a line of fewer than two vertices. */
  readonly startNode: Int32Array;
  readonly endNode: Int32Array;
  /** The ends at each node, in line order, a line's start before its end. */
  readonly nodes: readonly (readonly NodeEnd[])[];
}

/**
 * The network of `lines` as the data stores it: two line ends at the same `(x, y, z)` are the same
 * node. A line with fewer than two vertices makes no segment and touches no node; a clipped end,
 * where the data runs out rather than the line, touches no node either.
 */
export function lineNodes({
  vertices,
  lineStart,
  startClipped,
  endClipped,
}: Pick<Lines, "vertices" | "lineStart" | "startClipped" | "endClipped">): LineNodes {
  const lines = lineStart.length - 1;
  const keyOf = (vertex: number): string => {
    const i = vertex * 3;
    return `${vertices[i]},${vertices[i + 1]},${vertices[i + 2]}`;
  };
  const index = new Map<string, number>();
  const nodes: NodeEnd[][] = [];
  const nodeOf = (vertex: number, end: NodeEnd): number => {
    const key = keyOf(vertex);
    let n = index.get(key);
    if (n === undefined) {
      n = nodes.length;
      index.set(key, n);
      nodes.push([]);
    }
    nodes[n].push(end);
    return n;
  };
  const startNode = new Int32Array(lines).fill(-1);
  const endNode = new Int32Array(lines).fill(-1);
  for (let l = 0; l < lines; l++) {
    if (lineStart[l + 1] - lineStart[l] < 2) continue;
    if (!startClipped[l]) startNode[l] = nodeOf(lineStart[l], { line: l, atEnd: false });
    if (!endClipped[l]) endNode[l] = nodeOf(lineStart[l + 1] - 1, { line: l, atEnd: true });
  }
  return { startNode, endNode, nodes };
}
