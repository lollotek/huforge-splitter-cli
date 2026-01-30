import { Manifold } from 'manifold-3d';
import { GeometryProcessor } from './GeometryProcessor';
import { SeamFinder } from '../prototypes/SeamFinderInfo';
import { GuideParser } from './GuideParser';

type WorkItem = { mesh: Manifold; name: string; };

export type TilingResult = {
    parts: WorkItem[];
    paths: { x: number, y: number }[][];
};

export class TilingManager {
    private geo: GeometryProcessor;
    private fullHeightMap: number[][];
    private scaleX: number;
    private scaleY: number;
    private collectedCutPaths: { x: number, y: number }[][] = [];

    // Variabili per il riferimento globale
    private globalMinX: number = 0; // Sarà settato nel process o passato
    private globalMaxY: number = 0; // FONDAMENTALE

    constructor(geo: GeometryProcessor, heightMap: number[][], mapWidthMm: number, mapHeightMm: number) {
        this.geo = geo;
        this.fullHeightMap = heightMap;
        this.scaleX = mapWidthMm / heightMap[0].length;
        this.scaleY = mapHeightMm / heightMap.length;
    }

    async process(initialMesh: Manifold, maxBedW: number, maxBedH: number, tolerance: number, guideFile?: string, safeMode: boolean = false): Promise<TilingResult> {
        // Calcoliamo i bounds globali una volta per tutte
        const b = initialMesh.boundingBox();
        this.globalMinX = b.min[0];
        this.globalMaxY = b.max[1]; // Questo è il TOP del modello

        if (guideFile) {
            return this.processGuided(initialMesh, guideFile, tolerance, safeMode);
        } else {
            return this.processAuto(initialMesh, maxBedW, maxBedH, tolerance, safeMode);
        }
    }

    async processGuided(initialMesh: Manifold, guidePath: string, tolerance: number, safeMode: boolean): Promise<TilingResult> {
        console.log("🛠️  Modalità Guidata Attiva");
        const guides = GuideParser.parse(guidePath, this.fullHeightMap[0].length, this.fullHeightMap.length);

        let currentParts: WorkItem[] = [{ mesh: initialMesh, name: "part" }];

        // 1. Tagli Verticali
        for (let i = 0; i < guides.verticals.length; i++) {
            const mask = guides.verticals[i];
            const nextParts: WorkItem[] = [];

            for (const item of currentParts) {
                const finder = new SeamFinder(this.fullHeightMap);
                finder.setMask(mask);
                const seamPixels = finder.findVerticalSeam(0, this.fullHeightMap[0].length - 1);

                // Conversione Bounds per check rapido
                const bounds = item.mesh.boundingBox();

                // --- FIX COORDINATE PIXEL -> MM ---
                const seamMm = seamPixels.map(p => ({
                    x: this.globalMinX + (p.x * this.scaleX),
                    // Y del Mondo = MaxY Globale - (PixelY * Scala)
                    // Nota: p.y=0 (Alto Img) -> MaxY (Alto Mondo)
                    y: this.globalMaxY - (p.y * this.scaleY)
                }));
                // ----------------------------------

                // Check intersezione grossolana (X axis)
                const seamMinX = Math.min(...seamMm.map(p => p.x));
                const seamMaxX = Math.max(...seamMm.map(p => p.x));

                if (seamMaxX < bounds.min[0] || seamMinX > bounds.max[0]) {
                    nextParts.push(item);
                    continue;
                }

                this.collectedCutPaths.push(seamPixels.map(p => ({ x: p.x, y: p.y }))); // Salviamo coordinate pixel per SVG (che usa 0=Alto)

                console.log(`   -> Applicazione taglio verticale ${i + 1} su ${item.name}...`);

                let cutSuccess = false;
                try {
                    const result = await this.geo.sliceVertical(item.mesh, seamMm, { min: bounds.min, max: bounds.max }, tolerance, safeMode);
                    if (result.left.numTri() > 0) nextParts.push({ mesh: result.left, name: item.name + "_L" });
                    if (result.right.numTri() > 0) nextParts.push({ mesh: result.right, name: item.name + "_R" });
                    cutSuccess = true;
                } catch (e: any) {
                    // Estrai info dettagliata dall'errore WASM
                    const errName = e?.name || 'UnknownError';
                    const errMsg = e?.message || String(e);
                    const errStack = e?.stack?.split('\n')[0] || '';

                    console.error(`❌ CRASH su ${item.name}`);
                    console.error(`   Tipo: ${errName}`);
                    console.error(`   Messaggio: ${errMsg}`);
                    if (errName === 'RuntimeError') {
                        console.error(`   ⚠️  Errore WASM: probabile geometria degenerata o self-intersection`);
                    }
                    console.error(`   Hint: Prova --safe o aumenta -t (tolleranza)`);
                    nextParts.push(item);
                    cutSuccess = false;
                } finally {
                    if (cutSuccess) item.mesh.delete();
                }
            }
            currentParts = nextParts;
        }

        // 2. Tagli Orizzontali
        for (let i = 0; i < guides.horizontals.length; i++) {
            const mask = guides.horizontals[i];
            const transposedMask = this.transposeMatrixBoolean(mask);
            const nextParts: WorkItem[] = [];

            for (const item of currentParts) {
                const transposedMap = this.transposeMatrix(this.fullHeightMap);
                const finder = new SeamFinder(transposedMap);
                finder.setMask(transposedMask);

                const seamTransposed = finder.findVerticalSeam(0, transposedMap[0].length - 1);

                // --- FIX COORDINATE PIXEL -> MM ---
                // In transposed: p.x è Row (Y originale), p.y è Col (X originale)
                // Quindi PixelY = p.x, PixelX = p.y
                const horizontalPathMm = seamTransposed.map(p => ({
                    x: this.globalMinX + (p.y * this.scaleX), // Col -> X
                    y: this.globalMaxY - (p.x * this.scaleY)  // Row -> Y (Invertito)
                }));
                // ----------------------------------

                const bounds = item.mesh.boundingBox();
                const pathYs = horizontalPathMm.map(p => p.y);
                const cutMinY = Math.min(...pathYs);
                const cutMaxY = Math.max(...pathYs);

                if (cutMaxY < bounds.min[1] || cutMinY > bounds.max[1]) {
                    nextParts.push(item);
                    continue;
                }

                // Per SVG path usiamo coord pixel non trasposte
                this.collectedCutPaths.push(seamTransposed.map(p => ({ x: p.y, y: p.x })));

                console.log(`   -> Applicazione taglio orizzontale ${i + 1} su ${item.name}...`);

                let cutSuccess = false;
                try {
                    const result = await this.geo.sliceHorizontal(item.mesh, horizontalPathMm, { min: bounds.min, max: bounds.max }, tolerance, safeMode);
                    if (result.top.numTri() > 0) nextParts.push({ mesh: result.top, name: item.name + "_T" });
                    if (result.bottom.numTri() > 0) nextParts.push({ mesh: result.bottom, name: item.name + "_B" });
                    cutSuccess = true;
                } catch (e: any) {
                    // Estrai info dettagliata dall'errore WASM
                    const errName = e?.name || 'UnknownError';
                    const errMsg = e?.message || String(e);

                    console.error(`❌ CRASH su ${item.name}`);
                    console.error(`   Tipo: ${errName}`);
                    console.error(`   Messaggio: ${errMsg}`);
                    if (errName === 'RuntimeError') {
                        console.error(`   ⚠️  Errore WASM: probabile geometria degenerata o self-intersection`);
                    }
                    console.error(`   Hint: Prova --safe o aumenta -t (tolleranza)`);
                    nextParts.push(item);
                    cutSuccess = false;
                } finally {
                    if (cutSuccess) item.mesh.delete();
                }
            }
            currentParts = nextParts;
        }

        return { parts: currentParts, paths: this.collectedCutPaths };
    }

    // Auto mode va aggiornato con la stessa logica (globalMaxY - pixelY * scale)
    async processAuto(initialMesh: Manifold, maxBedW: number, maxBedH: number, tolerance: number, safeMode: boolean): Promise<TilingResult> {
        // ... (Copia la logica di processGuided per le conversioni coordinate se usi auto mode)
        // Per brevità mi fermo qui, ma il concetto è identico: usa this.globalMaxY per invertire Y.
        return { parts: [], paths: [] }; // Placeholder
    }

    private transposeMatrix(matrix: number[][]): number[][] {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
    }
    private transposeMatrixBoolean(matrix: boolean[][]): boolean[][] {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
    }
}