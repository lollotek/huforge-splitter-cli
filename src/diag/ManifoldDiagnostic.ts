/**
 * ManifoldDiagnostic - Tool per diagnosticare errori manifold-3d
 * 
 * Questo modulo fornisce funzionalità per:
 * 1. Catturare e analizzare errori WASM
 * 2. Validare geometrie prima delle operazioni booleane
 * 3. Rilevare condizioni che causano crash
 * 4. Suggerire fix per path problematici
 */

import { Manifold, CrossSection } from 'manifold-3d';

export interface DiagnosticResult {
  success: boolean;
  errorType?: ManifoldErrorType;
  errorMessage?: string;
  errorStack?: string;
  pathAnalysis?: PathAnalysis;
  geometryAnalysis?: GeometryAnalysis;
  suggestions?: string[];
}

export enum ManifoldErrorType {
  WASM_TRAP = 'WASM_TRAP',
  DEGENERATE_GEOMETRY = 'DEGENERATE_GEOMETRY',
  SELF_INTERSECTION = 'SELF_INTERSECTION',
  MICRO_SEGMENT = 'MICRO_SEGMENT',
  INVALID_POLYGON = 'INVALID_POLYGON',
  EMPTY_RESULT = 'EMPTY_RESULT',
  MEMORY_ERROR = 'MEMORY_ERROR',
  UNKNOWN = 'UNKNOWN'
}

export interface PathAnalysis {
  totalPoints: number;
  uniquePoints: number;
  duplicatePoints: number;
  minSegmentLength: number;
  maxSegmentLength: number;
  avgSegmentLength: number;
  microSegments: number;  // Segmenti < 0.1mm
  sharpAngles: number;    // Angoli < 15°
  selfIntersections: number;
  boundingBox: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  };
}

export interface GeometryAnalysis {
  triangleCount: number;
  vertexCount: number;
  isManifold: boolean;
  volume: number;
  surfaceArea: number;
  boundingBox: {
    min: number[];
    max: number[];
  };
}

export class ManifoldDiagnostic {
  private verbose: boolean;
  private errorLog: DiagnosticResult[] = [];

  constructor(verbose: boolean = true) {
    this.verbose = verbose;
  }

  /**
   * Analizza un path per identificare potenziali problemi prima dell'estrusione
   */
  analyzePath(path: { x: number, y: number }[]): PathAnalysis {
    if (path.length < 2) {
      return this.createEmptyPathAnalysis();
    }

    const segments: number[] = [];
    const angles: number[] = [];
    const pointSet = new Set<string>();
    let duplicatePoints = 0;
    let selfIntersections = 0;

    // Calcola statistiche per ogni segmento
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;

      if (pointSet.has(key)) {
        duplicatePoints++;
      } else {
        pointSet.add(key);
      }

      if (i > 0) {
        const prev = path[i - 1];
        const dist = Math.sqrt(
          Math.pow(p.x - prev.x, 2) + Math.pow(p.y - prev.y, 2)
        );
        segments.push(dist);
      }

      // Calcola angoli (per i punti non agli estremi)
      if (i > 0 && i < path.length - 1) {
        const prev = path[i - 1];
        const next = path[i + 1];
        const angle = this.calculateAngle(prev, p, next);
        angles.push(angle);
      }
    }

    // Conta self-intersections (O(n²) - solo per diagnostica)
    selfIntersections = this.countIntersections(path);

    // Bounding box
    const xs = path.map(p => p.x);
    const ys = path.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const analysis: PathAnalysis = {
      totalPoints: path.length,
      uniquePoints: pointSet.size,
      duplicatePoints,
      minSegmentLength: segments.length > 0 ? Math.min(...segments) : 0,
      maxSegmentLength: segments.length > 0 ? Math.max(...segments) : 0,
      avgSegmentLength: segments.length > 0
        ? segments.reduce((a, b) => a + b, 0) / segments.length
        : 0,
      microSegments: segments.filter(s => s < 0.1).length,
      sharpAngles: angles.filter(a => a < 15).length,
      selfIntersections,
      boundingBox: {
        minX, maxX, minY, maxY,
        width: maxX - minX,
        height: maxY - minY
      }
    };

    if (this.verbose) {
      this.logPathAnalysis(analysis);
    }

    return analysis;
  }

  /**
   * Analizza un oggetto Manifold per identificare potenziali problemi
   */
  analyzeGeometry(mesh: Manifold): GeometryAnalysis | null {
    try {
      const bounds = mesh.boundingBox();
      const meshData = mesh.getMesh();
      const props = mesh.getProperties();

      return {
        triangleCount: mesh.numTri(),
        vertexCount: meshData.vertProperties.length / 3,
        isManifold: mesh.numEdge() > 0, // Proxy per manifoldness
        volume: Math.abs(props.volume),
        surfaceArea: props.surfaceArea,
        boundingBox: {
          min: [bounds.min[0], bounds.min[1], bounds.min[2]],
          max: [bounds.max[0], bounds.max[1], bounds.max[2]]
        }
      };
    } catch (e) {
      if (this.verbose) {
        console.error('❌ Errore durante analisi geometria:', e);
      }
      return null;
    }
  }

  /**
   * Wrapper diagnostico per operazioni manifold
   * Cattura e classifica gli errori
   */
  async wrapOperation<T>(
    operationName: string,
    operation: () => T | Promise<T>,
    context?: { path?: { x: number, y: number }[], mesh?: Manifold }
  ): Promise<{ result: T | null, diagnostic: DiagnosticResult }> {

    const startTime = Date.now();
    let pathAnalysis: PathAnalysis | undefined;
    let geometryAnalysis: GeometryAnalysis | undefined;

    // Pre-analisi se disponibile il contesto
    if (context?.path) {
      pathAnalysis = this.analyzePath(context.path);
    }
    if (context?.mesh) {
      geometryAnalysis = this.analyzeGeometry(context.mesh) ?? undefined;
    }

    try {
      const result = await operation();
      const elapsed = Date.now() - startTime;

      if (this.verbose) {
        console.log(`✅ ${operationName} completato in ${elapsed}ms`);
      }

      return {
        result,
        diagnostic: {
          success: true,
          pathAnalysis,
          geometryAnalysis
        }
      };
    } catch (e: any) {
      const elapsed = Date.now() - startTime;
      const errorMessage = e?.message || String(e);
      const errorStack = e?.stack;

      // Classifica l'errore
      const errorType = this.classifyError(errorMessage);
      const suggestions = this.generateSuggestions(errorType, pathAnalysis, geometryAnalysis);

      const diagnostic: DiagnosticResult = {
        success: false,
        errorType,
        errorMessage,
        errorStack,
        pathAnalysis,
        geometryAnalysis,
        suggestions
      };

      this.errorLog.push(diagnostic);

      if (this.verbose) {
        console.error(`\n${'='.repeat(60)}`);
        console.error(`❌ ERRORE MANIFOLD: ${operationName}`);
        console.error(`${'='.repeat(60)}`);
        console.error(`Tipo: ${errorType}`);
        console.error(`Messaggio: ${errorMessage}`);
        console.error(`Tempo trascorso: ${elapsed}ms`);

        if (pathAnalysis) {
          console.error('\n📊 Analisi Path:');
          console.error(`   - Punti: ${pathAnalysis.totalPoints}`);
          console.error(`   - Micro-segmenti (<0.1mm): ${pathAnalysis.microSegments}`);
          console.error(`   - Angoli acuti (<15°): ${pathAnalysis.sharpAngles}`);
          console.error(`   - Self-intersections: ${pathAnalysis.selfIntersections}`);
          console.error(`   - Segmento più corto: ${pathAnalysis.minSegmentLength.toFixed(4)}mm`);
        }

        if (suggestions.length > 0) {
          console.error('\n💡 Suggerimenti:');
          suggestions.forEach((s, i) => console.error(`   ${i + 1}. ${s}`));
        }
        console.error(`${'='.repeat(60)}\n`);
      }

      return { result: null, diagnostic };
    }
  }

  /**
   * Classifica il tipo di errore in base al messaggio
   */
  private classifyError(message: string): ManifoldErrorType {
    const msgLower = message.toLowerCase();

    if (msgLower.includes('unreachable') || msgLower.includes('wasm')) {
      return ManifoldErrorType.WASM_TRAP;
    }
    if (msgLower.includes('degenerate') || msgLower.includes('zero area')) {
      return ManifoldErrorType.DEGENERATE_GEOMETRY;
    }
    if (msgLower.includes('self-intersect') || msgLower.includes('self intersect')) {
      return ManifoldErrorType.SELF_INTERSECTION;
    }
    if (msgLower.includes('empty') || msgLower.includes('no triangle')) {
      return ManifoldErrorType.EMPTY_RESULT;
    }
    if (msgLower.includes('memory') || msgLower.includes('out of')) {
      return ManifoldErrorType.MEMORY_ERROR;
    }
    if (msgLower.includes('invalid') || msgLower.includes('polygon')) {
      return ManifoldErrorType.INVALID_POLYGON;
    }

    return ManifoldErrorType.UNKNOWN;
  }

  /**
   * Genera suggerimenti basati sul tipo di errore e l'analisi
   */
  private generateSuggestions(
    errorType: ManifoldErrorType,
    pathAnalysis?: PathAnalysis,
    geometryAnalysis?: GeometryAnalysis
  ): string[] {
    const suggestions: string[] = [];

    switch (errorType) {
      case ManifoldErrorType.WASM_TRAP:
        suggestions.push('Prova la modalità --safe per usare parametri più robusti');
        suggestions.push('Aumenta il valore di cleanDistance (es. 0.5mm o più)');
        if (pathAnalysis?.microSegments && pathAnalysis.microSegments > 0) {
          suggestions.push(`Rimuovi i ${pathAnalysis.microSegments} micro-segmenti nel path`);
        }
        break;

      case ManifoldErrorType.DEGENERATE_GEOMETRY:
        suggestions.push('Il path contiene geometria degenerata (area zero o linee sovrapposte)');
        if (pathAnalysis?.duplicatePoints && pathAnalysis.duplicatePoints > 0) {
          suggestions.push(`Rimuovi i ${pathAnalysis.duplicatePoints} punti duplicati`);
        }
        break;

      case ManifoldErrorType.SELF_INTERSECTION:
        suggestions.push('Il path si auto-interseca, semplifica il percorso');
        if (pathAnalysis?.selfIntersections !== undefined) {
          suggestions.push(`Trovate ${pathAnalysis.selfIntersections} self-intersections`);
        }
        break;

      case ManifoldErrorType.MICRO_SEGMENT:
        suggestions.push('Aumenta la distanza minima tra punti (cleanPath)');
        suggestions.push('Riduci le iterazioni di smoothing');
        break;

      case ManifoldErrorType.INVALID_POLYGON:
        suggestions.push('Il poligono non è valido, verifica avvolgimento (winding)');
        suggestions.push('Assicurati che il path abbia almeno 3 punti distinti');
        break;

      case ManifoldErrorType.EMPTY_RESULT:
        suggestions.push("L'intersezione ha prodotto risultato vuoto");
        suggestions.push('Verifica che il path attraversi effettivamente la mesh');
        break;

      default:
        suggestions.push('Errore non classificato - controlla i log dettagliati');
        if (pathAnalysis?.sharpAngles && pathAnalysis.sharpAngles > 5) {
          suggestions.push(`Riduci i ${pathAnalysis.sharpAngles} angoli molto acuti nel path`);
        }
    }

    return suggestions;
  }

  /**
   * Calcola l'angolo tra tre punti (in gradi)
   */
  private calculateAngle(
    p1: { x: number, y: number },
    vertex: { x: number, y: number },
    p2: { x: number, y: number }
  ): number {
    const v1 = { x: p1.x - vertex.x, y: p1.y - vertex.y };
    const v2 = { x: p2.x - vertex.x, y: p2.y - vertex.y };

    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
    const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);

    if (mag1 === 0 || mag2 === 0) return 0;

    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosAngle) * (180 / Math.PI);
  }

  /**
   * Conta le self-intersections in un path
   */
  private countIntersections(path: { x: number, y: number }[]): number {
    let count = 0;

    for (let i = 0; i < path.length - 1; i++) {
      for (let j = i + 2; j < path.length - 1; j++) {
        // Evita di controllare segmenti adiacenti
        if (j === i + 1) continue;

        if (this.segmentsIntersect(
          path[i], path[i + 1],
          path[j], path[j + 1]
        )) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Verifica se due segmenti si intersecano
   */
  private segmentsIntersect(
    a1: { x: number, y: number },
    a2: { x: number, y: number },
    b1: { x: number, y: number },
    b2: { x: number, y: number }
  ): boolean {
    const ccw = (A: { x: number, y: number }, B: { x: number, y: number }, C: { x: number, y: number }) => {
      return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    };

    return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
  }

  /**
   * Stima il volume di una mesh (approssimazione)
   */
  private estimateVolume(mesh: Manifold): number {
    try {
      // Manifold calcola il volume signed
      const props = mesh.getProperties();
      return Math.abs(props.volume);
    } catch {
      return 0;
    }
  }

  /**
   * Log formattato dell'analisi path
   */
  private logPathAnalysis(analysis: PathAnalysis): void {
    console.log('\n📏 Path Analysis:');
    console.log(`   Punti totali: ${analysis.totalPoints} (unici: ${analysis.uniquePoints})`);
    console.log(`   Segmenti: min=${analysis.minSegmentLength.toFixed(3)}mm, max=${analysis.maxSegmentLength.toFixed(3)}mm, avg=${analysis.avgSegmentLength.toFixed(3)}mm`);
    console.log(`   Problemi potenziali: ${analysis.microSegments} micro-segmenti, ${analysis.sharpAngles} angoli acuti, ${analysis.selfIntersections} self-intersections`);
    console.log(`   BBox: ${analysis.boundingBox.width.toFixed(2)}x${analysis.boundingBox.height.toFixed(2)}mm`);
  }

  private createEmptyPathAnalysis(): PathAnalysis {
    return {
      totalPoints: 0,
      uniquePoints: 0,
      duplicatePoints: 0,
      minSegmentLength: 0,
      maxSegmentLength: 0,
      avgSegmentLength: 0,
      microSegments: 0,
      sharpAngles: 0,
      selfIntersections: 0,
      boundingBox: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 }
    };
  }

  /**
   * Ottieni il log di tutti gli errori
   */
  getErrorLog(): DiagnosticResult[] {
    return [...this.errorLog];
  }

  /**
   * Genera un report completo degli errori
   */
  generateReport(): string {
    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║            MANIFOLD DIAGNOSTIC REPORT                        ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      `Errori totali: ${this.errorLog.length}`,
      ''
    ];

    const errorTypeCount = new Map<ManifoldErrorType, number>();
    this.errorLog.forEach(e => {
      const type = e.errorType || ManifoldErrorType.UNKNOWN;
      errorTypeCount.set(type, (errorTypeCount.get(type) || 0) + 1);
    });

    lines.push('Distribuzione errori:');
    errorTypeCount.forEach((count, type) => {
      lines.push(`  - ${type}: ${count}`);
    });

    lines.push('');
    lines.push('Dettagli errori:');

    this.errorLog.forEach((e, i) => {
      lines.push(`\n--- Errore ${i + 1} ---`);
      lines.push(`Tipo: ${e.errorType}`);
      lines.push(`Messaggio: ${e.errorMessage}`);
      if (e.suggestions && e.suggestions.length > 0) {
        lines.push('Suggerimenti:');
        e.suggestions.forEach(s => lines.push(`  • ${s}`));
      }
    });

    return lines.join('\n');
  }

  /**
   * Pulisce il log degli errori
   */
  clearErrorLog(): void {
    this.errorLog = [];
  }
}

/**
 * Path sanitizer - pulisce un path per renderlo più robusto
 */
export function sanitizePath(
  path: { x: number, y: number }[],
  options: {
    minSegmentLength?: number;
    removeDuplicates?: boolean;
    maxPoints?: number;
  } = {}
): { x: number, y: number }[] {
  const {
    minSegmentLength = 0.1,
    removeDuplicates = true,
    maxPoints = 5000
  } = options;

  if (path.length < 2) return path;

  let result = [...path];

  // 1. Rimuovi duplicati
  if (removeDuplicates) {
    const seen = new Set<string>();
    result = result.filter(p => {
      const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 2. Rimuovi micro-segmenti
  if (minSegmentLength > 0) {
    const cleaned: { x: number, y: number }[] = [result[0]];
    for (let i = 1; i < result.length; i++) {
      const last = cleaned[cleaned.length - 1];
      const curr = result[i];
      const dist = Math.sqrt(
        Math.pow(curr.x - last.x, 2) + Math.pow(curr.y - last.y, 2)
      );
      if (dist >= minSegmentLength) {
        cleaned.push(curr);
      }
    }
    // Assicura che l'ultimo punto sia incluso
    if (cleaned[cleaned.length - 1] !== result[result.length - 1]) {
      cleaned.push(result[result.length - 1]);
    }
    result = cleaned;
  }

  // 3. Limita numero punti
  if (result.length > maxPoints) {
    const step = Math.ceil(result.length / maxPoints);
    result = result.filter((_, i) => i % step === 0 || i === result.length - 1);
  }

  return result;
}
