import fs from 'fs';

/**
 * TileGenerator - Genera mesh STL da regioni di heightmap
 */
export class TileGenerator {
  private heightMap: Float32Array;
  private width: number;  // pixels
  private height: number; // pixels
  private resolution: number; // mm per pixel
  private verbose: boolean;

  constructor(
    heightMap: Float32Array,
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
   * Estrae sotto-griglia basata sulla maschera (Flattened)
   * @param mask Uint8Array (1 = included region)
   */
  extractTileGrid(mask: Uint8Array): {
    grid: Float32Array,
    offsetX: number,
    offsetY: number,
    width: number,
    height: number,
    validMap: Uint8Array // 1 if valid, 0 if null/void
  } {
    // Trova bounding box della maschera
    let minX = this.width, maxX = 0;
    let minY = this.height, maxY = 0;
    let hasPoints = false;

    // Fast scan
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) { // 1 = Region
        const x = i % this.width;
        const y = Math.floor(i / this.width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        hasPoints = true;
      }
    }

    if (!hasPoints) {
      return { grid: new Float32Array(0), offsetX: 0, offsetY: 0, width: 0, height: 0, validMap: new Uint8Array(0) };
    }

    const tileW = maxX - minX + 1;
    const tileH = maxY - minY + 1;

    if (this.verbose) {
      console.log(`   Tile bounds: [${minX},${minY}] to [${maxX},${maxY}] (${tileW}x${tileH} px)`);
    }

    // Extract subgrid
    const grid = new Float32Array(tileW * tileH);
    const validMap = new Uint8Array(tileW * tileH);

    for (let y = 0; y < tileH; y++) {
      const globalY = minY + y;
      const globalRowOffset = globalY * this.width;
      const localRowOffset = y * tileW;

      for (let x = 0; x < tileW; x++) {
        const globalX = minX + x;
        const globalIdx = globalRowOffset + globalX;

        if (mask[globalIdx] === 1) {
          grid[localRowOffset + x] = this.heightMap[globalIdx];
          validMap[localRowOffset + x] = 1;
        } else {
          grid[localRowOffset + x] = 0;
          validMap[localRowOffset + x] = 0;
        }
      }
    }

    return {
      grid,
      offsetX: minX,
      offsetY: minY,
      width: tileW,
      height: tileH,
      validMap
    };
  }

  // New method for Flat arrays with 2-pass logic
  gridToSTL_Flat(
    grid: Float32Array,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    validMap: Uint8Array
  ): Buffer {
    // PASS 1: Count Triangles
    let triangleCount = 0;

    // 1. Top & Bottom surfaces
    for (let y = 0; y < height - 1; y++) {
      const rowOff = y * width;
      const nextRowOff = (y + 1) * width;
      for (let x = 0; x < width - 1; x++) {
        // Quad check
        const i00 = rowOff + x;
        const i10 = rowOff + x + 1;
        const i01 = nextRowOff + x;
        const i11 = nextRowOff + x + 1;

        if (validMap[i00] !== 0 && validMap[i10] !== 0 && validMap[i01] !== 0 && validMap[i11] !== 0) {
          triangleCount += 4; // 2 for top, 2 for bottom
        }
      }
    }

    // 2. Side walls
    triangleCount += this.countSideWallTriangles(validMap, width, height);

    // Alloc result
    const coords = new Float32Array(triangleCount * 9);
    let cursor = 0;

    // PASS 2: Write Triangles
    for (let y = 0; y < height - 1; y++) {
      const rowOff = y * width;
      const nextRowOff = (y + 1) * width;

      for (let x = 0; x < width - 1; x++) {
        const i00 = rowOff + x;
        const i10 = rowOff + x + 1;
        const i01 = nextRowOff + x;
        const i11 = nextRowOff + x + 1;

        if (validMap[i00] === 0 || validMap[i10] === 0 || validMap[i01] === 0 || validMap[i11] === 0) continue;

        const z00 = grid[i00];
        const z10 = grid[i10];
        const z01 = grid[i01];
        const z11 = grid[i11];

        const wx0 = (offsetX + x) * this.resolution;
        const wx1 = (offsetX + x + 1) * this.resolution;
        const wy0 = (offsetY + y) * this.resolution;
        const wy1 = (offsetY + y + 1) * this.resolution;

        // Top T1
        coords[cursor++] = wx0; coords[cursor++] = wy0; coords[cursor++] = z00;
        coords[cursor++] = wx1; coords[cursor++] = wy0; coords[cursor++] = z10;
        coords[cursor++] = wx0; coords[cursor++] = wy1; coords[cursor++] = z01;
        // Top T2
        coords[cursor++] = wx1; coords[cursor++] = wy0; coords[cursor++] = z10;
        coords[cursor++] = wx1; coords[cursor++] = wy1; coords[cursor++] = z11;
        coords[cursor++] = wx0; coords[cursor++] = wy1; coords[cursor++] = z01;

        // Bottom T1 (inverted)
        coords[cursor++] = wx0; coords[cursor++] = wy0; coords[cursor++] = 0;
        coords[cursor++] = wx0; coords[cursor++] = wy1; coords[cursor++] = 0;
        coords[cursor++] = wx1; coords[cursor++] = wy0; coords[cursor++] = 0;
        // Bottom T2
        coords[cursor++] = wx1; coords[cursor++] = wy0; coords[cursor++] = 0;
        coords[cursor++] = wx0; coords[cursor++] = wy1; coords[cursor++] = 0;
        coords[cursor++] = wx1; coords[cursor++] = wy1; coords[cursor++] = 0;
      }
    }

    // Side walls write
    this.writeSideWalls(coords, cursor, grid, validMap, width, height, offsetX, offsetY);

    return this.trianglesToSTL_Buffer(coords);
  }

  private countSideWallTriangles(validMap: Uint8Array, w: number, h: number): number {
    let count = 0;
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const idx = rowOff + x;
        if (validMap[idx] === 0) continue;

        // Left
        if (x === 0 || validMap[idx - 1] === 0) count += 2;
        // Right
        if (x === w - 1 || validMap[idx + 1] === 0) count += 2;
        // Top
        if (y === 0 || validMap[(y - 1) * w + x] === 0) count += 2;
        // Bottom
        if (y === h - 1 || validMap[(y + 1) * w + x] === 0) count += 2;
      }
    }
    return count;
  }

  private writeSideWalls(
    coords: Float32Array,
    startCursor: number,
    grid: Float32Array,
    validMap: Uint8Array,
    w: number, h: number,
    offsetX: number, offsetY: number
  ) {
    let cursor = startCursor;
    const res = this.resolution;

    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const idx = rowOff + x;
        if (validMap[idx] === 0) continue;

        const z = grid[idx];
        const wx = (offsetX + x) * res;
        const wy = (offsetY + y) * res;

        // Left (x-1)
        if (x === 0 || validMap[idx - 1] === 0) {
          cursor = this.addWallQuad(coords, cursor, wx, wy, wx, wy + res, 0, z);
        }
        // Right (x+1)
        if (x === w - 1 || validMap[idx + 1] === 0) {
          cursor = this.addWallQuad(coords, cursor, wx + res, wy + res, wx + res, wy, 0, z);
        }
        // Top (y-1) -> prev row
        if (y === 0 || validMap[(y - 1) * w + x] === 0) {
          cursor = this.addWallQuad(coords, cursor, wx + res, wy, wx, wy, 0, z);
        }
        // Bottom (y+1) -> next row
        if (y === h - 1 || validMap[(y + 1) * w + x] === 0) {
          cursor = this.addWallQuad(coords, cursor, wx, wy + res, wx + res, wy + res, 0, z);
        }
      }
    }
  }

  private addWallQuad(coords: Float32Array, c: number, x1: number, y1: number, x2: number, y2: number, z1: number, z2: number): number {
    coords[c++] = x1; coords[c++] = y1; coords[c++] = z1;
    coords[c++] = x2; coords[c++] = y2; coords[c++] = z1;
    coords[c++] = x1; coords[c++] = y1; coords[c++] = z2;

    coords[c++] = x2; coords[c++] = y2; coords[c++] = z1;
    coords[c++] = x2; coords[c++] = y2; coords[c++] = z2;
    coords[c++] = x1; coords[c++] = y1; coords[c++] = z2;
    return c;
  }

  private trianglesToSTL_Buffer(coords: Float32Array): Buffer {
    const numTriangles = coords.length / 9;
    const bufferSize = 84 + numTriangles * 50;
    const buffer = Buffer.alloc(bufferSize);

    buffer.write('HueSlicer TileGenerator', 0);
    buffer.writeUInt32LE(numTriangles, 80);

    let offset = 84;
    for (let i = 0; i < coords.length; i += 9) {
      // Calc normal
      const v0x = coords[i], v0y = coords[i + 1], v0z = coords[i + 2];
      const v1x = coords[i + 3], v1y = coords[i + 4], v1z = coords[i + 5];
      const v2x = coords[i + 6], v2y = coords[i + 7], v2z = coords[i + 8];

      const ax = v1x - v0x, ay = v1y - v0y, az = v1z - v0z;
      const bx = v2x - v0x, by = v2y - v0y, bz = v2z - v0z;

      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }

      buffer.writeFloatLE(nx, offset);
      buffer.writeFloatLE(ny, offset + 4);
      buffer.writeFloatLE(nz, offset + 8);

      buffer.writeFloatLE(v0x, offset + 12);
      buffer.writeFloatLE(v0y, offset + 16);
      buffer.writeFloatLE(v0z, offset + 20);

      buffer.writeFloatLE(v1x, offset + 24);
      buffer.writeFloatLE(v1y, offset + 28);
      buffer.writeFloatLE(v1z, offset + 32);

      buffer.writeFloatLE(v2x, offset + 36);
      buffer.writeFloatLE(v2y, offset + 40);
      buffer.writeFloatLE(v2z, offset + 44);

      buffer.writeUInt16LE(0, offset + 48);
      offset += 50;
    }
    return buffer;
  }
}
