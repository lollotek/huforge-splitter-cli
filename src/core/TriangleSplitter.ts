import { Point3D, Point2D, GeometryUtils } from '../utils/GeometryUtils';

export class TriangleSplitter {
  /**
   * Taglia un triangolo 3D con una linea 2D infinita definita da P1-P2.
   * Ritorna due liste di triangoli: quelli a Sinistra e quelli a Destra.
   */
  static splitTriangleByLine(
    t: [Point3D, Point3D, Point3D],
    lineStart: Point2D,
    lineEnd: Point2D
  ): { left: Point3D[][], right: Point3D[][] } {
    const [v0, v1, v2] = t;

    // Calcola "lato" di ogni vertice (+1 sinistra, -1 destra, 0 collineare)
    const s0 = Math.sign(GeometryUtils.pointSide(v0, lineStart, lineEnd));
    const s1 = Math.sign(GeometryUtils.pointSide(v1, lineStart, lineEnd));
    const s2 = Math.sign(GeometryUtils.pointSide(v2, lineStart, lineEnd));

    // Caso Triviale: Tutto lato sinistro o sulla linea
    if (s0 >= 0 && s1 >= 0 && s2 >= 0) return { left: [[v0, v1, v2]], right: [] };
    // Caso Triviale: Tutto lato destro
    if (s0 <= 0 && s1 <= 0 && s2 <= 0) return { left: [], right: [[v0, v1, v2]] };

    // Caso Misto: Split necessario
    // Trova i 2 spigoli intersecati
    // ... (Implementazione classica Sutherland-Hodgman per 1 triangolo)

    // Cicliamo i vertici per trovare le intersezioni
    const vertices = [v0, v1, v2];
    const signs = [s0, s1, s2];

    const leftPoly: Point3D[] = [];
    const rightPoly: Point3D[] = [];

    for (let i = 0; i < 3; i++) {
      const curr = vertices[i];
      const next = vertices[(i + 1) % 3];
      const currS = signs[i];
      const nextS = signs[(i + 1) % 3];

      // Aggiungi vertice corrente alla lista appropriata
      if (currS >= 0) leftPoly.push(curr);
      else rightPoly.push(curr);

      // Se attraversano la linea, calcola intersezione
      if ((currS > 0 && nextS < 0) || (currS < 0 && nextS > 0)) {
        // Calcola T di intersezione
        const res = GeometryUtils.segmentIntersection(curr, next, lineStart, lineEnd);
        if (res.type === 'point' && res.point) {
          // Trova Z interpolando
          // Segment intersection rida point 2d e T
          // Ma qui segmentIntersection interseca Segmento AB con Segmento CD.
          // Noi vogliamo Linea CD infinita. 
          // Possiamo usare formula diretta intersez retta:

          // Intersect Edge (curr -> next) con Linea (start -> end)
          const intersectPt = this.intersectEdgeInfiniteLine(curr, next, lineStart, lineEnd);
          if (intersectPt) {
            leftPoly.push(intersectPt);
            rightPoly.push(intersectPt);
          }
        }
      }
    }

    // Triangola i poligoni risultanti (possono essere 3-gon o 4-gon)
    return {
      left: this.triangulateConvex(leftPoly),
      right: this.triangulateConvex(rightPoly)
    };
  }

  private static intersectEdgeInfiniteLine(p1: Point3D, p2: Point3D, l1: Point2D, l2: Point2D): Point3D | null {
    // Line equation: Ax + By + C = 0
    const A = l1.y - l2.y;
    const B = l2.x - l1.x;
    const C = -A * l1.x - B * l1.y;

    const d1 = A * p1.x + B * p1.y + C;
    const d2 = A * p2.x + B * p2.y + C;

    if (Math.abs(d1 - d2) < 1e-9) return null; // Paralleli

    const t = d1 / (d1 - d2); // 0..1
    return GeometryUtils.interpolate3D(p1, p2, t);
  }

  private static triangulateConvex(poly: Point3D[]): Point3D[][] {
    if (poly.length < 3) return [];
    if (poly.length === 3) return [[poly[0], poly[1], poly[2]]];
    if (poly.length === 4) {
      // Quad -> 2 Triangles
      return [
        [poly[0], poly[1], poly[2]],
        [poly[0], poly[2], poly[3]]
      ];
    }
    return []; // Should not happen for 1-triangle cut
  }
}
