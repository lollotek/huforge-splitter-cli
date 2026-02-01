import fs from 'fs';

export class TriangleClipper {
  /**
   * Calcola bounding box da un buffer STL
   */
  constructor(verbose: boolean = false) { }

  getBoundingBox(stlBuffer: Buffer): { minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number } {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    const triangleCount = stlBuffer.readUInt32LE(80);
    const headerSize = 84;

    for (let i = 0; i < triangleCount; i++) {
      const offset = headerSize + i * 50;
      for (let v = 0; v < 3; v++) {
        const vOffset = offset + 12 + v * 12;
        const x = stlBuffer.readFloatLE(vOffset);
        const y = stlBuffer.readFloatLE(vOffset + 4);
        const z = stlBuffer.readFloatLE(vOffset + 8);

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    return { minX, maxX, minY, maxY, minZ, maxZ };
  }
}
