/**
 * RegionSplitter - Divide la heightmap in regioni usando i seam paths
 * 
 * Input: heightmap + seam paths (verticali e orizzontali)
 * Output: lista di regioni, ognuna delimitata dai paths
 */
export class RegionSplitter {
  private width: number;  // pixels
  private height: number; // pixels
  private resolution: number;

  constructor(width: number, height: number, resolution: number = 0.5) {
    this.width = width;
    this.height = height;
    this.resolution = resolution;
  }

  /**
   * Divide la heightmap in regioni usando paths verticali e orizzontali
   */
  splitIntoRegions(
    verticalPaths: { x: number, y: number }[][],
    horizontalPaths: { x: number, y: number }[][]
  ): { paths: { x: number, y: number }[][], name: string }[] {
    const regions: { paths: { x: number, y: number }[][], name: string }[] = [];

    const numCols = verticalPaths.length + 1;
    const numRows = horizontalPaths.length + 1;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const boundaryPaths: { x: number, y: number }[][] = [];

        // Bordo sinistro
        if (col > 0) {
          boundaryPaths.push(verticalPaths[col - 1]);
        } else {
          boundaryPaths.push(this.createEdgePath('left'));
        }

        // Bordo destro
        if (col < verticalPaths.length) {
          boundaryPaths.push(verticalPaths[col]);
        } else {
          boundaryPaths.push(this.createEdgePath('right'));
        }

        // Bordo superiore
        if (row > 0) {
          boundaryPaths.push(horizontalPaths[row - 1]);
        } else {
          boundaryPaths.push(this.createEdgePath('top'));
        }

        // Bordo inferiore
        if (row < horizontalPaths.length) {
          boundaryPaths.push(horizontalPaths[row]);
        } else {
          boundaryPaths.push(this.createEdgePath('bottom'));
        }

        const name = `tile_r${row}_c${col}`;
        regions.push({ paths: boundaryPaths, name });
      }
    }

    return regions;
  }

  private createEdgePath(edge: 'left' | 'right' | 'top' | 'bottom'): { x: number, y: number }[] {
    const widthMm = this.width * this.resolution;
    const heightMm = this.height * this.resolution;
    const numPoints = 20;
    const path: { x: number, y: number }[] = [];

    switch (edge) {
      case 'left':
        for (let i = 0; i < numPoints; i++) {
          path.push({ x: 0, y: (heightMm * i) / (numPoints - 1) });
        }
        break;
      case 'right':
        for (let i = 0; i < numPoints; i++) {
          path.push({ x: widthMm, y: (heightMm * i) / (numPoints - 1) });
        }
        break;
      case 'top':
        for (let i = 0; i < numPoints; i++) {
          path.push({ x: (widthMm * i) / (numPoints - 1), y: 0 });
        }
        break;
      case 'bottom':
        for (let i = 0; i < numPoints; i++) {
          path.push({ x: (widthMm * i) / (numPoints - 1), y: heightMm });
        }
        break;
    }

    return path;
  }

  /**
   * Approccio alternativo: crea una maschera usando flood fill con seed point
   * Utilizza Uint8Array (0=false, 1=true) per efficienza memoria
   */
  createRegionMask(
    seedX: number,  // in mm
    seedY: number,  // in mm
    allPaths: { x: number, y: number }[][]
  ): Uint8Array {
    // Inizializza maschera con i confini
    const mask = new Uint8Array(this.width * this.height).fill(0);

    // Disegna tutti i paths come barriere (valore 2 = confine)
    for (const path of allPaths) {
      this.drawPathOnMask(mask, path);
    }

    // Flood fill dal seed point
    const seedPx = Math.round(seedX / this.resolution);
    const seedPy = Math.round(seedY / this.resolution);

    if (seedPx < 0 || seedPx >= this.width || seedPy < 0 || seedPy >= this.height) {
      console.warn(`⚠️ Seed point (${seedX}, ${seedY}) outside bounds`);
      return mask; // Returns boundaries only (basically empty region)
    }

    // BFS flood fill
    // Usiamo la stessa maschera: 0=vuoto, 1=regione, 2=confine
    const result = new Uint8Array(this.width * this.height).fill(0);

    const queue: number[] = [seedPy * this.width + seedPx];
    // Se il seed non è sul confine, partiamo
    if (mask[seedPy * this.width + seedPx] !== 2) {
      result[seedPy * this.width + seedPx] = 1;
    } else {
      // Se il seed e' sfortunatamente su un confine, proviamo a spostarci leggermente
      // Ma per ora lasciamo stare, è un edge case.
      return result;
    }

    const directions = [-1, 1, -this.width, this.width]; // Left, Right, Up, Down

    let head = 0;
    while (head < queue.length) {
      const currIdx = queue[head++];

      const cx = currIdx % this.width;

      // Controlla 4 vicini
      for (const offset of directions) {
        const nextIdx = currIdx + offset;

        // Check bounds X (per evitare wrap-around)
        if (offset === -1 && cx === 0) continue;
        if (offset === 1 && cx === this.width - 1) continue;

        // Check bounds global
        if (nextIdx >= 0 && nextIdx < result.length) {
          // Se non visitato (result==0) e non è confine (mask==2)
          if (result[nextIdx] === 0 && mask[nextIdx] !== 2) {
            result[nextIdx] = 1;
            queue.push(nextIdx);
          }
        }
      }
    }

    return result;
  }

  /**
   * Disegna path sulla maschera
   * Valore 2 = Boundary
   */
  private drawPathOnMask(mask: Uint8Array, path: { x: number, y: number }[]) {
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];

      const x1 = Math.round(p1.x / this.resolution);
      const y1 = Math.round(p1.y / this.resolution);
      const x2 = Math.round(p2.x / this.resolution);
      const y2 = Math.round(p2.y / this.resolution);

      this.drawLine(mask, x1, y1, x2, y2);
    }
  }

  private drawLine(mask: Uint8Array, x1: number, y1: number, x2: number, y2: number) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1;
    let y = y1;

    while (true) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        mask[y * this.width + x] = 2; // 2 = Bound
      }

      if (x === x2 && y === y2) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
}
