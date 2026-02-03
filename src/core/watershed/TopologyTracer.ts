
export class TopologyTracer {
  private width: number;
  private height: number;
  private labels: Int32Array;

  constructor(width: number, height: number, labels: Int32Array) {
    this.width = width;
    this.height = height;
    this.labels = labels;
  }

  /**
   * Trace topology-aware boundaries.
   * 1. Extract all atomic edges between pixels.
   * 2. Identify Nodes (junctions).
   * 3. Trace Macro-Edges between Nodes.
   * 4. Simplify Macro-Edges.
   * 5. Reconstruct Polygons.
   */
  public traceAll(): Map<number, { x: number, y: number }[]> {
    // Step 1: Extract Atomic Edges and build Point Graph
    const { graph, nodes } = this.buildGraph();

    // Step 2: Trace Macro Edges (paths between nodes)
    const macroEdges = this.traceMacroEdges(graph, nodes);

    // Step 3: Simplify Macro Edges
    this.simplifyMacroEdges(macroEdges);

    // Step 4: Reconstruct Polygons
    return this.reconstructPolygons(macroEdges);
  }

  // --- Graph Building ---

  private buildGraph() {
    // Point ID: y * (width+1) + x
    const w1 = this.width + 1;
    const h1 = this.height + 1;

    // Graph: Map<pointId, List<{neighborPointId, labelLeft, labelRight}>>
    const graph = new Map<number, { next: number, left: number, right: number }[]>();

    // Set of points that are strictly Nodes (Degree != 2)
    // Initialize with corners of image which are always nodes
    const potentialNodes = new Set<number>();
    potentialNodes.add(0);
    potentialNodes.add(this.width);
    potentialNodes.add(this.height * w1);
    potentialNodes.add(this.height * w1 + this.width);

    const addEdge = (p1: number, p2: number, left: number, right: number) => {
      if (!graph.has(p1)) graph.set(p1, []);
      if (!graph.has(p2)) graph.set(p2, []);

      // Directed edge from p1 to p2 has 'left' label and 'right' label relative to direction
      graph.get(p1)!.push({ next: p2, left, right });
      // The reverse edge (p2->p1) would have swapped left/right? 
      // We store undirected segments basically, but let's store both directions for traversal?
      // Actually, tracing is directional. 
      // Let's just track connections.
      // Edge p1->p2: Left is 'left', Right is 'right'.
      // Edge p2->p1: Left is 'right', Right is 'left'.
      graph.get(p2)!.push({ next: p1, left: right, right: left });
    };

    const getLabel = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1; // Outside
      return this.labels[y * this.width + x];
    };

    // Vertical Segments (between Col x-1 and x)
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x <= this.width; x++) {
        const l1 = getLabel(x - 1, y);
        const l2 = getLabel(x, y);
        if (l1 !== l2) {
          const p1 = y * w1 + x;     // Top point of vertical segment
          const p2 = (y + 1) * w1 + x; // Bottom point
          addEdge(p1, p2, l1, l2); // Going Down: Left is x-1(l1), Right is x(l2)
          potentialNodes.add(p1);
          potentialNodes.add(p2);
        }
      }
    }

    // Horizontal Segments (between Row y-1 and y)
    for (let y = 0; y <= this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const l1 = getLabel(x, y - 1);
        const l2 = getLabel(x, y);
        if (l1 !== l2) {
          const p1 = y * w1 + x;     // Left point
          const p2 = y * w1 + (x + 1); // Right point
          addEdge(p1, p2, l2, l1);
          // Going Right: Left is y (l2 - wait?), Right is y-1 (l1).
          // Coord system: Y grows Down.
          // Moving Right: Top is y-1 (Left), Bottom is y (Right).
          // So Left=l1, Right=l2.
          // Correct: Going Right along Y-boundary. Top pixel is (x, y-1). Bottom is (x,y).
          // Left hand is Top (y-1) -> l1. Right hand is Bottom (y) -> l2.
          // Correction applied above: addEdge(p1, p2, l1, l2).

          potentialNodes.add(p1);
          potentialNodes.add(p2);
        }
      }
    }

    // Filter actual nodes (Degree != 2)
    const nodes = new Set<number>();
    for (const p of potentialNodes) {
      const context = graph.get(p);
      if (!context || context.length !== 2) {
        nodes.add(p);
      }
    }

    return { graph, nodes };
  }

  // --- Trace Macro Edges ---

  private traceMacroEdges(graph: Map<number, { next: number, left: number, right: number }[]>, nodes: Set<number>) {
    const macroEdges: { points: { x: number, y: number }[], left: number, right: number }[] = [];
    const visitedSegments = new Set<string>(); // "p1-p2"

    const w1 = this.width + 1;
    const getPoint = (idx: number) => ({ x: idx % w1, y: Math.floor(idx / w1) });

    for (const startNode of nodes) {
      const neighbors = graph.get(startNode);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        const nextNode = neighbor.next;
        // Check if segment visited
        const segKey = startNode < nextNode ? `${startNode}-${nextNode}` : `${nextNode}-${startNode}`;
        if (visitedSegments.has(segKey)) continue;

        // Start tracing a new Macro Edge
        const path = [startNode];
        let curr = nextNode;
        let prev = startNode;

        // Labels for this edge
        const labelLeft = neighbor.left;
        const labelRight = neighbor.right;

        visitedSegments.add(segKey);

        while (!nodes.has(curr)) {
          path.push(curr);
          const currNeighbors = graph.get(curr)!;
          // Find the one that isn't 'prev'
          // Since intermediate nodes have degree 2, there is exactly 1 other.
          const nextStep = currNeighbors.find(n => n.next !== prev);

          if (!nextStep) break; // Should not happen in valid graph

          prev = curr;
          curr = nextStep.next;

          const nextKey = prev < curr ? `${prev}-${curr}` : `${curr}-${prev}`;
          visitedSegments.add(nextKey);
        }
        path.push(curr); // Add the ending Node

        // Convert indices to Points
        const pointPath = path.map(getPoint);
        macroEdges.push({ points: pointPath, left: labelLeft, right: labelRight });
      }
    }
    return macroEdges;
  }

  // --- Simplification ---

  private simplifyMacroEdges(edges: { points: { x: number, y: number }[], left: number, right: number }[]) {
    for (const edge of edges) {
      edge.points = this.simplify(edge.points, 2.0); // Epsilon 2.0
    }
  }

  // --- Reconstruction ---

  private reconstructPolygons(edges: { points: { x: number, y: number }[], left: number, right: number }[]) {
    const polygons = new Map<number, { x: number, y: number }[]>();

    // Group edges by label
    const labelEdges = new Map<number, { points: { x: number, y: number }[], reversed: boolean }[]>();

    const add = (lbl: number, pts: { x: number, y: number }[], rev: boolean) => {
      if (lbl < 0) return; // Don't build polygon for 'Outside'
      if (!labelEdges.has(lbl)) labelEdges.set(lbl, []);
      labelEdges.get(lbl)!.push({ points: pts, reversed: rev });
    };

    for (const edge of edges) {
      // For 'Left' label, points are ordered correctly?
      // Our Edge definition: P1 -> P2. Left is Left.
      // If we walk P1->P2, the Left Region is on our Left.
      // So for the Left Region, the boundary is CCW (Standard polygon).
      // So add edge As-Is for Left.
      add(edge.left, edge.points, false);

      // For 'Right' label, the boundary is on its Right.
      // To make it CCW for the Right Region, we must walk P2->P1.
      // So add edge Reversed for Right.
      add(edge.right, edge.points, true);
    }

    // Stitch loop
    for (const [label, fragments] of labelEdges) {
      if (fragments.length === 0) continue;

      const finalPoly: { x: number, y: number }[] = [];
      // Naive stitching: Find start/end match
      // Map StartPoint string -> Fragment

      const remaining = new Set(fragments.map((_, i) => i));
      let currentFragIdx = 0; // Start with first
      remaining.delete(0);

      let currentLoop = [...(fragments[0].reversed ? [...fragments[0].points].reverse() : fragments[0].points)];
      // Remove last point of first fragment to avoid duplication during stitch?
      // Actually, we keep it and check equality.

      while (remaining.size > 0) {
        const endPt = currentLoop[currentLoop.length - 1];

        // Find next fragment starting at endPt
        let foundMatch = -1;
        for (const idx of remaining) {
          const frag = fragments[idx];
          const pts = frag.reversed ? [...frag.points].reverse() : frag.points;
          const startPt = pts[0];

          if (Math.abs(startPt.x - endPt.x) < 0.001 && Math.abs(startPt.y - endPt.y) < 0.001) {
            foundMatch = idx;
            // Append (skip first point as it is duplicate)
            for (let k = 1; k < pts.length; k++) currentLoop.push(pts[k]);
            break;
          }
        }

        if (foundMatch !== -1) {
          remaining.delete(foundMatch);
        } else {
          // Disjoint loop? Stop this poly.
          // For watershed, regions should be single connected components usually.
          // If complex, we might have holes (not handled here).
          break;
        }
      }

      polygons.set(label, currentLoop);
    }

    return polygons;
  }

  // --- Utils ---

  private simplify(points: { x: number, y: number }[], epsilon: number): { x: number, y: number }[] {
    if (points.length <= 2) return points;
    const end = points.length - 1;
    let index = 0;
    let maxDist = 0;
    for (let i = 1; i < end; i++) {
      const d = this.distToSegment(points[i], points[0], points[end]);
      if (d > maxDist) { index = i; maxDist = d; }
    }
    if (maxDist > epsilon) {
      const r1 = this.simplify(points.slice(0, index + 1), epsilon);
      const r2 = this.simplify(points.slice(index), epsilon);
      return [...r1.slice(0, r1.length - 1), ...r2];
    } else {
      return [points[0], points[end]];
    }
  }

  private distToSegment(p: { x: number, y: number }, v: { x: number, y: number }, w: { x: number, y: number }): number {
    const l2 = (w.x - v.x) ** 2 + (w.y - v.y) ** 2;
    if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2);
  }
}
