import { Point3D } from '../utils/GeometryUtils';
import earcut from 'earcut';

export class CapUtils {
  /**
   * Reconstructs closed loops from a bag of segments and triangulates them 
   * using Ear Clipping with Arc-Length Parameterization (UV Unrolling).
   */
  static triangulateSegments(segments: [Point3D, Point3D][]): Point3D[][] {
    const loops = this.reconstructLoops(segments);
    const output: Point3D[][] = [];

    for (const loop of loops) {
      if (loop.length < 3) continue;

      // 1. Unroll the loop to 2D using Arc Length (U) and Z (V).
      const points2D: number[] = [];
      let currentU = 0;
      points2D.push(0, loop[0].z);

      for (let i = 1; i < loop.length; i++) {
        const pPrev = loop[i - 1];
        const pCurr = loop[i];
        const distXY = Math.hypot(pCurr.x - pPrev.x, pCurr.y - pPrev.y);
        currentU += distXY;
        points2D.push(currentU, pCurr.z);
      }

      // 2. Ear Clipping
      try {
        const indices = earcut(points2D);
        for (let i = 0; i < indices.length; i += 3) {
          const idx1 = indices[i];
          const idx2 = indices[i + 1];
          const idx3 = indices[i + 2];
          output.push([loop[idx1], loop[idx2], loop[idx3]]);
        }
      } catch (e) {
        console.warn("Cap Triangulation failed for a loop:", e);
      }
    }
    return output;
  }

  // Quantize/Snap vertices to fix precision gaps
  private static snapPoint(p: Point3D): Point3D {
    const PRECISION = 100; // 0.01mm
    return {
      x: Math.round(p.x * PRECISION) / PRECISION,
      y: Math.round(p.y * PRECISION) / PRECISION,
      z: Math.round(p.z * PRECISION) / PRECISION
    };
  }

  private static reconstructLoops(segments: [Point3D, Point3D][]): Point3D[][] {
    console.log(`Debug: Reconstructing loops from ${segments.length} segments with Snapping...`);

    // 1. Snap all segments
    const pool = segments.map(s => [this.snapPoint(s[0]), this.snapPoint(s[1])] as [Point3D, Point3D]);
    const resultLoops: Point3D[][] = [];

    const pk = (p: Point3D) => `${p.x}_${p.y}_${p.z}`; // Exact string match after rounding

    while (pool.length > 0) {
      const seg = pool.pop()!;
      const loop: Point3D[] = [seg[0], seg[1]];
      let tail = seg[1];
      let closed = false;

      while (true) {
        let foundIdx = -1;
        let nextPt: Point3D | null = null;
        const tailKey = pk(tail);

        for (let i = 0; i < pool.length; i++) {
          const s = pool[i];
          if (pk(s[0]) === tailKey) {
            foundIdx = i; nextPt = s[1]; break;
          } else if (pk(s[1]) === tailKey) {
            foundIdx = i; nextPt = s[0]; break;
          }
        }

        if (foundIdx !== -1 && nextPt) {
          if (pk(nextPt) === pk(loop[0])) {
            closed = true;
            pool.splice(foundIdx, 1);
            break;
          }
          loop.push(nextPt);
          tail = nextPt;
          pool.splice(foundIdx, 1);
        } else {
          break;
        }
      }

      if (loop.length >= 3) {
        resultLoops.push(loop);
      }
    }
    // console.log(`Debug: Found ${resultLoops.length} loops. Remaining segments: ${pool.length}`);
    return resultLoops;
  }
}
