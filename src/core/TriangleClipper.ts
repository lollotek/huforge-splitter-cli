import fs from 'fs';

/**
 * Triangle Clipping Algorithm
 * 
 * Splits STL meshes using seam paths without degrading quality.
 * Uses direct triangle manipulation instead of boolean operations.
 */

// Types
export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface Triangle {
  v1: Point3D;
  v2: Point3D;
  v3: Point3D;
  normal?: Point3D;
}

export enum Side {
  LEFT = -1,
  ON_PATH = 0,
  RIGHT = 1
}

export interface ClipResult {
  left: Triangle[];
  right: Triangle[];
  leftBoundary: Point3D[];  // Per generare cap
  rightBoundary: Point3D[];
}

/**
 * Edge sul confine del taglio (per cap generation)
 */
export interface BoundaryEdge {
  p1: Point3D;
  p2: Point3D;
}

// Constants
const EPSILON = 1e-6;

export class TriangleClipper {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  /**
   * Calcola bounding box da un buffer STL
   */
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

  /**
   * Verifica se un path verticale interseca il bounding box
   */
  pathIntersectsBboxVertical(path: Point2D[], bbox: { minX: number, maxX: number, minY: number, maxY: number }): boolean {
    // Trova range X del path
    const pathMinX = Math.min(...path.map(p => p.x));
    const pathMaxX = Math.max(...path.map(p => p.x));

    // Il path deve passare attraverso il range X del bbox
    // (pathX deve essere tra bboxMinX e bboxMaxX)
    const pathCenterX = (pathMinX + pathMaxX) / 2;
    return pathCenterX > bbox.minX && pathCenterX < bbox.maxX;
  }

  /**
   * Verifica se un path orizzontale interseca il bounding box
   */
  pathIntersectsBboxHorizontal(path: Point2D[], bbox: { minX: number, maxX: number, minY: number, maxY: number }): boolean {
    // Trova range Y del path
    const pathMinY = Math.min(...path.map(p => p.y));
    const pathMaxY = Math.max(...path.map(p => p.y));

    // Il path deve passare attraverso il range Y del bbox
    const pathCenterY = (pathMinY + pathMaxY) / 2;
    return pathCenterY > bbox.minY && pathCenterY < bbox.maxY;
  }

  /**
   * Classifica un punto rispetto a un path usando signed area test
   * 
   * Per un path verticale (da Y_min a Y_max), determina se il punto
   * è a sinistra o a destra del path.
   * 
   * @param px X del punto (world coords, mm)
   * @param py Y del punto (world coords, mm)
   * @param path Array di punti che formano il seam (world coords, mm)
   * @returns Side.LEFT, Side.RIGHT, o Side.ON_PATH
   */
  classifyPoint(px: number, py: number, path: Point2D[]): Side {
    if (path.length < 2) return Side.LEFT;

    // Trova il segmento del path più vicino al Y del punto
    // Per path verticali, cerchiamo dove py si trova lungo il path
    let closestSegmentIdx = 0;
    let minYDist = Infinity;

    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const segMinY = Math.min(p1.y, p2.y);
      const segMaxY = Math.max(p1.y, p2.y);

      // Se py è nel range di questo segmento
      if (py >= segMinY - EPSILON && py <= segMaxY + EPSILON) {
        const midY = (segMinY + segMaxY) / 2;
        const dist = Math.abs(py - midY);
        if (dist < minYDist) {
          minYDist = dist;
          closestSegmentIdx = i;
        }
      }
    }

    // Se py è fuori dal range del path, usa il segmento più vicino
    if (minYDist === Infinity) {
      if (py < path[0].y) {
        closestSegmentIdx = 0;
      } else {
        closestSegmentIdx = path.length - 2;
      }
    }

    // Interpoloazione lineare per trovare X del path a questo Y
    const p1 = path[closestSegmentIdx];
    const p2 = path[closestSegmentIdx + 1];

    // Evita divisione per zero per segmenti orizzontali
    let pathXAtY: number;
    if (Math.abs(p2.y - p1.y) < EPSILON) {
      pathXAtY = (p1.x + p2.x) / 2;
    } else {
      const t = (py - p1.y) / (p2.y - p1.y);
      const tClamped = Math.max(0, Math.min(1, t));
      pathXAtY = p1.x + tClamped * (p2.x - p1.x);
    }

    // Confronta X
    const diff = px - pathXAtY;
    if (Math.abs(diff) < EPSILON) return Side.ON_PATH;
    return diff < 0 ? Side.LEFT : Side.RIGHT;
  }

  /**
   * Classifica un triangolo rispetto al path
   * @returns 'LEFT' | 'RIGHT' | 'CROSSING'
   */
  classifyTriangle(tri: Triangle, path: Point2D[]): 'LEFT' | 'RIGHT' | 'CROSSING' {
    const s1 = this.classifyPoint(tri.v1.x, tri.v1.y, path);
    const s2 = this.classifyPoint(tri.v2.x, tri.v2.y, path);
    const s3 = this.classifyPoint(tri.v3.x, tri.v3.y, path);

    // Ignora ON_PATH per la classificazione
    const sides = [s1, s2, s3].filter(s => s !== Side.ON_PATH);

    if (sides.length === 0) return 'LEFT'; // Tutti sul path, assegna a sinistra

    const allLeft = sides.every(s => s === Side.LEFT);
    const allRight = sides.every(s => s === Side.RIGHT);

    if (allLeft) return 'LEFT';
    if (allRight) return 'RIGHT';
    return 'CROSSING';
  }

  /**
   * Clippa un triangolo che attraversa il path
   * Genera nuovi triangoli per entrambi i lati
   */
  clipTriangle(tri: Triangle, path: Point2D[]): { left: Triangle[], right: Triangle[] } {
    const vertices = [tri.v1, tri.v2, tri.v3];
    const sides = vertices.map(v => this.classifyPoint(v.x, v.y, path));

    // Trova i vertici su ogni lato
    const leftVerts: Point3D[] = [];
    const rightVerts: Point3D[] = [];
    const intersections: Point3D[] = [];

    for (let i = 0; i < 3; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % 3];
      const s1 = sides[i];
      const s2 = sides[(i + 1) % 3];

      // Aggiungi v1 al suo lato
      if (s1 === Side.LEFT || s1 === Side.ON_PATH) {
        leftVerts.push(v1);
      }
      if (s1 === Side.RIGHT || s1 === Side.ON_PATH) {
        rightVerts.push(v1);
      }

      // Se l'edge attraversa il path, calcola intersezione
      if ((s1 === Side.LEFT && s2 === Side.RIGHT) ||
        (s1 === Side.RIGHT && s2 === Side.LEFT)) {
        const intersection = this.findEdgePathIntersection(v1, v2, path);
        if (intersection) {
          leftVerts.push(intersection);
          rightVerts.push(intersection);
          intersections.push(intersection);
        }
      }
    }

    return {
      left: this.triangulatePolygon(leftVerts, tri.normal),
      right: this.triangulatePolygon(rightVerts, tri.normal)
    };
  }

  /**
   * Trova il punto di intersezione tra un edge e il path
   */
  private findEdgePathIntersection(v1: Point3D, v2: Point3D, path: Point2D[]): Point3D | null {
    // Per ogni segmento del path, cerca intersezione con l'edge
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];

      const intersection = this.lineSegmentIntersection(
        v1.x, v1.y, v2.x, v2.y,
        p1.x, p1.y, p2.x, p2.y
      );

      if (intersection) {
        // Calcola t per interpolare Z
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        let t: number;
        if (Math.abs(dx) > Math.abs(dy)) {
          t = (intersection.x - v1.x) / dx;
        } else if (Math.abs(dy) > EPSILON) {
          t = (intersection.y - v1.y) / dy;
        } else {
          t = 0.5;
        }
        t = Math.max(0, Math.min(1, t));

        return {
          x: intersection.x,
          y: intersection.y,
          z: v1.z + t * (v2.z - v1.z)
        };
      }
    }
    return null;
  }

  /**
   * Intersezione tra due segmenti di linea 2D
   */
  private lineSegmentIntersection(
    x1: number, y1: number, x2: number, y2: number,  // Segment 1
    x3: number, y3: number, x4: number, y4: number   // Segment 2
  ): Point2D | null {
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < EPSILON) return null; // Paralleli

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

    if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
      return {
        x: x1 + t * (x2 - x1),
        y: y1 + t * (y2 - y1)
      };
    }
    return null;
  }

  /**
   * Triangola un poligono convesso (o quasi-convesso)
   * Usa fan triangulation dal primo vertice
   */
  private triangulatePolygon(vertices: Point3D[], normal?: Point3D): Triangle[] {
    if (vertices.length < 3) return [];

    // Rimuovi duplicati
    const unique = this.removeDuplicateVertices(vertices);
    if (unique.length < 3) return [];

    const triangles: Triangle[] = [];
    for (let i = 1; i < unique.length - 1; i++) {
      triangles.push({
        v1: unique[0],
        v2: unique[i],
        v3: unique[i + 1],
        normal: normal
      });
    }
    return triangles;
  }

  private removeDuplicateVertices(vertices: Point3D[]): Point3D[] {
    const result: Point3D[] = [];
    for (const v of vertices) {
      const isDuplicate = result.some(r =>
        Math.abs(r.x - v.x) < EPSILON &&
        Math.abs(r.y - v.y) < EPSILON &&
        Math.abs(r.z - v.z) < EPSILON
      );
      if (!isDuplicate) result.push(v);
    }
    return result;
  }

  /**
   * Processa un intero STL file e lo divide secondo il path (verticale)
   */
  splitSTL(
    stlBuffer: Buffer,
    path: Point2D[]
  ): { leftBuffer: Buffer, rightBuffer: Buffer } {
    return this.splitSTLInternal(stlBuffer, path, 'vertical');
  }

  /**
   * Processa un intero STL file e lo divide secondo il path (orizzontale)
   * Per path orizzontali, LEFT = sopra (Y maggiore), RIGHT = sotto (Y minore)
   */
  splitSTLHorizontal(
    stlBuffer: Buffer,
    path: Point2D[]
  ): { leftBuffer: Buffer, rightBuffer: Buffer } {
    return this.splitSTLInternal(stlBuffer, path, 'horizontal');
  }

  private splitSTLInternal(
    stlBuffer: Buffer,
    path: Point2D[],
    orientation: 'vertical' | 'horizontal'
  ): { leftBuffer: Buffer, rightBuffer: Buffer } {
    const triangles = this.parseSTL(stlBuffer);

    if (this.verbose) {
      console.log(`📐 Processing ${triangles.length} triangles (${orientation})...`);
    }

    const leftTriangles: Triangle[] = [];
    const rightTriangles: Triangle[] = [];
    let crossingCount = 0;

    const classifyFn = orientation === 'vertical'
      ? this.classifyPoint.bind(this)
      : this.classifyPointHorizontal.bind(this);

    for (const tri of triangles) {
      const s1 = classifyFn(tri.v1.x, tri.v1.y, path);
      const s2 = classifyFn(tri.v2.x, tri.v2.y, path);
      const s3 = classifyFn(tri.v3.x, tri.v3.y, path);

      const sides = [s1, s2, s3].filter(s => s !== Side.ON_PATH);

      if (sides.length === 0 || sides.every(s => s === Side.LEFT)) {
        leftTriangles.push(tri);
      } else if (sides.every(s => s === Side.RIGHT)) {
        rightTriangles.push(tri);
      } else {
        // CROSSING - clip the triangle
        crossingCount++;
        const clipped = this.clipTriangleWithOrientation(tri, path, classifyFn);
        leftTriangles.push(...clipped.left);
        rightTriangles.push(...clipped.right);
      }
    }

    if (this.verbose) {
      console.log(`   Left: ${leftTriangles.length}, Right: ${rightTriangles.length}, Clipped: ${crossingCount}`);
    }

    return {
      leftBuffer: this.writeSTL(leftTriangles),
      rightBuffer: this.writeSTL(rightTriangles)
    };
  }

  /**
   * Classifica un punto rispetto a un path ORIZZONTALE
   * Per path che vanno da X_min a X_max, determina se il punto è sopra o sotto
   */
  classifyPointHorizontal(px: number, py: number, path: Point2D[]): Side {
    if (path.length < 2) return Side.LEFT;

    // Trova il segmento del path più vicino al X del punto
    let closestSegmentIdx = 0;
    let minXDist = Infinity;

    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const segMinX = Math.min(p1.x, p2.x);
      const segMaxX = Math.max(p1.x, p2.x);

      if (px >= segMinX - EPSILON && px <= segMaxX + EPSILON) {
        const midX = (segMinX + segMaxX) / 2;
        const dist = Math.abs(px - midX);
        if (dist < minXDist) {
          minXDist = dist;
          closestSegmentIdx = i;
        }
      }
    }

    // Se px è fuori dal range del path, usa il segmento più vicino
    if (minXDist === Infinity) {
      if (px < path[0].x) {
        closestSegmentIdx = 0;
      } else {
        closestSegmentIdx = path.length - 2;
      }
    }

    // Interpolazione lineare per trovare Y del path a questo X
    const p1 = path[closestSegmentIdx];
    const p2 = path[closestSegmentIdx + 1];

    let pathYAtX: number;
    if (Math.abs(p2.x - p1.x) < EPSILON) {
      pathYAtX = (p1.y + p2.y) / 2;
    } else {
      const t = (px - p1.x) / (p2.x - p1.x);
      const tClamped = Math.max(0, Math.min(1, t));
      pathYAtX = p1.y + tClamped * (p2.y - p1.y);
    }

    // Confronta Y (LEFT = sopra = Y maggiore, RIGHT = sotto = Y minore)
    const diff = py - pathYAtX;
    if (Math.abs(diff) < EPSILON) return Side.ON_PATH;
    return diff > 0 ? Side.LEFT : Side.RIGHT;
  }

  /**
   * Clip con funzione di classificazione parametrica
   */
  private clipTriangleWithOrientation(
    tri: Triangle,
    path: Point2D[],
    classifyFn: (px: number, py: number, path: Point2D[]) => Side
  ): { left: Triangle[], right: Triangle[] } {
    const vertices = [tri.v1, tri.v2, tri.v3];
    const sides = vertices.map(v => classifyFn(v.x, v.y, path));

    const leftVerts: Point3D[] = [];
    const rightVerts: Point3D[] = [];

    for (let i = 0; i < 3; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % 3];
      const s1 = sides[i];
      const s2 = sides[(i + 1) % 3];

      if (s1 === Side.LEFT || s1 === Side.ON_PATH) {
        leftVerts.push(v1);
      }
      if (s1 === Side.RIGHT || s1 === Side.ON_PATH) {
        rightVerts.push(v1);
      }

      if ((s1 === Side.LEFT && s2 === Side.RIGHT) ||
        (s1 === Side.RIGHT && s2 === Side.LEFT)) {
        const intersection = this.findEdgePathIntersection(v1, v2, path);
        if (intersection) {
          leftVerts.push(intersection);
          rightVerts.push(intersection);
        }
      }
    }

    return {
      left: this.triangulatePolygon(leftVerts, tri.normal),
      right: this.triangulatePolygon(rightVerts, tri.normal)
    };
  }

  /**
   * Parse binary STL
   */
  private parseSTL(buffer: Buffer): Triangle[] {
    const triangles: Triangle[] = [];
    const triangleCount = buffer.readUInt32LE(80);
    const headerSize = 84;

    for (let i = 0; i < triangleCount; i++) {
      const offset = headerSize + i * 50;

      const normal: Point3D = {
        x: buffer.readFloatLE(offset),
        y: buffer.readFloatLE(offset + 4),
        z: buffer.readFloatLE(offset + 8)
      };

      const v1: Point3D = {
        x: buffer.readFloatLE(offset + 12),
        y: buffer.readFloatLE(offset + 16),
        z: buffer.readFloatLE(offset + 20)
      };

      const v2: Point3D = {
        x: buffer.readFloatLE(offset + 24),
        y: buffer.readFloatLE(offset + 28),
        z: buffer.readFloatLE(offset + 32)
      };

      const v3: Point3D = {
        x: buffer.readFloatLE(offset + 36),
        y: buffer.readFloatLE(offset + 40),
        z: buffer.readFloatLE(offset + 44)
      };

      triangles.push({ v1, v2, v3, normal });
    }

    return triangles;
  }

  /**
   * Write binary STL
   */
  private writeSTL(triangles: Triangle[]): Buffer {
    const headerSize = 80;
    const countSize = 4;
    const triangleSize = 50;
    const bufferSize = headerSize + countSize + triangles.length * triangleSize;

    const buffer = Buffer.alloc(bufferSize);
    buffer.write('HueSlicer TriangleClipper', 0);
    buffer.writeUInt32LE(triangles.length, 80);

    let offset = 84;
    for (const tri of triangles) {
      // Calculate normal if not provided
      const normal = tri.normal || this.calculateNormal(tri);

      buffer.writeFloatLE(normal.x, offset);
      buffer.writeFloatLE(normal.y, offset + 4);
      buffer.writeFloatLE(normal.z, offset + 8);
      offset += 12;

      buffer.writeFloatLE(tri.v1.x, offset);
      buffer.writeFloatLE(tri.v1.y, offset + 4);
      buffer.writeFloatLE(tri.v1.z, offset + 8);
      offset += 12;

      buffer.writeFloatLE(tri.v2.x, offset);
      buffer.writeFloatLE(tri.v2.y, offset + 4);
      buffer.writeFloatLE(tri.v2.z, offset + 8);
      offset += 12;

      buffer.writeFloatLE(tri.v3.x, offset);
      buffer.writeFloatLE(tri.v3.y, offset + 4);
      buffer.writeFloatLE(tri.v3.z, offset + 8);
      offset += 12;

      buffer.writeUInt16LE(0, offset); // Attribute byte count
      offset += 2;
    }

    return buffer;
  }

  private calculateNormal(tri: Triangle): Point3D {
    const u = {
      x: tri.v2.x - tri.v1.x,
      y: tri.v2.y - tri.v1.y,
      z: tri.v2.z - tri.v1.z
    };
    const v = {
      x: tri.v3.x - tri.v1.x,
      y: tri.v3.y - tri.v1.y,
      z: tri.v3.z - tri.v1.z
    };

    const normal = {
      x: u.y * v.z - u.z * v.y,
      y: u.z * v.x - u.x * v.z,
      z: u.x * v.y - u.y * v.x
    };

    const len = Math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
    if (len > EPSILON) {
      normal.x /= len;
      normal.y /= len;
      normal.z /= len;
    }

    return normal;
  }

  /**
   * Salva buffer STL su disco
   */
  saveSTL(buffer: Buffer, filePath: string): void {
    fs.writeFileSync(filePath, buffer);
    if (this.verbose) console.log(`💾 Saved: ${filePath}`);
  }

  // =====================================================
  // CAP GENERATION - Per mesh watertight
  // =====================================================

  /**
   * Split con generazione di cap per chiudere i buchi
   * Versione che genera mesh watertight
   */
  splitSTLWithCaps(
    stlBuffer: Buffer,
    path: Point2D[],
    orientation: 'vertical' | 'horizontal'
  ): { leftBuffer: Buffer, rightBuffer: Buffer } {
    const triangles = this.parseSTL(stlBuffer);

    if (this.verbose) {
      console.log(`📐 Processing ${triangles.length} triangles with caps (${orientation})...`);
    }

    const leftTriangles: Triangle[] = [];
    const rightTriangles: Triangle[] = [];
    const boundaryEdges: BoundaryEdge[] = [];
    let crossingCount = 0;

    const classifyFn = orientation === 'vertical'
      ? this.classifyPoint.bind(this)
      : this.classifyPointHorizontal.bind(this);

    for (const tri of triangles) {
      const s1 = classifyFn(tri.v1.x, tri.v1.y, path);
      const s2 = classifyFn(tri.v2.x, tri.v2.y, path);
      const s3 = classifyFn(tri.v3.x, tri.v3.y, path);

      const sides = [s1, s2, s3].filter(s => s !== Side.ON_PATH);

      if (sides.length === 0 || sides.every(s => s === Side.LEFT)) {
        leftTriangles.push(tri);
      } else if (sides.every(s => s === Side.RIGHT)) {
        rightTriangles.push(tri);
      } else {
        // CROSSING - clip and collect boundary
        crossingCount++;
        const { left, right, edges } = this.clipTriangleWithEdges(tri, path, classifyFn);
        leftTriangles.push(...left);
        rightTriangles.push(...right);
        boundaryEdges.push(...edges);
      }
    }

    if (this.verbose) {
      console.log(`   Clipped: ${crossingCount}, Boundary edges: ${boundaryEdges.length}`);
    }

    // Generate cap triangles
    if (boundaryEdges.length > 0) {
      const polylines = this.buildBoundaryPolylines(boundaryEdges);

      if (this.verbose) {
        console.log(`   Polylines: ${polylines.length}`);
      }

      for (const polyline of polylines) {
        const leftCaps = this.generateCapTriangles(polyline, orientation, 'left');
        const rightCaps = this.generateCapTriangles(polyline, orientation, 'right');

        leftTriangles.push(...leftCaps);
        rightTriangles.push(...rightCaps);
      }

      if (this.verbose) {
        console.log(`   Final: Left ${leftTriangles.length}, Right ${rightTriangles.length}`);
      }
    }

    return {
      leftBuffer: this.writeSTL(leftTriangles),
      rightBuffer: this.writeSTL(rightTriangles)
    };
  }

  /**
   * Clip keeping track of boundary edges
   */
  private clipTriangleWithEdges(
    tri: Triangle,
    path: Point2D[],
    classifyFn: (px: number, py: number, path: Point2D[]) => Side
  ): { left: Triangle[], right: Triangle[], edges: BoundaryEdge[] } {
    const vertices = [tri.v1, tri.v2, tri.v3];
    const sides = vertices.map(v => classifyFn(v.x, v.y, path));

    const leftVerts: Point3D[] = [];
    const rightVerts: Point3D[] = [];
    const intersections: Point3D[] = [];

    for (let i = 0; i < 3; i++) {
      const v1 = vertices[i];
      const v2 = vertices[(i + 1) % 3];
      const s1 = sides[i];
      const s2 = sides[(i + 1) % 3];

      if (s1 === Side.LEFT || s1 === Side.ON_PATH) {
        leftVerts.push(v1);
      }
      if (s1 === Side.RIGHT || s1 === Side.ON_PATH) {
        rightVerts.push(v1);
      }

      if ((s1 === Side.LEFT && s2 === Side.RIGHT) ||
        (s1 === Side.RIGHT && s2 === Side.LEFT)) {
        const intersection = this.findEdgePathIntersection(v1, v2, path);
        if (intersection) {
          leftVerts.push(intersection);
          rightVerts.push(intersection);
          intersections.push(intersection);
        }
      }
    }

    // Create boundary edge from intersections
    const edges: BoundaryEdge[] = [];
    if (intersections.length === 2) {
      edges.push({ p1: intersections[0], p2: intersections[1] });
    }

    return {
      left: this.triangulatePolygon(leftVerts, tri.normal),
      right: this.triangulatePolygon(rightVerts, tri.normal),
      edges
    };
  }

  /**
   * Connect boundary edges into polylines
   */
  private buildBoundaryPolylines(edges: BoundaryEdge[]): Point3D[][] {
    if (edges.length === 0) return [];

    const remaining = [...edges];
    const polylines: Point3D[][] = [];

    while (remaining.length > 0) {
      const polyline: Point3D[] = [];
      const edge = remaining.shift()!;
      polyline.push(edge.p1, edge.p2);

      let extended = true;
      while (extended && remaining.length > 0) {
        extended = false;
        const lastPoint = polyline[polyline.length - 1];

        for (let i = 0; i < remaining.length; i++) {
          const e = remaining[i];
          if (this.pointsClose(lastPoint, e.p1)) {
            polyline.push(e.p2);
            remaining.splice(i, 1);
            extended = true;
            break;
          } else if (this.pointsClose(lastPoint, e.p2)) {
            polyline.push(e.p1);
            remaining.splice(i, 1);
            extended = true;
            break;
          }
        }
      }

      // Also try extending from the front
      extended = true;
      while (extended && remaining.length > 0) {
        extended = false;
        const firstPoint = polyline[0];

        for (let i = 0; i < remaining.length; i++) {
          const e = remaining[i];
          if (this.pointsClose(firstPoint, e.p2)) {
            polyline.unshift(e.p1);
            remaining.splice(i, 1);
            extended = true;
            break;
          } else if (this.pointsClose(firstPoint, e.p1)) {
            polyline.unshift(e.p2);
            remaining.splice(i, 1);
            extended = true;
            break;
          }
        }
      }

      if (polyline.length >= 2) {
        polylines.push(polyline);
      }
    }

    return polylines;
  }

  private pointsClose(a: Point3D, b: Point3D): boolean {
    return Math.abs(a.x - b.x) < EPSILON * 10 &&
      Math.abs(a.y - b.y) < EPSILON * 10 &&
      Math.abs(a.z - b.z) < EPSILON * 10;
  }

  /**
   * Generate cap triangles from polyline using fan triangulation
   */
  private generateCapTriangles(
    polyline: Point3D[],
    orientation: 'vertical' | 'horizontal',
    side: 'left' | 'right'
  ): Triangle[] {
    if (polyline.length < 3) return [];

    const triangles: Triangle[] = [];

    // Calculate centroid
    const centroid: Point3D = {
      x: polyline.reduce((sum, p) => sum + p.x, 0) / polyline.length,
      y: polyline.reduce((sum, p) => sum + p.y, 0) / polyline.length,
      z: polyline.reduce((sum, p) => sum + p.z, 0) / polyline.length
    };

    // Determine normal direction based on side and orientation
    let normal: Point3D;
    if (orientation === 'vertical') {
      normal = side === 'left' ? { x: -1, y: 0, z: 0 } : { x: 1, y: 0, z: 0 };
    } else {
      normal = side === 'left' ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
    }

    // Fan triangulation from centroid
    for (let i = 0; i < polyline.length - 1; i++) {
      const p1 = polyline[i];
      const p2 = polyline[i + 1];

      // Winding order depends on normal direction
      if (side === 'left') {
        triangles.push({ v1: centroid, v2: p1, v3: p2, normal });
      } else {
        triangles.push({ v1: centroid, v2: p2, v3: p1, normal });
      }
    }

    return triangles;
  }
}

