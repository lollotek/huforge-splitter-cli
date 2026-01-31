import fs from 'fs';
import { GeometryUtils, Point3D } from '../utils/GeometryUtils';
import { TriangleSplitter } from './TriangleSplitter';

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

    // Start recursive slicing pipeline
    // 1. Slice Vertically
    // 2. Determine Columns
    // 3. For each piece: Slice Horizontally
    // 4. Determine Rows -> Write to File

    this.processVerticalSlices(t, vPaths, 0, hPaths);
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

  private processVerticalSlices(t: Point3D[], vPaths: CutPath[], pathIdx: number, hPaths: CutPath[]) {
    // Base case: No more vertical paths to check -> We are in column [pathIdx]
    if (pathIdx >= vPaths.length) {
      this.processHorizontalSlices(t, hPaths, 0, pathIdx);
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
      this.processHorizontalSlices(t, hPaths, 0, pathIdx);
      return;
    }

    if (minX > bounds.max + 0.1) {
      // Completely Right -> Check next path (Col [pathIdx+1] or further)
      this.processVerticalSlices(t, vPaths, pathIdx + 1, hPaths);
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

    const { left, right } = TriangleSplitter.splitTriangleByLine(t as [Point3D, Point3D, Point3D], p1, p2);

    for (const tri of left) {
      this.processHorizontalSlices(tri, hPaths, 0, pathIdx);
    }
    for (const tri of right) {
      this.processVerticalSlices(tri, vPaths, pathIdx + 1, hPaths);
    }
  }

  private processHorizontalSlices(t: Point3D[], hPaths: CutPath[], pathIdx: number, colIdx: number) {
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
      this.processHorizontalSlices(t, hPaths, pathIdx + 1, colIdx);
      return;
    }

    const { p1, p2 } = this.getBestFitLine(t, path, 'y'); // Horizontal Path -> cuts along X axis (fit Y)

    const { left, right } = TriangleSplitter.splitTriangleByLine(t as [Point3D, Point3D, Point3D], p1, p2);

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
      this.processHorizontalSlices(tri, hPaths, pathIdx + 1, colIdx);
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
