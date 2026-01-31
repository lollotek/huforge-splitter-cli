
import fs from 'fs';
import path from 'path';

/**
 * Legge un file STL binario e calcola statistiche.
 */
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

  // Edge Counting for Manifold Check
  // Key: "x1,y1,z1|x2,y2,z2" (sorted)
  const edgeCounts = new Map<string, number>();
  const pk = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;

  const points: { x: number, y: number }[] = [];

  const offset = 84;
  for (let i = 0; i < triCount; i++) {
    const base = offset + i * 50;

    // Read vertices
    const v1x = buf.readFloatLE(base + 12);
    const v1y = buf.readFloatLE(base + 16);
    const v1z = buf.readFloatLE(base + 20);

    const v2x = buf.readFloatLE(base + 24);
    const v2y = buf.readFloatLE(base + 28);
    const v2z = buf.readFloatLE(base + 32);

    const v3x = buf.readFloatLE(base + 36);
    const v3y = buf.readFloatLE(base + 40);
    const v3z = buf.readFloatLE(base + 44);

    // Bounds & Center
    const vs = [[v1x, v1y, v1z], [v2x, v2y, v2z], [v3x, v3y, v3z]];
    for (const [x, y, z] of vs) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      sumX += x; sumY += y; sumZ += z;
    }

    // Collect points for density
    if (i % 10 === 0) points.push({ x: v1x, y: v1y });

    // Edge Counting
    const keys = vs.map(v => pk(v[0], v[1], v[2]));
    const addEdge = (k1: string, k2: string) => {
      if (k1 === k2) return;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    };
    addEdge(keys[0], keys[1]);
    addEdge(keys[1], keys[2]);
    addEdge(keys[2], keys[0]);
  }

  const vertexCount = triCount * 3;
  const center = {
    x: sumX / vertexCount,
    y: sumY / vertexCount,
    z: sumZ / vertexCount
  };

  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  return {
    triCount,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    center,
    points,
    manifold: { openEdges, nonManifoldEdges }
  };
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

console.log(`\nMesh Health:`);
console.log(`  Open Edges: ${stats.manifold.openEdges} (Goal: 0)`);
console.log(`  Non-Manifold Edges: ${stats.manifold.nonManifoldEdges} (Goal: 0)`);
if (stats.manifold.openEdges === 0) console.log("  Status: MANIFOLD (Watertight)");
else console.log("  Status: NON-MANIFOLD (Has Holes)");

console.log("\nDensity Map (normalized to bounds):");
console.log(drawDensityMap(stats.points, stats.bounds));
