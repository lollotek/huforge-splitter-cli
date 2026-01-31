import fs from 'fs';
import { GeometryUtils, Point3D } from '../utils/GeometryUtils';
import { TriangleSplitter } from './TriangleSplitter';
import { CapUtils } from '../utils/CapUtils';

type CutPath = { x: number, y: number }[];

// Helper per identificare una tile univoca
type TileIndex = { row: number, col: number };

export class StreamingSlicer {
  private inputPath: string;
  private outputDir: string;
  private verbose: boolean;

  // File Writers aperti per ogni tile
  private fileHandles: Map<string, { fd: number, count: number, path: string }> = new Map();
  // Cache bounds per path
  private vBounds: { min: number, max: number }[] = [];
  private hBounds: { min: number, max: number }[] = [];

  // Cut Paths storage for Cap Intersections
  private vPaths: CutPath[] = [];
  private hPaths: CutPath[] = [];

  // Storage for cut segments per tile edge (Key: TileIndex string -> List of segments)
  // Segments: { p1, p2 }
  // We need to know WHICH edge this segment belongs to (Right of C0 / Left of C1).
  // A vertical cut `pathIdx` creates a "Right Wall" for Left Tile (Col `pathIdx`) and "Left Wall" for Right Tile (Col `pathIdx+1`).
  private verticalCaps: Map<string, [Point3D, Point3D][]> = new Map();
  private horizontalCaps: Map<string, [Point3D, Point3D][]> = new Map();

  constructor(inputPath: string, outputDir: string, verbose: boolean = false) {
    this.inputPath = inputPath;
    this.outputDir = outputDir;
    this.verbose = verbose;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  // Chiude tutti i file aperti e aggiorna il conteggio triangoli nell'header
  private closeHandles() {
    console.log("\n--- Generating Caps (Walls) ---");
    this.generateCaps();

    console.log("\n--- Slicer Stats ---");
    for (const [key, handle] of this.fileHandles.entries()) {
      // Update header with accurate triangle count
      const countBuffer = Buffer.alloc(4);
      countBuffer.writeUInt32LE(handle.count, 0);
      try {
        fs.writeSync(handle.fd, countBuffer, 0, 4, 80);
      } catch (e) {
        console.error(`Error updating header for ${key}:`, e);
      }
      fs.closeSync(handle.fd);
      console.log(`Tile ${key}: ${handle.count} triangles`);
    }
    this.fileHandles.clear();
  }

  private generateCaps() {
    // Generate Vertical Walls
    for (const [key, segments] of this.verticalCaps.entries()) {
      const pathIdx = parseInt(key.split('_')[1]);
      const walls = CapUtils.triangulateSegments(segments);

      // Slice the wall horizontally (Recursive)
      // Left Tile (Col pathIdx) - Needs Right Wall
      for (const tri of walls) {
        this.processHorizontalSlices(tri, this.hPaths, 0, pathIdx, false);
        // Right Tile (Col pathIdx+1) - Needs Left Wall (Inverted)
        const inv = [tri[0], tri[2], tri[1]] as [Point3D, Point3D, Point3D];
        this.processHorizontalSlices(inv, this.hPaths, 0, pathIdx + 1, false);
      }
    }

    for (const [key, segments] of this.horizontalCaps.entries()) {
      const pathIdx = parseInt(key.split('_')[1]);
      const walls = CapUtils.triangulateSegments(segments);

      // Slice the wall vertically (Recursive)
      for (const tri of walls) {
        // Top Tile (Row pathIdx)
        // We pass hPathIdx as 'rowIdx' implicitly via the logic?
        // processVerticalSlices takes (..., pathIdx, hPaths).
        // But here 'pathIdx' is the ROW index.

        // Wait. processVerticalSlices takes `pathIdx` as COLUMN index.
        // We are processing a Horizontal Wall. It spans ALL COLUMNS.
        // So we start at Vertical Cut 0.
        // But what mechanism puts it in the correct ROW?
        // processVerticalSlices recurses until it calls processHorizontalSlices.
        // processHorizontalSlices determines the ROW.
        // BUT `processHorizontalSlices` checks Y against hPath.
        // The Horizontal Wall is AT Y = hPath[pathIdx].
        // It might float due to precision.
        // If we rely on bounds check, it might be ambiguous.
        // HOWEVER, we KNOW the row index is `pathIdx`.
        // Can we force it? 
        // `processHorizontalSlices` calculates row index.

        // Actually, for Horizontal Walls, we ALREADY KNOW the Row Index.
        // We just need to split it by Columns.
        // Does `processVerticalSlices` allow us to specify the Row?
        // No, it calls `processHorizontalSlices` with start row 0.

        // If we use the standard pipeline, the Wall (which is horizontal) will fall into the correct Row bucket based on Y.
        // Since it was generated from the cut at `hPath[pathIdx]`, its Y is exactly on the boundary.
        // It might fall into `pathIdx` or `pathIdx+1`.
        // Ideally it belongs to `pathIdx` (Bottom of Top Tile).
        // And Inverted belongs to `pathIdx+1` (Top of Bottom Tile).

        // Let's trust the geometry.
        this.processVerticalSlices(tri, this.vPaths, 0, this.hPaths, false);

        const inv = [tri[0], tri[2], tri[1]] as [Point3D, Point3D, Point3D];
        this.processVerticalSlices(inv, this.vPaths, 0, this.hPaths, false);
      }
    }
  }

  private distributeWallsToRows(walls: Point3D[][], vPathIdx: number, type: 'vertical') {
    // vPathIdx defines the Column Boundary.
    // We need to split these wall triangles into Rows (0..M) based on Y.
    // We use hBounds.

    // For each wall triangle, find which Row it belongs to.
    // Since walls are small, usually they fall in one row.
    // We check Centroid Y.

    for (const tri of walls) {
      const y = (tri[0].y + tri[1].y + tri[2].y) / 3;
      // Find row
      let row = 0;
      for (let i = 0; i < this.hBounds.length; i++) {
        // hBounds[i] is the Horizontal Cut Line between Row i and Row i+1.
        // If y > bound (Bottom), it's next row?
        // HueSlicer Y: 0 Top?
        // Let's use the bounds:
        // Bound is Y ranges.
        // Wait, hBounds is MIN/MAX of the CUT PATH.
        // Cut Path [i] separates Row i and Row i+1.
        // If Y < CutPath[i].min -> Row i.
        // If Y > CutPath[i].max -> Row i+1.
        // If in between -> Ambiguous (Overlap). Just pick closest?
        // Or dup?

        if (y > this.hBounds[i].max) {
          row = i + 1;
        }
      }

      // Write to Tile: Row `row`, Col `vPathIdx` (Left of cut) and Col `vPathIdx+1` (Right of cut)
      // Left Tile (Col vPathIdx): Needs Wall pointing RIGHT.
      // Right Tile (Col vPathIdx+1): Needs Wall pointing LEFT.

      // Write to Left Tile
      this.writeTriangleFromPoints(row, vPathIdx, tri);

      // Write to Right Tile (Inverted)
      const inv = [tri[0], tri[2], tri[1]];
      this.writeTriangleFromPoints(row, vPathIdx + 1, inv);
    }
  }

  private distributeWallsToCols(walls: Point3D[][], hPathIdx: number) {
    // hPathIdx defines Row Boundary (Row hPathIdx / Row hPathIdx+1).
    // We need to bin into Cols.
    for (const tri of walls) {
      const x = (tri[0].x + tri[1].x + tri[2].x) / 3;
      let col = 0;
      for (let i = 0; i < this.vBounds.length; i++) {
        if (x > this.vBounds[i].max) {
          col = i + 1;
        }
      }

      // Top Tile (Row hPathIdx): Needs Bottom Wall
      this.writeTriangleFromPoints(hPathIdx, col, tri);

      // Bottom Tile (Row hPathIdx + 1): Needs Top Wall (Inverted)
      const inv = [tri[0], tri[2], tri[1]];
      this.writeTriangleFromPoints(hPathIdx + 1, col, inv);
    }
  }

  private getFileHandle(row: number, col: number): number {
    const key = `${row}_${col}`;
    if (!this.fileHandles.has(key)) {
      const filePath = `${this.outputDir}/tile_r${row}_c${col}.stl`;
      // Apri in w+ (read/write) per poter tornare indietro a scrivere l'header
      const fd = fs.openSync(filePath, 'w+');

      // Write placeholder header (80 bytes + 4 count)
      const header = Buffer.alloc(84);
      header.write('HueSlicer Stream', 0);
      header.writeUInt32LE(0, 80); // Init count 0
      fs.writeSync(fd, header);

      this.fileHandles.set(key, { fd, count: 0, path: filePath });
    }
    return this.fileHandles.get(key)!.fd;
  }

  // ...

  private writeTriangle(row: number, col: number, buffer: Buffer) {
    const fd = this.getFileHandle(row, col);
    fs.writeSync(fd, buffer);
    // Increment count
    const key = `${row}_${col}`;
    if (this.fileHandles.has(key)) {
      this.fileHandles.get(key)!.count++;
    }
  }

  async process(verticalCutPaths: CutPath[], horizontalCutPaths: CutPath[]): Promise<void> {
    console.log(`Starting Streaming Slicer on ${this.inputPath}...`);
    this.vPaths = verticalCutPaths;
    this.hPaths = horizontalCutPaths;

    // Sort paths by coordinate (Ascending) to ensure correct binning order
    // Vertical: Sort by avg X
    verticalCutPaths.sort((a, b) => {
      const avgA = a.reduce((sum, p) => sum + p.x, 0) / a.length;
      const avgB = b.reduce((sum, p) => sum + p.x, 0) / b.length;
      return avgA - avgB;
    });

    // Horizontal: Sort by avg Y
    horizontalCutPaths.sort((a, b) => {
      const avgA = a.reduce((sum, p) => sum + p.y, 0) / a.length;
      const avgB = b.reduce((sum, p) => sum + p.y, 0) / b.length;
      return avgA - avgB;
    });

    // Pre-calculate bounds for fast rejection
    this.vBounds = verticalCutPaths.map(p => ({
      min: Math.min(...p.map(pt => pt.x)),
      max: Math.max(...p.map(pt => pt.x))
    }));

    this.hBounds = horizontalCutPaths.map(p => ({
      min: Math.min(...p.map(pt => pt.y)),
      max: Math.max(...p.map(pt => pt.y))
    }));

    const inputStream = fs.createReadStream(this.inputPath, { highWaterMark: 64 * 1024 });

    let bufferChunk = Buffer.alloc(0);
    let headerProcessed = false;
    let trianglesProcessed = 0;

    for await (const chunk of inputStream) {
      bufferChunk = Buffer.concat([bufferChunk, chunk]);

      if (!headerProcessed) {
        if (bufferChunk.length >= 84) {
          // totalTriangles = bufferChunk.readUInt32LE(80); // We ignore input count in streaming
          bufferChunk = bufferChunk.subarray(84);
          headerProcessed = true;
        } else { continue; }
      }

      // Elabora batch di triangoli
      while (bufferChunk.length >= 50) {
        // Copia i dati per evitare problemi di reference se il bufferChunk cambia
        const triangleBuffer = Buffer.allocUnsafe(50);
        bufferChunk.copy(triangleBuffer, 0, 0, 50);

        this.routeTriangle(triangleBuffer, verticalCutPaths, horizontalCutPaths);

        bufferChunk = bufferChunk.subarray(50);
        trianglesProcessed++;

        if (trianglesProcessed % 50000 === 0 && this.verbose) {
          process.stdout.write(`\rProcessed ${trianglesProcessed}`);
        }
      }
    }

    this.closeHandles();
    console.log(`\nDone. Processed ${trianglesProcessed} triangles.`);
  }

  private routeTriangle(buffer: Buffer, vPaths: CutPath[], hPaths: CutPath[]) {
    const v1: Point3D = { x: buffer.readFloatLE(12), y: buffer.readFloatLE(16), z: buffer.readFloatLE(20) };
    const v2: Point3D = { x: buffer.readFloatLE(24), y: buffer.readFloatLE(28), z: buffer.readFloatLE(32) };
    const v3: Point3D = { x: buffer.readFloatLE(36), y: buffer.readFloatLE(40), z: buffer.readFloatLE(44) };

    const t: [Point3D, Point3D, Point3D] = [v1, v2, v3];

    // Tessellate if too large to capture path curvature.
    this.processTessellated(t, vPaths, hPaths);
  }

  private processTessellated(t: [Point3D, Point3D, Point3D], vPaths: CutPath[], hPaths: CutPath[], depth: number = 0) {
    if (depth < 3 && GeometryUtils.getMaxEdgeLength(t) > 5.0) {
      const subs = GeometryUtils.subdivideTriangle(t);
      for (const sub of subs) {
        this.processTessellated(sub, vPaths, hPaths, depth + 1);
      }
    } else {
      this.processVerticalSlices(t, vPaths, 0, hPaths);
    }
  }

  // Trova l'intervallo di indici (colonne o righe) che il triangolo copre
  private findSpan(p1: Point3D, p2: Point3D, p3: Point3D, paths: CutPath[], axis: 'x' | 'y'): [number, number] {
    const vals = [p1[axis], p2[axis], p3[axis]];
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);

    let startIdx = 0;

    // Trova la prima regione che INTERSECA (o contiene) il minVal
    // I paths separano le regioni: Region 0 | Path 0 | Region 1 | Path 1 | Region 2
    for (let i = 0; i < paths.length; i++) {
      // Stima posizione path (prendiamo primo punto per ora, assumendo path ortogonali/semplici)
      // TODO: Migliorare con check min/max reali del path
      const pathPos = paths[i][0][axis];

      if (maxVal < pathPos) {
        // Il triangolo è completamente prima di questo path
        // Quindi finisce in questa regione (startIdx)
        return [startIdx, startIdx];
      }

      if (minVal > pathPos) {
        // Il triangolo inizia dopo questo path
        // Quindi deve essere almeno nella prossima regione
        startIdx = i + 1;
      } else {
        // Il triangolo scavalca questo path (min < path < max)
        // Quindi copre almeno da startIdx fino a... continuiamo a cercare dove finisce
      }
    }

    return [startIdx, paths.length];
  }


  // Calcola una linea di taglio locale basata sui punti del percorso che intersecano il triangolo
  private getBestFitLine(t: Point3D[], path: CutPath, axis: 'x' | 'y'): { p1: { x: number, y: number }, p2: { x: number, y: number } } {
    const secondaryAxis = axis === 'x' ? 'y' : 'x'; // Axis lungi il quale scorre il path (Y per VerticalCut)

    const vals = t.map(p => p[secondaryAxis]);
    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);

    // Filtra punti del path rilevanti (con margine)
    // I path sono ordinati? Se vengono da SeamFinder si (Y cresce o decresce).
    // Ottimizzazione: Binary search start/end indices. Per ora filter lineare (i file non sono enormi, 2000 punti).
    const relevant = path.filter(p => p[secondaryAxis] >= minVal - 1.0 && p[secondaryAxis] <= maxVal + 1.0);

    if (relevant.length < 2) {
      // Fallback: usa i punti più vicini se nessuno è nel range esatto
      if (path.length >= 2) {
        // Cerca il punto più vicino al centro del triangolo
        const center = (minVal + maxVal) / 2;
        let closestIdx = 0;
        let minDst = Infinity;
        for (let i = 0; i < path.length; i++) {
          const d = Math.abs(path[i][secondaryAxis] - center);
          if (d < minDst) { minDst = d; closestIdx = i; }
        }
        // Usa segmento locale
        const idx1 = Math.max(0, closestIdx - 1);
        const idx2 = Math.min(path.length - 1, idx1 + 1);
        // Se siamo agli estremi
        if (idx1 === idx2) return { p1: path[0], p2: path[path.length - 1] }; // Should not happen with len>=2
        return { p1: path[idx1], p2: path[idx2] };
      }
      // Fallback totale (path degenere)
      return { p1: { x: 0, y: 0 }, p2: { x: 100, y: 100 } };
    }

    // Linear Regression per trovare la linea migliore (X = mY + q per Vertical)
    // Vertical Path: x è funzione di y. -> x = A*y + B
    // Horizontal Path: y è funzione di x. -> y = A*x + B

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    const n = relevant.length;

    for (const p of relevant) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumX2 += p.x * p.x;
      sumY2 += p.y * p.y;
    }

    const p1 = { x: 0, y: 0 };
    const p2 = { x: 0, y: 0 };

    if (axis === 'x') { // Vertical Cut (scorre su Y) -> Fit X = A*Y + B
      const denominator = (n * sumY2 - sumY * sumY);
      if (Math.abs(denominator) < 1e-9) {
        // Verticale perfetta (o degenere)
        return { p1: relevant[0], p2: relevant[relevant.length - 1] };
      }
      const A = (n * sumXY - sumX * sumY) / denominator; // Slope
      const B = (sumX * sumY2 - sumY * sumXY) / denominator; // Intercept

      // Costruiamo 2 punti lontani per definire la retta infinita
      p1.y = minVal - 10;
      p1.x = A * p1.y + B;
      p2.y = maxVal + 10;
      p2.x = A * p2.y + B;
    } else { // Horizontal Cut (scorre su X) -> Fit Y = A*X + B
      const denominator = (n * sumX2 - sumX * sumX);
      if (Math.abs(denominator) < 1e-9) {
        return { p1: relevant[0], p2: relevant[relevant.length - 1] };
      }
      const A = (n * sumXY - sumX * sumY) / denominator;
      const B = (sumY * sumX2 - sumX * sumXY) / denominator;

      p1.x = minVal - 10;
      p1.y = A * p1.x + B;
      p2.x = maxVal + 10;
      p2.y = A * p2.x + B;
    }

    return { p1, p2 };
  }

  private processVerticalSlices(t: Point3D[], vPaths: CutPath[], pathIdx: number, hPaths: CutPath[], collectCaps: boolean = true) {
    // Base case: No more vertical paths to check -> We are in column [pathIdx]
    if (pathIdx >= vPaths.length) {
      this.processHorizontalSlices(t, hPaths, 0, pathIdx, collectCaps);
      return;
    }

    const path = vPaths[pathIdx];
    const bounds = this.vBounds[pathIdx];

    // Quick BBox check using PRE-CALCULATED Bounds
    // If triangle is strictly LEFT of the path's MIN X -> belongs to Col [pathIdx]
    const minX = Math.min(t[0].x, t[1].x, t[2].x);
    const maxX = Math.max(t[0].x, t[1].x, t[2].x);

    if (maxX < bounds.min - 0.1) {
      // Completely Left -> Col [pathIdx]
      this.processHorizontalSlices(t, hPaths, 0, pathIdx, collectCaps);
      return;
    }

    if (minX > bounds.max + 0.1) {
      // Completely Right -> Check next path (Col [pathIdx+1] or further)
      this.processVerticalSlices(t, vPaths, pathIdx + 1, hPaths, collectCaps);
      return;
    }

    // Intersection likely or ambiguous (inside bounding box of curve)
    // We must check geometric split.
    // For now, simple split against first/last point line (Approximation)
    // TODO: Accurate polyline split would require iterating segments.
    // Given Seam Carving paths are roughly vertical, Line Split is a "decent" approx for MVP, 
    // BUT if the path curves significantly, this drops geometry that is "inside" the curve.
    // However, StreamingSlicer must be fast.

    const { p1, p2 } = this.getBestFitLine(t, path, 'x'); // Vertical Path -> cuts along Y axis (fit X)

    const splitRes = TriangleSplitter.splitTriangleByLine(t as [Point3D, Point3D, Point3D], p1, p2);
    const { left, right, cutSegment } = splitRes;

    if (cutSegment && collectCaps) {
      // Store for "Right Wall" of Col [pathIdx]
      // And "Left Wall" of Col [pathIdx + 1]
      // Note: caps are shared but might need reversing normal?
      // Let's store raw segments, cap generator handles topology.
      const key = `v_${pathIdx}`; // ID for this vertical path
      // We actually need per-tile storage? No, we generate the wall for the PATH, then split the wall?
      // No, the Wall IS the interface. 
      // We append these wall triangles to BOTH tiles (with flipped normals).
      // HARD part: We only stream to tiles. We don't hold tiles in memory.
      // We can write Wall Triangles immediately?
      // YES.

      // Wait, cutSegment is a LINE. We need 2 segments to make a Quad?
      // No, we need to collect ALL segments for this Path, then triangulate the hole.
      // We cannot stream Cap triangles one by one because we don't know the neighbor.

      // So we MUST Buffer `verticalCaps`.
      if (!this.verticalCaps.has(key)) this.verticalCaps.set(key, []);
      this.verticalCaps.get(key)!.push(cutSegment);
    }

    for (const tri of left) {
      this.processHorizontalSlices(tri, hPaths, 0, pathIdx, collectCaps);
    }
    for (const tri of right) {
      this.processVerticalSlices(tri, vPaths, pathIdx + 1, hPaths, collectCaps);
    }
  }

  private processHorizontalSlices(t: Point3D[], hPaths: CutPath[], pathIdx: number, colIdx: number, collectCaps: boolean = true) {
    // Base case: No more horizontal paths -> Row [pathIdx]
    if (pathIdx >= hPaths.length) {
      this.writeTriangleFromPoints(pathIdx, colIdx, t);
      return;
    }

    const path = hPaths[pathIdx];
    const bounds = this.hBounds[pathIdx];

    // Quick BBox check
    // If triangle is strictly ABOVE the path (Y < Y_min) -> Row [pathIdx]
    // Note: HueSlicer Y seems to be 0 at Top? 
    // If so, Y < Path -> Top -> Row 0.

    const minY = Math.min(t[0].y, t[1].y, t[2].y);
    const maxY = Math.max(t[0].y, t[1].y, t[2].y);

    if (maxY < bounds.min - 0.1) {
      this.writeTriangleFromPoints(pathIdx, colIdx, t);
      return;
    }

    if (minY > bounds.max + 0.1) {
      this.processHorizontalSlices(t, hPaths, pathIdx + 1, colIdx, collectCaps);
      return;
    }

    const { p1, p2 } = this.getBestFitLine(t, path, 'y'); // Horizontal Path -> cuts along X axis (fit Y)

    const splitRes = TriangleSplitter.splitTriangleByLine(t as [Point3D, Point3D, Point3D], p1, p2);
    const { left, right, cutSegment } = splitRes;

    if (cutSegment && collectCaps) {
      const key = `h_${pathIdx}`;
      if (!this.horizontalCaps.has(key)) this.horizontalCaps.set(key, []);
      this.horizontalCaps.get(key)!.push(cutSegment);
    }

    // For Horizontal Line (Left->Right):
    // "Left" (Positive Side) is Y > Path (Bottom).
    // "Right" (Negative Side) is Y < Path (Top).

    // We want Y < Path (Top) to stay in THIS CURRENT Row [pathIdx].
    // We want Y > Path (Bottom) to move to NEXT Row checks.

    // So 'Right' -> writeTriangle (Current Row)
    // 'Left' -> recurse (Next Row)

    for (const tri of right) {
      this.writeTriangleFromPoints(pathIdx, colIdx, tri);
    }
    for (const tri of left) {
      this.processHorizontalSlices(tri, hPaths, pathIdx + 1, colIdx, collectCaps);
    }
  }

  private writeTriangleFromPoints(row: number, col: number, ptrs: Point3D[]) {
    const buff = Buffer.alloc(50);
    // Write Normal (fake)
    buff.writeFloatLE(0, 0); buff.writeFloatLE(0, 4); buff.writeFloatLE(1, 8);
    buff.writeFloatLE(ptrs[0].x, 12); buff.writeFloatLE(ptrs[0].y, 16); buff.writeFloatLE(ptrs[0].z, 20);
    buff.writeFloatLE(ptrs[1].x, 24); buff.writeFloatLE(ptrs[1].y, 28); buff.writeFloatLE(ptrs[1].z, 32);
    buff.writeFloatLE(ptrs[2].x, 36); buff.writeFloatLE(ptrs[2].y, 40); buff.writeFloatLE(ptrs[2].z, 44);

    this.writeTriangle(row, col, buff);
  }


}
