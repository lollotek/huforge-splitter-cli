import { PriorityQueue } from './PriorityQueue';

export class WatershedSegmenter {
  private width: number;
  private height: number;
  private heightMap: Float32Array;
  private labels: Int32Array;
  private gradientMap: Float32Array;

  constructor(width: number, height: number, heightMap: Float32Array) {
    this.width = width;
    this.height = height;
    this.heightMap = heightMap;
    this.labels = new Int32Array(width * height).fill(0);
    this.gradientMap = new Float32Array(width * height);
    this.computeGradient();
  }

  public getGradientMap(): Float32Array {
    return this.gradientMap;
  }

  /**
   * Compute gradient magnitude (Sobel-like or simple difference)
   * High gradient = Edges/Creases (Costly to cross)
   */
  private computeGradient() {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const idx = y * this.width + x;

        // Simple morphological gradient (max - min in 3x3)
        // Or just neighbor diffs. Let's do simple max neighbor diff.
        let maxDiff = 0;
        const val = this.heightMap[idx];

        // Check 4 neighbors
        const neighbors = [
          { x: x - 1, y: y }, { x: x + 1, y: y },
          { x: x, y: y - 1 }, { x: x, y: y + 1 }
        ];

        for (const n of neighbors) {
          if (n.x >= 0 && n.x < this.width && n.y >= 0 && n.y < this.height) {
            const nIdx = n.y * this.width + n.x;
            const diff = Math.abs(val - this.heightMap[nIdx]);
            if (diff > maxDiff) maxDiff = diff;
          }
        }
        this.gradientMap[idx] = maxDiff;
      }
    }
  }

  /**
   * Apply constraints (e.g. SVG paths) to the gradient map.
   * These areas become "High Walls" that are hard to cross.
   */
  public applyBarriers(barrierMask: boolean[][], penalty: number = 1000) {
    // console.log("Applying barriers to gradient map...");
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const idx = y * this.width + x;
        if (barrierMask[y][x]) {
          const current = this.gradientMap[idx];
          this.gradientMap[idx] += penalty;
        }
      }
    }
  }

  /**
   * Main Watershed Algorithm (Meyer's Flooding)
   * @param seeds Array of {x, y, label}
   */
  public segment(seeds: { x: number, y: number, label: number }[]): Int32Array {
    const pq = new PriorityQueue<number>(); // Stores Pixel Indices

    // 1. Initialize with Seeds
    for (const seed of seeds) {
      const idx = seed.y * this.width + seed.x;
      if (idx >= 0 && idx < this.labels.length) {
        this.labels[idx] = seed.label;
        pq.enqueue(idx, 0); // Priority 0 (Highest)
      }
    }

    // 2. Flood
    const neighborsOffsets = [-1, 1, -this.width, this.width]; // Left, Right, Up, Down

    while (!pq.isEmpty()) {
      const currIdx = pq.dequeue();
      if (currIdx === undefined) break;

      const currLabel = this.labels[currIdx];

      // Visit neighbors
      for (const offset of neighborsOffsets) {
        const nIdx = currIdx + offset;

        // Bounds check (rough, need careful edge handling for left/right wrap)
        // Wrap check: if jumping rows, x should be consistent? 
        // Simple 1D array logic is risky for wrap-around.
        // Let's do explicit X/Y check for safety.
        const cx = currIdx % this.width;
        const cy = Math.floor(currIdx / this.width);

        // Re-calculate neighbor coord
        let nx = cx, ny = cy;
        if (offset === -1) nx--;
        else if (offset === 1) nx++;
        else if (offset === -this.width) ny--;
        else if (offset === this.width) ny++;

        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;

        const neighborRealIdx = ny * this.width + nx;

        if (this.labels[neighborRealIdx] === 0) {
          // Unlabeled: Claim it
          this.labels[neighborRealIdx] = currLabel;
          // Enqueue with cost = Gradient Magnitude
          // Meyer's var: cost = max(current_prio, gradient(neighbor)) ?
          // Simple flooding: cost = gradient(neighbor)
          const cost = this.gradientMap[neighborRealIdx];
          pq.enqueue(neighborRealIdx, cost);
        }
      }
    }

    return this.labels;
  }
}
