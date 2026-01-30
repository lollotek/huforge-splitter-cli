/**
 * Tests for TriangleClipper
 * 
 * Run with: npx ts-node src/tests/TriangleClipperTests.ts
 */

import { TriangleClipper, Point2D, Point3D, Triangle, Side } from '../core/TriangleClipper';
import fs from 'fs';
import path from 'path';

const clipper = new TriangleClipper(true);

// Test utilities
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

function floatEquals(a: number, b: number, epsilon = 1e-5): boolean {
  return Math.abs(a - b) < epsilon;
}

// ========== Test 1: Point Classification ==========
function testPointClassification() {
  console.log('\n=== Test 1: Point Classification ===');

  // Vertical line at X=5, from Y=0 to Y=10
  const verticalPath: Point2D[] = [
    { x: 5, y: 0 },
    { x: 5, y: 10 }
  ];

  // Left of path
  assert(clipper.classifyPoint(2, 5, verticalPath) === Side.LEFT,
    'Point (2,5) should be LEFT of vertical line at X=5');

  // Right of path
  assert(clipper.classifyPoint(8, 5, verticalPath) === Side.RIGHT,
    'Point (8,5) should be RIGHT of vertical line at X=5');

  // On path
  assert(clipper.classifyPoint(5, 5, verticalPath) === Side.ON_PATH,
    'Point (5,5) should be ON_PATH');

  // Point outside Y range (above)
  assert(clipper.classifyPoint(2, 15, verticalPath) === Side.LEFT,
    'Point (2,15) above path should still be LEFT');

  // Point outside Y range (below)
  assert(clipper.classifyPoint(8, -5, verticalPath) === Side.RIGHT,
    'Point (8,-5) below path should still be RIGHT');
}

// ========== Test 2: Curved Path ==========
function testCurvedPath() {
  console.log('\n=== Test 2: Curved Path Classification ===');

  // S-curve path
  const curvedPath: Point2D[] = [
    { x: 0, y: 0 },
    { x: 5, y: 2 },
    { x: 0, y: 4 },
    { x: 5, y: 6 },
    { x: 0, y: 8 }
  ];

  // At Y=1, path is around X=2.5
  assert(clipper.classifyPoint(0, 1, curvedPath) === Side.LEFT,
    'Point (0,1) should be LEFT of S-curve');
  assert(clipper.classifyPoint(4, 1, curvedPath) === Side.RIGHT,
    'Point (4,1) should be RIGHT of S-curve');

  // At Y=3, path is around X=2.5
  assert(clipper.classifyPoint(0, 3, curvedPath) === Side.LEFT,
    'Point (0,3) should be LEFT');
  assert(clipper.classifyPoint(4, 3, curvedPath) === Side.RIGHT,
    'Point (4,3) should be RIGHT');
}

// ========== Test 3: Triangle Classification ==========
function testTriangleClassification() {
  console.log('\n=== Test 3: Triangle Classification ===');

  const verticalPath: Point2D[] = [
    { x: 5, y: 0 },
    { x: 5, y: 10 }
  ];

  // Triangle entirely on left
  const leftTri: Triangle = {
    v1: { x: 0, y: 0, z: 0 },
    v2: { x: 4, y: 0, z: 0 },
    v3: { x: 2, y: 5, z: 0 }
  };
  assert(clipper.classifyTriangle(leftTri, verticalPath) === 'LEFT',
    'Triangle at X<5 should be LEFT');

  // Triangle entirely on right
  const rightTri: Triangle = {
    v1: { x: 6, y: 0, z: 0 },
    v2: { x: 10, y: 0, z: 0 },
    v3: { x: 8, y: 5, z: 0 }
  };
  assert(clipper.classifyTriangle(rightTri, verticalPath) === 'RIGHT',
    'Triangle at X>5 should be RIGHT');

  // Crossing triangle
  const crossTri: Triangle = {
    v1: { x: 0, y: 0, z: 0 },
    v2: { x: 10, y: 0, z: 0 },
    v3: { x: 5, y: 5, z: 0 }
  };
  assert(clipper.classifyTriangle(crossTri, verticalPath) === 'CROSSING',
    'Triangle spanning X=5 should be CROSSING');
}

// ========== Test 4: Triangle Clipping ==========
function testTriangleClipping() {
  console.log('\n=== Test 4: Triangle Clipping ===');

  const verticalPath: Point2D[] = [
    { x: 5, y: -10 },
    { x: 5, y: 20 }
  ];

  // Triangle from (0,0) to (10,0) to (5,10)
  const crossTri: Triangle = {
    v1: { x: 0, y: 0, z: 0 },
    v2: { x: 10, y: 0, z: 0 },
    v3: { x: 5, y: 10, z: 5 }  // Z varies to test interpolation
  };

  const result = clipper.clipTriangle(crossTri, verticalPath);

  assert(result.left.length > 0, 'Should have left triangles');
  assert(result.right.length > 0, 'Should have right triangles');

  console.log(`   Left triangles: ${result.left.length}`);
  console.log(`   Right triangles: ${result.right.length}`);

  // Check that all left vertices are at X <= 5
  for (const tri of result.left) {
    assert(tri.v1.x <= 5 + 1e-5, 'Left tri v1.x should be <= 5');
    assert(tri.v2.x <= 5 + 1e-5, 'Left tri v2.x should be <= 5');
    assert(tri.v3.x <= 5 + 1e-5, 'Left tri v3.x should be <= 5');
  }

  // Check that all right vertices are at X >= 5
  for (const tri of result.right) {
    assert(tri.v1.x >= 5 - 1e-5, 'Right tri v1.x should be >= 5');
    assert(tri.v2.x >= 5 - 1e-5, 'Right tri v2.x should be >= 5');
    assert(tri.v3.x >= 5 - 1e-5, 'Right tri v3.x should be >= 5');
  }
}

// ========== Test 5: STL Split (Simple Cube) ==========
function testSTLSplit() {
  console.log('\n=== Test 5: STL Split (Cube) ===');

  // Create a simple cube STL (10x10x10 centered at (5,5,5) so X=5 cuts through center)
  const cubeTriangles: Triangle[] = createCubeTriangles(5, 5, 5, 10);

  const tempPath = path.join(__dirname, 'temp_cube.stl');
  const tempClipper = new TriangleClipper(false);

  // Write temp STL
  const cubeBuffer = (tempClipper as any).writeSTL(cubeTriangles);
  fs.writeFileSync(tempPath, cubeBuffer);

  // Split at X=5
  const splitPath: Point2D[] = [
    { x: 5, y: -10 },
    { x: 5, y: 20 }
  ];

  const stlBuffer = fs.readFileSync(tempPath);
  const result = tempClipper.splitSTL(stlBuffer, splitPath);

  // Count triangles
  const leftCount = result.leftBuffer.readUInt32LE(80);
  const rightCount = result.rightBuffer.readUInt32LE(80);

  console.log(`   Original: ${cubeTriangles.length} triangles`);
  console.log(`   Left: ${leftCount}, Right: ${rightCount}`);

  assert(leftCount > 0, 'Should have left triangles');
  assert(rightCount > 0, 'Should have right triangles');

  // Clean up
  fs.unlinkSync(tempPath);
}

// ========== Test 6: Large Mesh Test (if available) ==========
function testLargeMesh() {
  console.log('\n=== Test 6: Large Mesh (wave.stl) ===');

  const waveStlPath = path.resolve(__dirname, '../../test-models/wave.stl');

  if (!fs.existsSync(waveStlPath)) {
    console.log('   ⚠️ wave.stl not found, skipping');
    return;
  }

  const stlBuffer = fs.readFileSync(waveStlPath);
  const triangleCount = stlBuffer.readUInt32LE(80);
  console.log(`   Input triangles: ${triangleCount}`);

  // Simple vertical cut at X = center
  const splitPath: Point2D[] = [
    { x: 250, y: -100 },
    { x: 250, y: 600 }
  ];

  console.log('   Splitting...');
  const start = Date.now();
  const result = clipper.splitSTL(stlBuffer, splitPath);
  const elapsed = Date.now() - start;

  const leftCount = result.leftBuffer.readUInt32LE(80);
  const rightCount = result.rightBuffer.readUInt32LE(80);

  console.log(`   Left: ${leftCount}, Right: ${rightCount}`);
  console.log(`   Time: ${elapsed}ms`);

  assert(leftCount > 0, 'Should have left triangles');
  assert(rightCount > 0, 'Should have right triangles');
  assert(elapsed < 60000, 'Should complete in under 60 seconds');
}

// Helper: Create cube triangles
function createCubeTriangles(cx: number, cy: number, cz: number, size: number): Triangle[] {
  const h = size / 2;
  const triangles: Triangle[] = [];

  // Define 8 corners
  const corners = [
    { x: cx - h, y: cy - h, z: cz - h }, // 0: bottom-left-front
    { x: cx + h, y: cy - h, z: cz - h }, // 1: bottom-right-front
    { x: cx + h, y: cy + h, z: cz - h }, // 2: top-right-front
    { x: cx - h, y: cy + h, z: cz - h }, // 3: top-left-front
    { x: cx - h, y: cy - h, z: cz + h }, // 4: bottom-left-back
    { x: cx + h, y: cy - h, z: cz + h }, // 5: bottom-right-back
    { x: cx + h, y: cy + h, z: cz + h }, // 6: top-right-back
    { x: cx - h, y: cy + h, z: cz + h }  // 7: top-left-back
  ];

  // 6 faces, 2 triangles each
  const faces = [
    [0, 1, 2, 3], // front
    [5, 4, 7, 6], // back
    [4, 0, 3, 7], // left
    [1, 5, 6, 2], // right
    [3, 2, 6, 7], // top
    [4, 5, 1, 0]  // bottom
  ];

  for (const face of faces) {
    triangles.push({
      v1: corners[face[0]],
      v2: corners[face[1]],
      v3: corners[face[2]]
    });
    triangles.push({
      v1: corners[face[0]],
      v2: corners[face[2]],
      v3: corners[face[3]]
    });
  }

  return triangles;
}

// Run all tests
async function runTests() {
  console.log('🧪 TriangleClipper Test Suite\n');

  try {
    testPointClassification();
    testCurvedPath();
    testTriangleClassification();
    testTriangleClipping();
    testSTLSplit();
    testLargeMesh();

    console.log('\n✅ All tests passed!');
  } catch (e) {
    console.error('\n❌ Tests failed:', e);
    process.exit(1);
  }
}

runTests();
