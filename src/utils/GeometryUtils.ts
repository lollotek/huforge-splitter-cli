export type Point2D = { x: number, y: number };
export type Point3D = { x: number, y: number, z: number };

/**
 * Risultato intersezione segmento-segmento 2D
 */
export type IntersectionResult = {
  type: 'none' | 'point' | 'collinear';
  point?: Point2D;
  t?: number; // Parametro (0..1) sul primo segmento
  u?: number; // Parametro (0..1) sul secondo segmento
};

export class GeometryUtils {
  /**
   * Calcola intersezione tra due segmenti AB e CD in 2D (XY plane)
   */
  static segmentIntersection(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): IntersectionResult {
    const x1 = p1.x, y1 = p1.y;
    const x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y;
    const x4 = p4.x, y4 = p4.y;

    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);

    if (denom === 0) {
      return { type: 'none' }; // Paralleli o collineari (ignoriamo collineari per semplicità slicing)
    }

    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
      return {
        type: 'point',
        point: {
          x: x1 + ua * (x2 - x1),
          y: y1 + ua * (y2 - y1)
        },
        t: ua,
        u: ub
      };
    }

    return { type: 'none' };
  }

  /**
   * Interpola linearmente tra due punti 3D dato un fattore t (0..1)
   */
  static interpolate3D(p1: Point3D, p2: Point3D, t: number): Point3D {
    return {
      x: p1.x + (p2.x - p1.x) * t,
      y: p1.y + (p2.y - p1.y) * t,
      z: p1.z + (p2.z - p1.z) * t
    };
  }

  /**
   * Verifica se un punto è "a sinistra" di un segmento orientato AB (prodotto vettoriale 2D/determinante)
   * > 0: Sinistra (Inside)
   * < 0: Destra (Outside)
   * = 0: Collineare
   */
  static pointSide(p: Point2D, a: Point2D, b: Point2D): number {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  }
}
