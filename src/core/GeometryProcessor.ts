import fs from 'fs';
import Module, { Manifold, ManifoldToplevel } from 'manifold-3d';

export class GeometryProcessor {
    private wasm: ManifoldToplevel | null = null;

    async init() {
        if (!this.wasm) {
            console.log("⚙️ Inizializzazione Manifold WASM...");
            this.wasm = await Module();
            this.wasm.setup();
        }
    }

    async sliceAndSave(
        stlPath: string, 
        cutPath: {x: number, y: number}[],
        imageWidth: number, 
        imageHeight: number,
        outputPrefix: string,
        toleranceMm: number = 0.2
    ) {
        if (!this.wasm) await this.init();
        const m = this.wasm!;

        // 1. CARICAMENTO
        console.log(`📦 Caricamento e Ottimizzazione Mesh: ${stlPath}`);
        const meshOriginal = this.loadStl(stlPath);
        
        const bounds = meshOriginal.boundingBox();
        const widthMm = bounds.max[0] - bounds.min[0];
        const heightMm = bounds.max[1] - bounds.min[1];
        const depthMm = bounds.max[2] - bounds.min[2];

        console.log(`📏 Dimensioni: ${widthMm.toFixed(1)}x${heightMm.toFixed(1)}x${depthMm.toFixed(1)}mm`);
        
        // 2. PREPARAZIONE TAGLIO
        const scaleX = widthMm / imageWidth;
        const scaleY = heightMm / imageHeight;
        const offsetX = bounds.min[0];
        
        let pathMm = cutPath.map(p => ({
            x: offsetX + (p.x * scaleX),
            y: bounds.max[1] - (p.y * scaleY) 
        }));

        // Semplificazione percorso
        const originalPoints = pathMm.length;
        pathMm = this.simplifyPath(pathMm, 0.5); 
        console.log(`📉 Semplificazione Percorso: ${originalPoints} -> ${pathMm.length} punti.`);

        console.log("✂️ Generazione volumi di taglio...");
        
        // Estendiamo leggermente di più i bordi per sicurezza
        const farLeft = bounds.min[0] - 50; 
        const farRight = bounds.max[0] + 50;
        const hugeZ = depthMm * 3; 
        const halfGap = toleranceMm / 2;

        const leftPoly = this.createSidePolygon(pathMm, farLeft, halfGap, true);
        const rightPoly = this.createSidePolygon(pathMm, farRight, halfGap, false);

        // Creazione Tools
        const leftCS = new (m as any).CrossSection([leftPoly]);
        const rightCS = new (m as any).CrossSection([rightPoly]);
        
        // Estrusione
        let leftTool = leftCS.extrude(hugeZ, 0, 0, [1, 1]);
        let rightTool = rightCS.extrude(hugeZ, 0, 0, [1, 1]);

        // Traslazione Z (Partiamo leggermente più in basso e finiamo più in alto per coprire tutto)
        const zStart = bounds.min[2] - 5.0; 
        leftTool = leftTool.translate([0, 0, zStart]);
        rightTool = rightTool.translate([0, 0, zStart]);

        // 3. INTERSEZIONE
        console.log("✨ Esecuzione Boolean Intersect (Richiede molta RAM)...");
        
        try {
            const partLeft = meshOriginal.intersect(leftTool);
            const partRight = meshOriginal.intersect(rightTool);

            const countLeft = partLeft.numTri();
            const countRight = partRight.numTri();

            console.log(`📊 Risultati: Sinistra=${countLeft} tri, Destra=${countRight} tri`);

            if (countLeft > 0) {
                console.log("💾 Salvataggio parte sinistra...");
                this.saveStl(partLeft, `${outputPrefix}_left.stl`);
            } else {
                console.warn("⚠️ Parte Sinistra vuota! Possibile problema di coordinate o winding.");
            }
            
            if (countRight > 0) {
                console.log("💾 Salvataggio parte destra...");
                this.saveStl(partRight, `${outputPrefix}_right.stl`);
            }
            
            console.log("✅ Operazione conclusa con successo!");
            
        } catch (e) {
            console.error("❌ ERRORE CRITICO in Manifold.");
            throw e;
        }
    }

    // --- FIX WINDING ORDER ---
    private createSidePolygon(path: {x:number, y:number}[], limitX: number, gapOffset: number, isLeft: boolean): number[][] {
        const poly: number[][] = [];
        const shiftX = isLeft ? -gapOffset : gapOffset;

        // Path originale: dall'alto (Y max) al basso (Y min)
        // Dobbiamo disegnare in senso Antiorario (CCW)
        
        if (isLeft) {
            // LATO SINISTRO (CCW)
            // 1. Iniziamo dall'angolo Alto-Sinistra
            poly.push([limitX, path[0].y]); 
            // 2. Scendiamo all'angolo Basso-Sinistra
            poly.push([limitX, path[path.length-1].y]);
            
            // 3. Risaliamo lungo il percorso di taglio (dal basso all'alto)
            // Quindi iteriamo il path al contrario
            for (let i = path.length - 1; i >= 0; i--) {
                poly.push([path[i].x + shiftX, path[i].y]);
            }
        } else {
            // LATO DESTRO (CCW)
            // 1. Scendiamo lungo il percorso di taglio (dall'alto al basso)
            for (let i = 0; i < path.length; i++) {
                poly.push([path[i].x + shiftX, path[i].y]);
            }
            
            // 2. Andiamo all'angolo Basso-Destra
            poly.push([limitX, path[path.length-1].y]);
            // 3. Risaliamo all'angolo Alto-Destra
            poly.push([limitX, path[0].y]);
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
        } else {
            return [points[0], points[end]];
        }
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
                const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
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
        console.log(`   Input: ${numTriangles} triangoli -> ${uniqueVertCount} vertici.`);
        const vertProperties = new Float32Array(vertArray);
        const triVertsArray = new Uint32Array(triVerts);
        const meshObj = { numProp: 3, vertProperties: vertProperties, triVerts: triVertsArray };
        return new this.wasm!.Manifold(meshObj as any);
    }

    private saveStl(manifoldMesh: Manifold, filePath: string) {
        let mesh;
        try { mesh = manifoldMesh.getMesh(); } catch(e) { console.error(`❌ Errore estrazione mesh.`); throw e; }
        const numTriangles = mesh.triVerts.length / 3;
        console.log(`   -> Scrittura ${filePath} (${numTriangles} tri)...`);
        const bufferSize = 84 + (numTriangles * 50);
        const buffer = Buffer.alloc(bufferSize);
        buffer.write("HueSlicer Export", 0); 
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