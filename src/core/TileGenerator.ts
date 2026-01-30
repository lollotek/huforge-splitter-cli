import fs from 'fs';

/**
 * TileGenerator - Genera mesh STL da regioni di heightmap
 * 
 * Approccio alternativo che evita operazioni booleane manifold-3d:
 * 1. Usa seam paths per creare maschere 2D
 * 2. Applica maschere per estrarre sotto-regioni della heightmap
 * 3. Genera mesh STL triangolando la griglia
 */
export class TileGenerator {
  private heightMap: number[][];
  private width: number;  // pixels
  private height: number; // pixels
  private resolution: number; // mm per pixel
  private verbose: boolean;

  constructor(
    heightMap: number[][],
    width: number,
    height: number,
    resolution: number = 0.5,
    verbose: boolean = false
  ) {
    this.heightMap = heightMap;
    this.width = width;
    this.height = height;
    this.resolution = resolution;
    this.verbose = verbose;
  }

  /**
   * Genera tiles da una lista di regioni definite da paths
   * @param regions Array di regioni, ogni regione è un array di paths che la delimitano
   * @returns Array di bufferSTL per ogni tile
   */
  async generateTiles(
    regions: { paths: { x: number, y: number }[][], name: string }[]
  ): Promise<{ name: string, stlBuffer: Buffer }[]> {
    const results: { name: string, stlBuffer: Buffer }[] = [];

    for (const region of regions) {
      if (this.verbose) console.log(`🔧 Generando tile: ${region.name}`);

      // 1. Crea maschera dalla regione
      const mask = this.createMaskFromPaths(region.paths);

      // 2. Estrai griglia con la maschera
      const tileGrid = this.extractTileGrid(mask);

      // 3. Genera mesh STL
      const stlBuffer = this.gridToSTL(tileGrid.grid, tileGrid.offsetX, tileGrid.offsetY);

      results.push({ name: region.name, stlBuffer });
    }

    return results;
  }

  /**
   * Crea una maschera binaria dalla lista di paths che delimitano una regione
   * I paths formano il confine, il flood fill determina l'interno
   */
  createMaskFromPaths(paths: { x: number, y: number }[][]): boolean[][] {
    // Inizializza maschera vuota
    const mask: boolean[][] = Array(this.height)
      .fill(null)
      .map(() => Array(this.width).fill(false));

    // Disegna tutti i paths come confini (true = confine)
    for (const path of paths) {
      this.drawPathOnMask(mask, path);
    }

    // Flood fill dall'angolo per trovare l'esterno
    // Assumiamo che l'angolo (0,0) sia sempre "esterno"
    const visited = this.floodFill(mask, 0, 0);

    // Inverti: tutto ciò che NON è stato visitato dal flood fill è interno alla regione
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // Se non visitato dal flood fill esterno E non è un confine, è interno
        mask[y][x] = !visited[y][x];
      }
    }

    return mask;
  }

  /**
   * Disegna un path sulla maschera usando Bresenham
   */
  private drawPathOnMask(mask: boolean[][], path: { x: number, y: number }[]) {
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];

      // Converti da mm a pixel
      const x1 = Math.round(p1.x / this.resolution);
      const y1 = Math.round(p1.y / this.resolution);
      const x2 = Math.round(p2.x / this.resolution);
      const y2 = Math.round(p2.y / this.resolution);

      this.drawLine(mask, x1, y1, x2, y2);
    }
  }

  /**
   * Bresenham line algorithm
   */
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

  /**
   * Flood fill BFS per trovare regione connessa
   */
  private floodFill(mask: boolean[][], startX: number, startY: number): boolean[][] {
    const visited: boolean[][] = Array(this.height)
      .fill(null)
      .map(() => Array(this.width).fill(false));

    const queue: [number, number][] = [[startX, startY]];
    visited[startY][startX] = true;

    const directions = [[0, 1], [1, 0], [0, -1], [-1, 0]];

    while (queue.length > 0) {
      const [x, y] = queue.shift()!;

      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;

        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          // Se non visitato e non è un confine
          if (!visited[ny][nx] && !mask[ny][nx]) {
            visited[ny][nx] = true;
            queue.push([nx, ny]);
          }
        }
      }
    }

    return visited;
  }

  /**
   * Estrae sotto-griglia basata sulla maschera
   * Ritorna solo la bounding box della regione mascherata
   */
  extractTileGrid(mask: boolean[][]): {
    grid: (number | null)[][],
    offsetX: number,
    offsetY: number,
    width: number,
    height: number
  } {
    // Trova bounding box della maschera
    let minX = this.width, maxX = 0;
    let minY = this.height, maxY = 0;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (mask[y][x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const tileW = maxX - minX + 1;
    const tileH = maxY - minY + 1;

    if (this.verbose) {
      console.log(`   Tile bounds: [${minX},${minY}] to [${maxX},${maxY}] (${tileW}x${tileH} px)`);
    }

    // Estrai sotto-griglia con null per pixel fuori maschera
    const grid: (number | null)[][] = [];
    for (let y = minY; y <= maxY; y++) {
      const row: (number | null)[] = [];
      for (let x = minX; x <= maxX; x++) {
        if (mask[y][x]) {
          row.push(this.heightMap[y][x]);
        } else {
          row.push(null); // Fuori dalla regione
        }
      }
      grid.push(row);
    }

    return {
      grid,
      offsetX: minX,
      offsetY: minY,
      width: tileW,
      height: tileH
    };
  }

  /**
   * Genera STL binary da una griglia heightmap
   * Crea mesh watertight con top, bottom e pareti laterali
   */
  gridToSTL(
    grid: (number | null)[][],
    offsetX: number,
    offsetY: number
  ): Buffer {
    const triangles: number[][] = [];
    const h = grid.length;
    const w = grid[0].length;

    // 1. Top surface: quad per ogni cella valida
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        // Prendi i 4 corner
        const z00 = grid[y][x];
        const z10 = grid[y][x + 1];
        const z01 = grid[y + 1][x];
        const z11 = grid[y + 1][x + 1];

        // Se almeno uno è null, skip
        if (z00 === null || z10 === null || z01 === null || z11 === null) {
          continue;
        }

        // Coordinate mondo (mm)
        const wx0 = (offsetX + x) * this.resolution;
        const wx1 = (offsetX + x + 1) * this.resolution;
        const wy0 = (offsetY + y) * this.resolution;
        const wy1 = (offsetY + y + 1) * this.resolution;

        // Triangle 1: (0,0) - (1,0) - (0,1)
        triangles.push([
          wx0, wy0, z00,
          wx1, wy0, z10,
          wx0, wy1, z01
        ]);

        // Triangle 2: (1,0) - (1,1) - (0,1)
        triangles.push([
          wx1, wy0, z10,
          wx1, wy1, z11,
          wx0, wy1, z01
        ]);
      }
    }

    // 2. Bottom surface (Z = 0)
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        if (grid[y][x] === null || grid[y][x + 1] === null ||
          grid[y + 1][x] === null || grid[y + 1][x + 1] === null) {
          continue;
        }

        const wx0 = (offsetX + x) * this.resolution;
        const wx1 = (offsetX + x + 1) * this.resolution;
        const wy0 = (offsetY + y) * this.resolution;
        const wy1 = (offsetY + y + 1) * this.resolution;

        // Triangoli invertiti (normale verso -Z)
        triangles.push([
          wx0, wy0, 0,
          wx0, wy1, 0,
          wx1, wy0, 0
        ]);
        triangles.push([
          wx1, wy0, 0,
          wx0, wy1, 0,
          wx1, wy1, 0
        ]);
      }
    }

    // 3. Side walls dove c'è un bordo (transizione null <-> valore)
    this.addSideWalls(triangles, grid, offsetX, offsetY);

    // Convert to binary STL
    return this.trianglesToSTL(triangles);
  }

  /**
   * Aggiunge pareti laterali dove la maschera ha bordi
   */
  private addSideWalls(
    triangles: number[][],
    grid: (number | null)[][],
    offsetX: number,
    offsetY: number
  ) {
    const h = grid.length;
    const w = grid[0].length;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const z = grid[y][x];
        if (z === null) continue;

        const wx = (offsetX + x) * this.resolution;
        const wy = (offsetY + y) * this.resolution;
        const res = this.resolution;

        // Check each neighbor, add wall if neighbor is null or edge
        // Left edge (x-1 is null or out of bounds)
        if (x === 0 || grid[y][x - 1] === null) {
          this.addWallQuad(triangles, wx, wy, wx, wy + res, 0, z);
        }
        // Right edge
        if (x === w - 1 || grid[y][x + 1] === null) {
          this.addWallQuad(triangles, wx + res, wy + res, wx + res, wy, 0, z);
        }
        // Top edge (y-1)
        if (y === 0 || grid[y - 1][x] === null) {
          this.addWallQuad(triangles, wx + res, wy, wx, wy, 0, z);
        }
        // Bottom edge (y+1)
        if (y === h - 1 || grid[y + 1][x] === null) {
          this.addWallQuad(triangles, wx, wy + res, wx + res, wy + res, 0, z);
        }
      }
    }
  }

  /**
   * Aggiunge un quad verticale (parete) tra due punti
   */
  private addWallQuad(
    triangles: number[][],
    x1: number, y1: number,
    x2: number, y2: number,
    zBottom: number, zTop: number
  ) {
    // Triangle 1
    triangles.push([
      x1, y1, zBottom,
      x2, y2, zBottom,
      x1, y1, zTop
    ]);
    // Triangle 2
    triangles.push([
      x2, y2, zBottom,
      x2, y2, zTop,
      x1, y1, zTop
    ]);
  }

  /**
   * Converte array di triangoli in buffer STL binario
   */
  private trianglesToSTL(triangles: number[][]): Buffer {
    const headerSize = 80;
    const triangleCountSize = 4;
    const triangleSize = 50; // 12 (normal) + 36 (3 vertices) + 2 (attr)

    const bufferSize = headerSize + triangleCountSize + triangles.length * triangleSize;
    const buffer = Buffer.alloc(bufferSize);

    // Header (80 bytes, can be anything)
    buffer.write('HueSlicer TileGenerator', 0);

    // Triangle count
    buffer.writeUInt32LE(triangles.length, 80);

    // Triangles
    let offset = 84;
    for (const tri of triangles) {
      // Calculate normal (cross product)
      const v1 = [tri[3] - tri[0], tri[4] - tri[1], tri[5] - tri[2]];
      const v2 = [tri[6] - tri[0], tri[7] - tri[1], tri[8] - tri[2]];
      const normal = [
        v1[1] * v2[2] - v1[2] * v2[1],
        v1[2] * v2[0] - v1[0] * v2[2],
        v1[0] * v2[1] - v1[1] * v2[0]
      ];
      // Normalize
      const len = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
      if (len > 0) {
        normal[0] /= len;
        normal[1] /= len;
        normal[2] /= len;
      }

      // Write normal
      buffer.writeFloatLE(normal[0], offset);
      buffer.writeFloatLE(normal[1], offset + 4);
      buffer.writeFloatLE(normal[2], offset + 8);
      offset += 12;

      // Write vertices
      for (let i = 0; i < 9; i++) {
        buffer.writeFloatLE(tri[i], offset);
        offset += 4;
      }

      // Attribute byte count (0)
      buffer.writeUInt16LE(0, offset);
      offset += 2;
    }

    return buffer;
  }

  /**
   * Salva buffer STL su disco
   */
  saveSTL(buffer: Buffer, filePath: string) {
    fs.writeFileSync(filePath, buffer);
    console.log(`💾 Saved: ${filePath}`);
  }
}
