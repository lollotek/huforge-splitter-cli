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
   * 
   * @param verticalPaths Array di paths verticali (in mm) ordinati da sinistra a destra
   * @param horizontalPaths Array di paths orizzontali (in mm) ordinati dall'alto al basso
   * @returns Array di regioni, ognuna con i paths che la delimitano e un nome
   */
  splitIntoRegions(
    verticalPaths: { x: number, y: number }[][],
    horizontalPaths: { x: number, y: number }[][]
  ): { paths: { x: number, y: number }[][], name: string }[] {
    const regions: { paths: { x: number, y: number }[][], name: string }[] = [];

    // Calcola i "column boundaries" dai paths verticali
    // Ogni path verticale divide in left/right
    const numCols = verticalPaths.length + 1;
    const numRows = horizontalPaths.length + 1;

    // Per ogni cella della griglia, determina i paths che la delimitano
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const boundaryPaths: { x: number, y: number }[][] = [];

        // Bordo sinistro
        if (col > 0) {
          boundaryPaths.push(verticalPaths[col - 1]);
        } else {
          // Bordo sinistro del modello
          boundaryPaths.push(this.createEdgePath('left'));
        }

        // Bordo destro
        if (col < verticalPaths.length) {
          boundaryPaths.push(verticalPaths[col]);
        } else {
          // Bordo destro del modello
          boundaryPaths.push(this.createEdgePath('right'));
        }

        // Bordo superiore
        if (row > 0) {
          boundaryPaths.push(horizontalPaths[row - 1]);
        } else {
          // Bordo superiore del modello
          boundaryPaths.push(this.createEdgePath('top'));
        }

        // Bordo inferiore
        if (row < horizontalPaths.length) {
          boundaryPaths.push(horizontalPaths[row]);
        } else {
          // Bordo inferiore del modello
          boundaryPaths.push(this.createEdgePath('bottom'));
        }

        // Nome della regione (es: "tile_0_1" per riga 0, colonna 1)
        const name = `tile_r${row}_c${col}`;

        regions.push({ paths: boundaryPaths, name });
      }
    }

    return regions;
  }

  /**
   * Crea un path rettilineo per i bordi del modello
   */
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
   * Invece di usare i paths come confini, piazza un seed point in ogni regione
   * e fa flood fill fino ai confini
   */
  createRegionMask(
    seedX: number,  // in mm
    seedY: number,  // in mm
    allPaths: { x: number, y: number }[][]
  ): boolean[][] {
    // Inizializza maschera con i confini
    const mask: boolean[][] = Array(this.height)
      .fill(null)
      .map(() => Array(this.width).fill(false));

    // Disegna tutti i paths come barriere
    for (const path of allPaths) {
      this.drawPathOnMask(mask, path);
    }

    // Flood fill dal seed point
    const seedPx = Math.round(seedX / this.resolution);
    const seedPy = Math.round(seedY / this.resolution);

    if (seedPx < 0 || seedPx >= this.width || seedPy < 0 || seedPy >= this.height) {
      console.warn(`⚠️ Seed point (${seedX}, ${seedY}) outside bounds`);
      return mask;
    }

    // BFS flood fill
    const result: boolean[][] = Array(this.height)
      .fill(null)
      .map(() => Array(this.width).fill(false));

    const queue: [number, number][] = [[seedPx, seedPy]];
    result[seedPy][seedPx] = true;

    const directions = [[0, 1], [1, 0], [0, -1], [-1, 0]];

    while (queue.length > 0) {
      const [x, y] = queue.shift()!;

      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;

        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          // Se non già nella regione e non è un confine
          if (!result[ny][nx] && !mask[ny][nx]) {
            result[ny][nx] = true;
            queue.push([nx, ny]);
          }
        }
      }
    }

    return result;
  }

  /**
   * Disegna path sulla maschera usando Bresenham
   */
  private drawPathOnMask(mask: boolean[][], path: { x: number, y: number }[]) {
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

  private drawLine(mask: boolean[][], x1: number, y1: number, x2: number, y2: number) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1;
    let y = y1;

    while (true) {
      if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
        mask[y][x] = true;
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
