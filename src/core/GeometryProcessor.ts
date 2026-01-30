import fs from 'fs';
import Module, { Manifold, ManifoldToplevel, CrossSection } from 'manifold-3d';
import { ManifoldDiagnostic, sanitizePath, PathAnalysis } from '../diag/ManifoldDiagnostic';

export class GeometryProcessor {
    private wasm: ManifoldToplevel | null = null;
    private verbose: boolean = false;
    private diagnostic: ManifoldDiagnostic;

    constructor(verbose: boolean = false) {
        this.verbose = verbose;
        this.diagnostic = new ManifoldDiagnostic(verbose);
    }

    async init() {
        if (!this.wasm) {
            this.wasm = await Module();
            this.wasm.setup();
        }
    }

    public async loadMesh(stlPath: string): Promise<Manifold> {
        if (!this.wasm) await this.init();
        if (this.verbose) console.log(`📦 Loading mesh: ${stlPath}`);
        return this.loadStl(stlPath);
    }

    public saveMesh(mesh: Manifold, path: string) {
        if (this.verbose) console.log(`💾 Saving: ${path}`);
        this.saveStl(mesh, path);
    }

    // --- TAGLIO VERTICALE ---
    async sliceVertical(
        meshOriginal: Manifold,
        cutPathMm: { x: number, y: number }[],
        bounds: { min: number[], max: number[] },
        toleranceMm: number,
        safeMode: boolean
    ): Promise<{ left: Manifold, right: Manifold }> {

        // Se siamo già in safe mode, andiamo diretti
        if (safeMode) {
            if (this.verbose) console.log("🔒 Safe Mode: Parametri robusti diretti (No Smooth, 0.5 Clean)");
            return await this.sliceVerticalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.5);
        }

        // LIVELLO 1: Qualità Alta (Modificato a 0.35mm per stabilità)
        try {
            if (this.verbose) console.log("🌟 Tentativo Qualità Alta (Smooth 2, Clean 0.35)...");
            return await this.sliceVerticalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 2, 0.35);
        } catch (e: any) {
            // Logga dettagli errore
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Livello 1 fallito: ${errMsg}`);
            if (this.verbose) {
                const pathAnalysis = this.diagnostic.analyzePath(cutPathMm);
                console.warn(`   Path info: ${pathAnalysis.totalPoints} punti, ${pathAnalysis.microSegments} micro-seg, ${pathAnalysis.selfIntersections} self-int`);
            }
        }

        // LIVELLO 2: Qualità Media (No Smooth, Clean 0.35)
        try {
            if (this.verbose) console.log("🔸 Tentativo Qualità Media (No Smooth, Clean 0.35)...");
            return await this.sliceVerticalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.35);
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Livello 2 fallito: ${errMsg}`);
        }

        // LIVELLO 3: Safe Mode 
        try {
            if (this.verbose) console.log("🔧 Tentativo Safe Mode (No Smooth, Clean 0.5)...");
            return await this.sliceVerticalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.5);
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Livello 3 (Safe) fallito: ${errMsg}`);
        }

        // LIVELLO 4: Ultra-Safe Mode - usa un path drasticamente semplificato (linea retta)
        // Passiamo clean=0 perché la linea retta non ha bisogno di pulizia
        if (this.verbose) console.log("🔒 Tentativo Ultra-Safe: Path semplificato a linea retta...");
        const straightLinePath = this.createStraightLinePath(cutPathMm, bounds);
        return await this.sliceVerticalInternal(meshOriginal, straightLinePath, bounds, toleranceMm, 0, 0);
    }

    /**
     * Crea un path rettilineo semplificato usando solo i punti estremi
     */
    private createStraightLinePath(
        originalPath: { x: number, y: number }[],
        bounds: { min: number[], max: number[] }
    ): { x: number, y: number }[] {
        // Per tagli verticali, calcola la X media e crea una linea retta Y
        const avgX = originalPath.reduce((sum, p) => sum + p.x, 0) / originalPath.length;
        const minY = bounds.min[1] - 10; // Estendi oltre i bounds
        const maxY = bounds.max[1] + 10;

        // Crea più punti per evitare "percorso troppo breve" dopo la pulizia
        const numPoints = 20;
        const result: { x: number, y: number }[] = [];
        for (let i = 0; i < numPoints; i++) {
            result.push({
                x: avgX,
                y: minY + (maxY - minY) * (i / (numPoints - 1))
            });
        }

        if (this.verbose) {
            console.log(`   -> Path ridotto da ${originalPath.length} a ${result.length} punti (linea retta a X=${avgX.toFixed(1)})`);
        }
        return result;
    }

    private async sliceVerticalInternal(
        meshOriginal: Manifold,
        cutPathMm: { x: number, y: number }[],
        bounds: { min: number[], max: number[] },
        toleranceMm: number,
        smoothingIterations: number,
        cleanDistance: number
    ): Promise<{ left: Manifold, right: Manifold }> {

        if (!this.wasm) await this.init();
        const m = this.wasm!;

        // PRE-VALIDATION: Analizza il path prima di processarlo
        const preAnalysis = this.diagnostic.analyzePath(cutPathMm);
        let effectiveCleanDistance = cleanDistance;
        let effectiveSmoothIterations = smoothingIterations;

        // Se ci sono troppi micro-segmenti o self-intersections, usa parametri più aggressivi
        if (preAnalysis.microSegments > 5 || preAnalysis.selfIntersections > 0) {
            if (this.verbose) {
                console.warn(`   ⚠️ Path problematico rilevato: ${preAnalysis.microSegments} micro-seg, ${preAnalysis.selfIntersections} self-int`);
                console.warn(`   🔧 Applico pulizia aggressiva...`);
            }
            effectiveCleanDistance = Math.max(cleanDistance, 0.5);
            effectiveSmoothIterations = 0; // Disabilita smoothing che può creare più problemi
        }

        // Se cleanDistance == 0, skip tutte le trasformazioni (path pre-costruito come linea retta)
        let pathProcessed: { x: number, y: number }[];
        if (effectiveCleanDistance === 0) {
            pathProcessed = cutPathMm;
            if (this.verbose) console.log(`   -> Punti Path: ${pathProcessed.length} (bypass: path pre-costruito)`);
        } else {
            pathProcessed = this.simplifyPath(cutPathMm, 0.5);
            if (effectiveSmoothIterations > 0) pathProcessed = this.smoothPath(pathProcessed, effectiveSmoothIterations);
            pathProcessed = this.cleanPath(pathProcessed, effectiveCleanDistance);
            if (this.verbose) console.log(`   -> Punti Path: ${pathProcessed.length} (Smooth: ${effectiveSmoothIterations}, Clean: ${effectiveCleanDistance})`);
        }

        if (pathProcessed.length < 3) throw new Error("Percorso troppo breve.");

        let leftCS: CrossSection | null = null;
        let rightCS: CrossSection | null = null;
        let leftTool: Manifold | null = null;
        let rightTool: Manifold | null = null;
        let leftToolMoved: Manifold | null = null;
        let rightToolMoved: Manifold | null = null;

        try {
            const farLeft = bounds.min[0] - 50;
            const farRight = bounds.max[0] + 50;
            const hugeZ = 500.0;
            const halfGap = toleranceMm / 2;

            const leftPoly = this.createSidePolygon(pathProcessed, farLeft, halfGap, true);
            const rightPoly = this.createSidePolygon(pathProcessed, farRight, halfGap, false);

            leftCS = new (m as any).CrossSection([leftPoly]);
            rightCS = new (m as any).CrossSection([rightPoly]);

            leftTool = leftCS!.extrude(hugeZ, 0, 0, [1, 1]);
            rightTool = rightCS!.extrude(hugeZ, 0, 0, [1, 1]);

            const zStart = bounds.min[2] - 50.0;
            leftToolMoved = leftTool!.translate([0, 0, zStart]);
            rightToolMoved = rightTool!.translate([0, 0, zStart]);

            if (this.verbose) {
                this.saveStl(leftToolMoved!, `DEBUG_TOOL_V_${Date.now()}.stl`);
            }

            if (this.verbose) console.log(`   🔍 Eseguendo intersect...`);
            const resultLeft = meshOriginal.intersect(leftToolMoved!);
            const resultRight = meshOriginal.intersect(rightToolMoved!);

            // VALIDAZIONE RISULTATI: verifica che i risultati siano validi prima di restituirli
            if (this.verbose) console.log(`   ✅ Intersect completato. Validazione risultati...`);
            try {
                const leftTri = resultLeft.numTri();
                const rightTri = resultRight.numTri();
                if (this.verbose) console.log(`   📐 Risultato: Left=${leftTri} tri, Right=${rightTri} tri`);
            } catch (validationError: any) {
                console.error(`   ❌ Validazione fallita: ${validationError?.message || validationError}`);
                throw validationError; // Re-throw per far scattare i livelli successivi
            }

            return { left: resultLeft, right: resultRight };

        } finally {
            // SAFE DELETE: Avvolgiamo le cancellazioni in try/catch.
            // Se WASM è corrotto, delete() potrebbe lanciare eccezioni che mascherano l'errore originale.
            try { if (leftCS) leftCS.delete(); } catch (e) { }
            try { if (rightCS) rightCS.delete(); } catch (e) { }
            try { if (leftTool) leftTool.delete(); } catch (e) { }
            try { if (rightTool) rightTool.delete(); } catch (e) { }
            try { if (leftToolMoved) leftToolMoved.delete(); } catch (e) { }
            try { if (rightToolMoved) rightToolMoved.delete(); } catch (e) { }
        }
    }

    // --- TAGLIO ORIZZONTALE ---
    async sliceHorizontal(
        meshOriginal: Manifold,
        cutPathMm: { x: number, y: number }[],
        bounds: { min: number[], max: number[] },
        toleranceMm: number,
        safeMode: boolean
    ): Promise<{ top: Manifold, bottom: Manifold }> {

        if (safeMode) {
            if (this.verbose) console.log("🔒 Safe Mode: Orizzontale (No Smooth, 0.5 Clean)");
            return await this.sliceHorizontalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.5);
        }

        try {
            if (this.verbose) console.log("🌟 Tentativo Orizzontale Alta Qualità (0.35)...");
            return await this.sliceHorizontalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 2, 0.35);
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Orizzontale L1 fallito: ${errMsg}`);
            if (this.verbose) {
                const pathAnalysis = this.diagnostic.analyzePath(cutPathMm);
                console.warn(`   Path info: ${pathAnalysis.totalPoints} punti, ${pathAnalysis.microSegments} micro-seg, ${pathAnalysis.selfIntersections} self-int`);
            }
        }

        try {
            return await this.sliceHorizontalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.35);
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Orizzontale L2 fallito: ${errMsg}`);
        }

        // LIVELLO 3: Safe Mode
        try {
            if (this.verbose) console.log("🔧 Tentativo Safe Mode Orizzontale (No Smooth, Clean 0.5)...");
            return await this.sliceHorizontalInternal(meshOriginal, cutPathMm, bounds, toleranceMm, 0, 0.5);
        } catch (e: any) {
            const errMsg = e?.message || String(e);
            console.warn(`⚠️  Orizzontale L3 (Safe) fallito: ${errMsg}`);
        }

        // LIVELLO 4: Ultra-Safe Mode - usa un path drasticamente semplificato (linea retta)
        // Passiamo clean=0 perché la linea retta non ha bisogno di pulizia
        if (this.verbose) console.log("🔒 Tentativo Ultra-Safe Orizzontale: Path semplificato a linea retta...");
        const straightLinePath = this.createStraightLinePathHorizontal(cutPathMm, bounds);
        return await this.sliceHorizontalInternal(meshOriginal, straightLinePath, bounds, toleranceMm, 0, 0);
    }

    /**
     * Crea un path rettilineo semplificato per tagli orizzontali (lungo X a Y fissa)
     */
    private createStraightLinePathHorizontal(
        originalPath: { x: number, y: number }[],
        bounds: { min: number[], max: number[] }
    ): { x: number, y: number }[] {
        // Per tagli orizzontali, calcola la Y media e crea una linea retta lungo X
        const avgY = originalPath.reduce((sum, p) => sum + p.y, 0) / originalPath.length;
        const minX = bounds.min[0] - 10; // Estendi oltre i bounds
        const maxX = bounds.max[0] + 10;

        // Crea più punti per evitare "percorso troppo breve" dopo la pulizia
        const numPoints = 20;
        const result: { x: number, y: number }[] = [];
        for (let i = 0; i < numPoints; i++) {
            result.push({
                x: minX + (maxX - minX) * (i / (numPoints - 1)),
                y: avgY
            });
        }

        if (this.verbose) {
            console.log(`   -> Path ridotto da ${originalPath.length} a ${result.length} punti (linea retta a Y=${avgY.toFixed(1)})`);
        }
        return result;
    }

    private async sliceHorizontalInternal(
        meshOriginal: Manifold,
        cutPathMm: { x: number, y: number }[],
        bounds: { min: number[], max: number[] },
        toleranceMm: number,
        smoothingIterations: number,
        cleanDistance: number
    ): Promise<{ top: Manifold, bottom: Manifold }> {

        if (!this.wasm) await this.init();
        const m = this.wasm!;

        // PRE-VALIDATION: Analizza il path prima di processarlo
        const preAnalysis = this.diagnostic.analyzePath(cutPathMm);
        let effectiveCleanDistance = cleanDistance;
        let effectiveSmoothIterations = smoothingIterations;

        // Se ci sono troppi micro-segmenti o self-intersections, usa parametri più aggressivi
        if (preAnalysis.microSegments > 5 || preAnalysis.selfIntersections > 0) {
            if (this.verbose) {
                console.warn(`   ⚠️ Path problematico rilevato: ${preAnalysis.microSegments} micro-seg, ${preAnalysis.selfIntersections} self-int`);
                console.warn(`   🔧 Applico pulizia aggressiva...`);
            }
            effectiveCleanDistance = Math.max(cleanDistance, 0.5);
            effectiveSmoothIterations = 0;
        }

        // Se cleanDistance == 0, skip tutte le trasformazioni (path pre-costruito come linea retta)
        let pathProcessed: { x: number, y: number }[];
        if (effectiveCleanDistance === 0) {
            pathProcessed = cutPathMm;
            if (this.verbose) console.log(`   -> Punti Path: ${pathProcessed.length} (bypass: path pre-costruito)`);
        } else {
            pathProcessed = this.simplifyPath(cutPathMm, 0.5);
            if (effectiveSmoothIterations > 0) pathProcessed = this.smoothPath(pathProcessed, effectiveSmoothIterations);
            pathProcessed = this.cleanPath(pathProcessed, effectiveCleanDistance);
            if (this.verbose) console.log(`   -> Punti Path: ${pathProcessed.length} (Smooth: ${effectiveSmoothIterations}, Clean: ${effectiveCleanDistance})`);
        }

        let topCS: CrossSection | null = null;
        let bottomCS: CrossSection | null = null;
        let topTool: Manifold | null = null;
        let bottomTool: Manifold | null = null;
        let topToolMoved: Manifold | null = null;
        let bottomToolMoved: Manifold | null = null;

        try {
            const farTop = bounds.max[1] + 50;
            const farBottom = bounds.min[1] - 50;
            const hugeZ = 500.0;
            const halfGap = toleranceMm / 2;

            const topPoly = this.createHorizontalPolygon(pathProcessed, farTop, halfGap, true);
            const bottomPoly = this.createHorizontalPolygon(pathProcessed, farBottom, halfGap, false);

            topCS = new (m as any).CrossSection([topPoly]);
            bottomCS = new (m as any).CrossSection([bottomPoly]);

            topTool = topCS!.extrude(hugeZ, 0, 0, [1, 1]);
            bottomTool = bottomCS!.extrude(hugeZ, 0, 0, [1, 1]);

            const zStart = bounds.min[2] - 50.0;
            topToolMoved = topTool!.translate([0, 0, zStart]);
            bottomToolMoved = bottomTool!.translate([0, 0, zStart]);

            if (this.verbose) {
                this.saveStl(topToolMoved!, `DEBUG_TOOL_H_${Date.now()}.stl`);
            }

            const resultTop = meshOriginal.intersect(topToolMoved!);
            const resultBottom = meshOriginal.intersect(bottomToolMoved!);

            return { top: resultTop, bottom: resultBottom };

        } finally {
            // SAFE DELETE
            try { if (topCS) topCS.delete(); } catch (e) { }
            try { if (bottomCS) bottomCS.delete(); } catch (e) { }
            try { if (topTool) topTool.delete(); } catch (e) { }
            try { if (bottomTool) bottomTool.delete(); } catch (e) { }
            try { if (topToolMoved) topToolMoved.delete(); } catch (e) { }
            try { if (bottomToolMoved) bottomToolMoved.delete(); } catch (e) { }
        }
    }

    // --- ALGORITMI (Invariati) ---
    private smoothPath(points: { x: number, y: number }[], iterations: number): { x: number, y: number }[] {
        if (iterations <= 0 || points.length < 3) return points;
        let smoothed = points;
        for (let i = 0; i < iterations; i++) {
            const nextPoints: { x: number, y: number }[] = [];
            nextPoints.push(smoothed[0]);
            for (let j = 0; j < smoothed.length - 1; j++) {
                const p0 = smoothed[j];
                const p1 = smoothed[j + 1];
                const q = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
                const r = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
                nextPoints.push(q);
                nextPoints.push(r);
            }
            nextPoints.push(smoothed[smoothed.length - 1]);
            smoothed = nextPoints;
        }
        return smoothed;
    }

    private cleanPath(points: { x: number, y: number }[], minDist: number): { x: number, y: number }[] {
        if (points.length < 2) return points;
        const cleaned = [points[0]];
        for (let i = 1; i < points.length; i++) {
            const last = cleaned[cleaned.length - 1];
            const curr = points[i];
            const dist = Math.sqrt(Math.pow(curr.x - last.x, 2) + Math.pow(curr.y - last.y, 2));
            if (dist > minDist) {
                cleaned.push(curr);
            }
        }
        const lastOriginal = points[points.length - 1];
        const lastCleaned = cleaned[cleaned.length - 1];
        if (lastCleaned !== lastOriginal) {
            cleaned.push(lastOriginal);
        }
        return cleaned;
    }

    // --- Helpers Geometrici (Invariati) ---
    private createSidePolygon(path: { x: number, y: number }[], limitX: number, gapOffset: number, isLeft: boolean): number[][] {
        const poly: number[][] = [];
        const shiftX = isLeft ? -gapOffset : gapOffset;
        if (isLeft) {
            poly.push([limitX, path[0].y]);
            poly.push([limitX, path[path.length - 1].y]);
            for (let i = path.length - 1; i >= 0; i--) poly.push([path[i].x + shiftX, path[i].y]);
        } else {
            for (let i = 0; i < path.length; i++) poly.push([path[i].x + shiftX, path[i].y]);
            poly.push([limitX, path[path.length - 1].y]);
            poly.push([limitX, path[0].y]);
        }
        return poly;
    }

    private createHorizontalPolygon(path: { x: number, y: number }[], limitY: number, gapOffset: number, isTop: boolean): number[][] {
        const poly: number[][] = [];
        const shiftY = isTop ? gapOffset : -gapOffset;
        if (isTop) {
            for (let i = 0; i < path.length; i++) poly.push([path[i].x, path[i].y + shiftY]);
            poly.push([path[path.length - 1].x, limitY]);
            poly.push([path[0].x, limitY]);
        } else {
            for (let i = path.length - 1; i >= 0; i--) poly.push([path[i].x, path[i].y + shiftY]);
            poly.push([path[0].x, limitY]);
            poly.push([path[path.length - 1].x, limitY]);
        }
        return poly;
    }

    private simplifyPath(points: { x: number, y: number }[], epsilon: number): { x: number, y: number }[] {
        if (points.length <= 2) return points;
        let dmax = 0;
        let index = 0;
        const end = points.length - 1;
        for (let i = 1; i < end; i++) {
            const d = this.perpendicularDistance(points[i], points[0], points[end]);
            if (d > dmax) { index = i; dmax = d; }
        }
        if (dmax > epsilon) {
            const recResults1 = this.simplifyPath(points.slice(0, index + 1), epsilon);
            const recResults2 = this.simplifyPath(points.slice(index, end + 1), epsilon);
            return [...recResults1.slice(0, recResults1.length - 1), ...recResults2];
        } else { return [points[0], points[end]]; }
    }

    private perpendicularDistance(point: { x: number, y: number }, lineStart: { x: number, y: number }, lineEnd: { x: number, y: number }): number {
        let dx = lineEnd.x - lineStart.x;
        let dy = lineEnd.y - lineStart.y;
        if (dx === 0 && dy === 0) return Math.sqrt(Math.pow(point.x - lineStart.x, 2) + Math.pow(point.y - lineStart.y, 2));
        const mag = Math.sqrt(dx * dx + dy * dy);
        return Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x) / mag;
    }

    private loadStl(filePath: string): Manifold {
        const buffer = fs.readFileSync(filePath);
        const numTriangles = buffer.readUInt32LE(80);
        const headerSize = 84;
        const vertMap = new Map<string, number>();
        const vertArray: number[] = [];
        const triVerts: number[] = [];
        let uniqueVertCount = 0;
        for (let i = 0; i < numTriangles; i++) {
            const offset = headerSize + (i * 50);
            for (let v = 0; v < 3; v++) {
                const vOffset = offset + 12 + (v * 12);
                const x = buffer.readFloatLE(vOffset);
                const y = buffer.readFloatLE(vOffset + 4);
                const z = buffer.readFloatLE(vOffset + 8);
                const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
                let idx = vertMap.get(key);
                if (idx === undefined) {
                    idx = uniqueVertCount;
                    vertMap.set(key, idx);
                    vertArray.push(x, y, z);
                    uniqueVertCount++;
                }
                triVerts.push(idx);
            }
        }
        if (this.verbose) console.log(`   Input Triangoli: ${numTriangles}, Vertici Unici: ${uniqueVertCount}`);
        const vertProperties = new Float32Array(vertArray);
        const triVertsArray = new Uint32Array(triVerts);
        const meshObj = { numProp: 3, vertProperties: vertProperties, triVerts: triVertsArray };
        return new this.wasm!.Manifold(meshObj as any);
    }

    private saveStl(manifoldMesh: Manifold, filePath: string) {
        let mesh;
        try { mesh = manifoldMesh.getMesh(); } catch (e) { console.error(`❌ Errore mesh export ${filePath}`); return; }
        const numTriangles = mesh.triVerts.length / 3;
        const bufferSize = 84 + (numTriangles * 50);
        const buffer = Buffer.alloc(bufferSize);
        buffer.write("HueSlicer", 0);
        buffer.writeUInt32LE(numTriangles, 80);
        let offset = 84;
        const verts = mesh.vertProperties;
        for (let i = 0; i < numTriangles; i++) {
            const idx1 = mesh.triVerts[i * 3];
            const idx2 = mesh.triVerts[i * 3 + 1];
            const idx3 = mesh.triVerts[i * 3 + 2];
            buffer.writeFloatLE(0, offset); buffer.writeFloatLE(0, offset + 4); buffer.writeFloatLE(0, offset + 8);
            buffer.writeFloatLE(verts[idx1 * 3], offset + 12); buffer.writeFloatLE(verts[idx1 * 3 + 1], offset + 16); buffer.writeFloatLE(verts[idx1 * 3 + 2], offset + 20);
            buffer.writeFloatLE(verts[idx2 * 3], offset + 24); buffer.writeFloatLE(verts[idx2 * 3 + 1], offset + 28); buffer.writeFloatLE(verts[idx2 * 3 + 2], offset + 32);
            buffer.writeFloatLE(verts[idx3 * 3], offset + 36); buffer.writeFloatLE(verts[idx3 * 3 + 1], offset + 40); buffer.writeFloatLE(verts[idx3 * 3 + 2], offset + 44);
            buffer.writeUInt16LE(0, offset + 48); offset += 50;
        }
        fs.writeFileSync(filePath, buffer);
    }
}