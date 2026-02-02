
export class BoundaryTracer {
  private width: number;
  private height: number;
  private labels: Int32Array;

  constructor(width: number, height: number, labels: Int32Array) {
    this.width = width;
    this.height = height;
    this.labels = labels;
  }

  /**
   * Trace boundaries for all labels found in the map.
   * Returns a map of Label ID -> Array of Points (Polygon)
   */
  public traceAll(): Map<number, { x: number, y: number }[]> {
    const polygons = new Map<number, { x: number, y: number }[]>();
    const uniqueLabels = new Set<number>();

    // Find visible labels
    for (let i = 0; i < this.labels.length; i++) {
      if (this.labels[i] > 0) uniqueLabels.add(this.labels[i]);
    }

    for (const label of uniqueLabels) {
      const poly = this.traceLabel(label);
      if (poly.length > 2) {
        polygons.set(label, poly);
      }
    }
    return polygons;
  }

  /**
   * Extracts the boundary of a specific label using marching squares or simple scanning.
   * Simple approach: Marching Squares optimized for binary mask (Label vs Not Label).
   */
  private traceLabel(targetLabel: number): { x: number, y: number }[] {
    // 1. Find a starting point (top-leftmost pixel of this label)
    let startX = -1, startY = -1;

    outer: for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.labels[y * this.width + x] === targetLabel) {
          startX = x;
          startY = y;
          break outer;
        }
      }
    }

    if (startX === -1) return []; // Label not found

    // 2. Moore-Neighbor Tracing (or simliar)
    // We need to trace the OUTER edge. 
    // A pixel is on edge if it is 'targetLabel' and at least one 4-neighbor is NOT 'targetLabel'.

    const points: { x: number, y: number }[] = [];
    let currX = startX;
    let currY = startY;

    // Direction coding: 0=Right, 1=Down, 2=Left, 3=Up
    // Start moving Right (or find first valid move)
    // Moore algorithm usually backtracks.

    // Let's use Marching Squares (Isolines) for cleaner vectors? 
    // No, MS produces isolated segments, need chaining.
    // Let's stick to Wall Follower on the grid.

    // Simple Boundary Follower:
    // Always keep "Not Label" on your Left.

    let dir = 0; // Initial direction (Right)
    // Find initial direction such that Left is "Outside"
    // At startX, startY (Top-Leftmost), the pixel above (Up) or Left is definitely Outside.
    // So facing Right, Left is Up (Outside). OK.

    const startPos = { x: currX, y: currY };
    let steps = 0;
    const maxSteps = this.width * this.height * 2; // Safety break

    do {
      points.push({ x: currX, y: currY });

      // Try to turn Left (relative to current dir) first, then Straight, then Right, then Back
      // "Left Hand on Wall" rule where Wall is the "Outside".
      // So we want to stay ON the label, keeping Outside on Left.

      // Directions: 0:Right(1,0), 1:Down(0,1), 2:Left(-1,0), 3:Up(0,-1)
      // Relative Left is (dir + 3) % 4

      let foundNext = false;
      // Check directions in order: Left, Straight, Right, Back
      // Order: (dir+3)%4, dir, (dir+1)%4, (dir+2)%4
      const turnOrder = [3, 0, 1, 2];

      for (const turn of turnOrder) {
        const checkDir = (dir + turn) % 4;
        const nextX = currX + (checkDir === 0 ? 1 : checkDir === 2 ? -1 : 0);
        const nextY = currY + (checkDir === 1 ? 1 : checkDir === 3 ? -1 : 0);

        if (this.isLabel(nextX, nextY, targetLabel)) {
          // Found valid next pixel
          currX = nextX;
          currY = nextY;
          dir = checkDir;
          foundNext = true;
          break;
        }
      }

      if (!foundNext) break; // Isolated pixel?

      steps++;
      if (steps > maxSteps) break;

    } while (currX !== startX || currY !== startY);

    return this.simplify(points, 2.0); // Simple Douglas-Peucker
  }

  private isLabel(x: number, y: number, label: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return this.labels[y * this.width + x] === label;
  }

  // Simple Douglas-Peucker simplification
  private simplify(points: { x: number, y: number }[], epsilon: number): { x: number, y: number }[] {
    if (points.length <= 2) return points;

    const dmax = 0;
    let index = 0;
    const end = points.length - 1;

    // Find point with max distance from line(start, end)
    let maxDist = 0;
    for (let i = 1; i < end; i++) {
      const d = this.perpendicularDistance(points[i], points[0], points[end]);
      if (d > maxDist) {
        index = i;
        maxDist = d;
      }
    }

    if (maxDist > epsilon) {
      const res1 = this.simplify(points.slice(0, index + 1), epsilon);
      const res2 = this.simplify(points.slice(index), epsilon);
      return [...res1.slice(0, res1.length - 1), ...res2];
    } else {
      return [points[0], points[end]];
    }
  }

  private perpendicularDistance(p: { x: number, y: number }, p1: { x: number, y: number }, p2: { x: number, y: number }): number {
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    if (dx === 0 && dy === 0) {
      return Math.sqrt(Math.pow(p.x - p1.x, 2) + Math.pow(p.y - p1.y, 2));
    }

    const num = Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x);
    const den = Math.sqrt(dy * dy + dx * dx);
    return num / den;
  }
}
