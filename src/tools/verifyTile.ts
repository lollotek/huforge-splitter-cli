
import fs from 'fs';
import path from 'path';

/**
 * Legge un file STL binario e calcola statistiche.
 */
function parseSTL(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const triCount = buf.readUInt32LE(80);

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  let sumX = 0, sumY = 0, sumZ = 0;

  // Simple sampling for density map (50x50 grid)
  const points: { x: number, y: number }[] = [];

  // Iterate triangles (50 bytes each)
  const offset = 84;
  for (let i = 0; i < triCount; i++) {
    const base = offset + i * 50;
    // Read 3 vertices
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(base + 12 + v * 12);
      const y = buf.readFloatLE(base + 16 + v * 12);
      const z = buf.readFloatLE(base + 20 + v * 12);

      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

      sumX += x; sumY += y; sumZ += z;

      // Collect subset for density (every 10th triangle, 1st vertex)
      if (i % 10 === 0 && v === 0) {
        points.push({ x, y });
      }
    }
  }

  const vertexCount = triCount * 3;
  const center = {
    x: sumX / vertexCount,
    y: sumY / vertexCount,
    z: sumZ / vertexCount
  };

  return { triCount, bounds: { minX, maxX, minY, maxY, minZ, maxZ }, center, points };
}

function drawDensityMap(points: { x: number, y: number }[], bounds: any, width = 40, height = 20) {
  const grid = Array(height).fill(null).map(() => Array(width).fill('·'));

  const rangeX = bounds.maxX - bounds.minX || 1;
  const rangeY = bounds.maxY - bounds.minY || 1;

  for (const p of points) {
    const nx = Math.floor(((p.x - bounds.minX) / rangeX) * (width - 1));
    const ny = Math.floor(((p.y - bounds.minY) / rangeY) * (height - 1));

    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
      grid[ny][nx] = '█';
    }
  }

  return grid.map(row => row.join('')).join('\n');
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: ts-node verifyTile.ts <file.stl>");
  process.exit(1);
}

const file = args[0];
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

console.log(`Analyzing ${path.basename(file)}...`);
const stats = parseSTL(file);

console.log(`Triangles: ${stats.triCount}`);
console.log(`Bounds: 
  X: ${stats.bounds.minX.toFixed(2)} -> ${stats.bounds.maxX.toFixed(2)} (W: ${(stats.bounds.maxX - stats.bounds.minX).toFixed(2)})
  Y: ${stats.bounds.minY.toFixed(2)} -> ${stats.bounds.maxY.toFixed(2)} (H: ${(stats.bounds.maxY - stats.bounds.minY).toFixed(2)})
  Z: ${stats.bounds.minZ.toFixed(2)} -> ${stats.bounds.maxZ.toFixed(2)}
`);
console.log(`Center: [${stats.center.x.toFixed(2)}, ${stats.center.y.toFixed(2)}, ${stats.center.z.toFixed(2)}]`);

console.log("\nDensity Map (normalized to bounds):");
console.log(drawDensityMap(stats.points, stats.bounds));
