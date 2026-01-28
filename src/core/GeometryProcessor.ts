import fs from 'fs';
import Module, { Manifold, ManifoldToplevel, CrossSection } from 'manifold-3d';

export class GeometryProcessor {
    private wasm: ManifoldToplevel | null = null;

    async init() {
        if (!this.wasm) {
            this.wasm = await Module();
            this.wasm.setup();
        }
    }

    public async loadMesh(stlPath: string): Promise<Manifold> {
        if (!this.wasm) await this.init();
        console.log(`📦 Loading mesh: ${stlPath}`);
        return this.loadStl(stlPath);
    }

    public saveMesh(mesh: Manifold, path: string) {
        console.log(`💾 Saving: ${path}`);
        this.saveStl(mesh, path);
    }

    // --- TAGLIO VERTICALE ---
    async sliceVertical(
        meshOriginal: Manifold,
        cutPathMm: {x: number, y: number}[],
        bounds: {min: number[], max: number[]},
        toleranceMm: number
    ): Promise<{left: Manifold, right: Manifold}> {
        
        if (!this.wasm) await this.init();
        const m = this.wasm!;
        
        const pathSimple = this.simplifyPath(cutPathMm, 0.5);
        
        // Parametri geometrici
        const farLeft = bounds.min[0] - 50; 
        const farRight = bounds.max[0] + 50;
        const depthMm = bounds.max[2] - bounds.min[2];
        const hugeZ = 500.0; // depthMm * 3; 
        const halfGap = toleranceMm / 2;

        // 1. Creazione Poligoni
        const leftPoly = this.createSidePolygon(pathSimple, farLeft, halfGap, true);
        const rightPoly = this.createSidePolygon(pathSimple, farRight, halfGap, false);

        // 2. Creazione CrossSections (WASM Objects -> Devono essere liberati)
        const leftCS = new (m as any).CrossSection([leftPoly]);
        const rightCS = new (m as any).CrossSection([rightPoly]);
        
        // 3. Estrusione (WASM Objects -> Liberare)
        let leftTool = leftCS.extrude(hugeZ, 0, 0, [1, 1]);
        let rightTool = rightCS.extrude(hugeZ, 0, 0, [1, 1]);

        // Traslazione
        const zStart = bounds.min[2] - 5.0; 
        const leftToolMoved = leftTool.translate([0, 0, zStart]);
        const rightToolMoved = rightTool.translate([0, 0, zStart]);

        // 4. Intersezione
        const resultLeft = meshOriginal.intersect(leftToolMoved);
        const resultRight = meshOriginal.intersect(rightToolMoved);

        // 5. PULIZIA MEMORIA (CRUCIALE)
        // Liberiamo gli oggetti intermedi che non servono più
        leftCS.delete();
        rightCS.delete();
        leftTool.delete();
        rightTool.delete();
        leftToolMoved.delete();
        rightToolMoved.delete();

        return { left: resultLeft, right: resultRight };
    }

    // --- TAGLIO ORIZZONTALE ---
    async sliceHorizontal(
        meshOriginal: Manifold,
        cutPathMm: {x: number, y: number}[], 
        bounds: {min: number[], max: number[]},
        toleranceMm: number
    ): Promise<{top: Manifold, bottom: Manifold}> {
        
        if (!this.wasm) await this.init();
        const m = this.wasm!;
        
        const pathSimple = this.simplifyPath(cutPathMm, 0.5);

        const farTop = bounds.max[1] + 50; 
        const farBottom = bounds.min[1] - 50;
        const depthMm = bounds.max[2] - bounds.min[2];
        const hugeZ = 500.0; // depthMm * 3;
        const halfGap = toleranceMm / 2;

        const topPoly = this.createHorizontalPolygon(pathSimple, farTop, halfGap, true);
        const bottomPoly = this.createHorizontalPolygon(pathSimple, farBottom, halfGap, false);

        // WASM Allocations
        const topCS = new (m as any).CrossSection([topPoly]);
        const bottomCS = new (m as any).CrossSection([bottomPoly]);

        let topTool = topCS.extrude(hugeZ, 0, 0, [1, 1]);
        let bottomTool = bottomCS.extrude(hugeZ, 0, 0, [1, 1]);

        const zStart = bounds.min[2] - 5.0;
        const topToolMoved = topTool.translate([0, 0, zStart]);
        const bottomToolMoved = bottomTool.translate([0, 0, zStart]);

        const resultTop = meshOriginal.intersect(topToolMoved);
        const resultBottom = meshOriginal.intersect(bottomToolMoved);

        // CLEANUP
        topCS.delete();
        bottomCS.delete();
        topTool.delete();
        bottomTool.delete();
        topToolMoved.delete();
        bottomToolMoved.delete();

        return { top: resultTop, bottom: resultBottom };
    }

    // --- Helpers (Invariati, ma inclusi per completezza) ---
    private createSidePolygon(path: {x:number, y:number}[], limitX: number, gapOffset: number, isLeft: boolean): number[][] {
        const poly: number[][] = [];
        const shiftX = isLeft ? -gapOffset : gapOffset;
        if (isLeft) { // CCW
            poly.push([limitX, path[0].y]); 
            poly.push([limitX, path[path.length-1].y]);
            for (let i = path.length - 1; i >= 0; i--) poly.push([path[i].x + shiftX, path[i].y]);
        } else { // CCW
            for (let i = 0; i < path.length; i++) poly.push([path[i].x + shiftX, path[i].y]);
            poly.push([limitX, path[path.length-1].y]);
            poly.push([limitX, path[0].y]);
        }
        return poly;
    }

// Poligono Orizzontale (Chiude Sopra o Sotto)
    // FIX: Ordine dei vertici corretto in senso Antiorario (CCW)
    private createHorizontalPolygon(path: {x:number, y:number}[], limitY: number, gapOffset: number, isTop: boolean): number[][] {
        const poly: number[][] = [];
        const shiftY = isTop ? gapOffset : -gapOffset; 
        
        // Path viene fornito da Sinistra (X Min) a Destra (X Max)
        
        if (isTop) {
            // LATO ALTO (Top) - Vogliamo l'area SOPRA il taglio.
            // CCW Order: Basso-Sx -> Basso-Dx -> Alto-Dx -> Alto-Sx
            
            // 1. Percorriamo il taglio da SX a DX (Basso)
            for (let i = 0; i < path.length; i++) {
                poly.push([path[i].x, path[i].y + shiftY]);
            }
            // 2. Saliamo all'angolo Alto-Destra
            poly.push([path[path.length-1].x, limitY]);
            // 3. Andiamo all'angolo Alto-Sinistra
            poly.push([path[0].x, limitY]);
            
        } else {
            // LATO BASSO (Bottom) - Vogliamo l'area SOTTO il taglio.
            // CCW Order: Alto-Dx -> Alto-Sx -> Basso-Sx -> Basso-Dx
            
            // 1. Percorriamo il taglio da DX a SX (Alto - Inverso)
            for (let i = path.length - 1; i >= 0; i--) {
                poly.push([path[i].x, path[i].y + shiftY]);
            }
            // 2. Scendiamo all'angolo Basso-Sinistra
            poly.push([path[0].x, limitY]);
            // 3. Andiamo all'angolo Basso-Destra
            poly.push([path[path.length-1].x, limitY]);
        }
        
        return poly;
    }

    private simplifyPath(points: {x:number, y:number}[], epsilon: number): {x:number, y:number}[] {
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

    private perpendicularDistance(point: {x:number, y:number}, lineStart: {x:number, y:number}, lineEnd: {x:number, y:number}): number {
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
        console.log(`   Input Triangoli: ${numTriangles}, Vertici Unici: ${uniqueVertCount}`);
        const vertProperties = new Float32Array(vertArray);
        const triVertsArray = new Uint32Array(triVerts);
        const meshObj = { numProp: 3, vertProperties: vertProperties, triVerts: triVertsArray };
        return new this.wasm!.Manifold(meshObj as any);
    }

    private saveStl(manifoldMesh: Manifold, filePath: string) {
        let mesh;
        try { mesh = manifoldMesh.getMesh(); } catch(e) { console.error(`❌ Errore mesh export ${filePath}`); return; }
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