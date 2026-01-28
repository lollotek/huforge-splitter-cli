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
    private collectedCutPaths: {x: number, y: number}[][] = [];

    constructor(geo: GeometryProcessor, heightMap: number[][], mapWidthMm: number, mapHeightMm: number) {
        this.geo = geo;
        this.fullHeightMap = heightMap;
        this.scaleX = mapWidthMm / heightMap[0].length;
        this.scaleY = mapHeightMm / heightMap.length;
    }

    // --- PROCESSO PRINCIPALE (DISPATCHER) ---
    async process(initialMesh: Manifold, maxBedW: number, maxBedH: number, tolerance: number, guideFile?: string): Promise<TilingResult> {
        if (guideFile) {
            return this.processGuided(initialMesh, guideFile, tolerance);
        } else {
            return this.processAuto(initialMesh, maxBedW, maxBedH, tolerance);
        }
    }

    // --- MODALITÀ MANUALE ---
    async processGuided(initialMesh: Manifold, guidePath: string, tolerance: number): Promise<TilingResult> {
        console.log("🛠️  Modalità Guidata Attiva");
        const guides = GuideParser.parse(guidePath, this.fullHeightMap[0].length, this.fullHeightMap.length);
        
        let currentParts: WorkItem[] = [{ mesh: initialMesh, name: "part" }];

        // Verticali
        for (let i = 0; i < guides.verticals.length; i++) {
            const mask = guides.verticals[i];
            const nextParts: WorkItem[] = [];
            for (const item of currentParts) {
                const finder = new SeamFinder(this.fullHeightMap);
                finder.setMask(mask);
                const seamPixels = finder.findVerticalSeam(0, this.fullHeightMap[0].length - 1);
                
                const bounds = item.mesh.boundingBox();
                const seamMinX = Math.min(...seamPixels.map(p => p.x)) * this.scaleX;
                const seamMaxX = Math.max(...seamPixels.map(p => p.x)) * this.scaleX;
                
                if (seamMaxX < bounds.min[0] || seamMinX > bounds.max[0]) {
                    nextParts.push(item);
                    continue;
                }

                this.collectedCutPaths.push(seamPixels.map(p => ({ x: p.x, y: p.y })));
                const seamMm = seamPixels.map(p => ({ x: p.x * this.scaleX, y: (this.fullHeightMap.length - p.y) * this.scaleY }));
                
                console.log(`   -> Applicazione taglio verticale ${i+1} su ${item.name}...`);
                const result = await this.geo.sliceVertical(item.mesh, seamMm, {min: bounds.min, max: bounds.max}, tolerance);

                if (result.left.numTri() > 0) nextParts.push({ mesh: result.left, name: item.name + "_L" });
                if (result.right.numTri() > 0) nextParts.push({ mesh: result.right, name: item.name + "_R" });
                item.mesh.delete();
            }
            currentParts = nextParts;
        }

        // Orizzontali
        for (let i = 0; i < guides.horizontals.length; i++) {
            const mask = guides.horizontals[i];
            const transposedMask = this.transposeMatrixBoolean(mask);
            const nextParts: WorkItem[] = [];
            for (const item of currentParts) {
                const transposedMap = this.transposeMatrix(this.fullHeightMap);
                const finder = new SeamFinder(transposedMap);
                finder.setMask(transposedMask);
                
                const seamTransposed = finder.findVerticalSeam(0, transposedMap[0].length - 1);
                const pathMmYs = seamTransposed.map(p => (this.fullHeightMap.length - p.x) * this.scaleY);
                const cutMinY = Math.min(...pathMmYs);
                const cutMaxY = Math.max(...pathMmYs);

                const bounds = item.mesh.boundingBox();
                if (cutMaxY < bounds.min[1] || cutMinY > bounds.max[1]) {
                    nextParts.push(item);
                    continue;
                }

                this.collectedCutPaths.push(seamTransposed.map(p => ({ x: p.y, y: p.x })));
                const horizontalPathMm = seamTransposed.map(p => ({ x: p.y * this.scaleX, y: (this.fullHeightMap.length - p.x) * this.scaleY }));

                console.log(`   -> Applicazione taglio orizzontale ${i+1} su ${item.name}...`);
                const result = await this.geo.sliceHorizontal(item.mesh, horizontalPathMm, {min: bounds.min, max: bounds.max}, tolerance);

                if (result.top.numTri() > 0) nextParts.push({ mesh: result.top, name: item.name + "_T" });
                if (result.bottom.numTri() > 0) nextParts.push({ mesh: result.bottom, name: item.name + "_B" });
                item.mesh.delete();
            }
            currentParts = nextParts;
        }
        return { parts: currentParts, paths: this.collectedCutPaths };
    }

    // --- MODALITÀ AUTOMATICA (RIPRISTINATA) ---
    async processAuto(initialMesh: Manifold, maxBedW: number, maxBedH: number, tolerance: number): Promise<TilingResult> {
        const queue: WorkItem[] = [{ mesh: initialMesh, name: "part" }];
        const finishedParts: WorkItem[] = [];

        while (queue.length > 0) {
            const item = queue.shift()!;
            const bounds = item.mesh.boundingBox();
            const width = bounds.max[0] - bounds.min[0];
            const height = bounds.max[1] - bounds.min[1];
            const centerX = (bounds.min[0] + bounds.max[0]) / 2;
            const centerY = (bounds.min[1] + bounds.max[1]) / 2;

            console.log(`\n🔹 Processing ${item.name}: ${width.toFixed(1)}x${height.toFixed(1)}mm`);

            // 1. CHECK LARGHEZZA
            if (width > maxBedW) {
                console.log(`   -> Troppo largo. Taglio Verticale...`);
                const pixelX = Math.floor(centerX / this.scaleX);
                const tolerancePixels = Math.floor(40 / this.scaleX);

                const finder = new SeamFinder(this.fullHeightMap);
                const seamPixels = finder.findVerticalSeam(pixelX - tolerancePixels, pixelX + tolerancePixels);
                
                this.collectedCutPaths.push(seamPixels.map(p => ({ x: p.x, y: p.y })));
                const seamMm = seamPixels.map(p => ({ x: p.x * this.scaleX, y: (this.fullHeightMap.length - p.y) * this.scaleY }));

                const result = await this.geo.sliceVertical(item.mesh, seamMm, {min: bounds.min, max: bounds.max}, tolerance);

                if (result.left.numTri() > 0) queue.push({ mesh: result.left, name: item.name + "_L" });
                if (result.right.numTri() > 0) queue.push({ mesh: result.right, name: item.name + "_R" });
                item.mesh.delete();
                continue;
            }

            // 2. CHECK ALTEZZA
            if (height > maxBedH) {
                console.log(`   -> Troppo alto. Taglio Orizzontale...`);
                const pixelY_Target = Math.floor((this.fullHeightMap.length * this.scaleY - centerY) / this.scaleY);
                const transposedMap = this.transposeMatrix(this.fullHeightMap);
                const finder = new SeamFinder(transposedMap);
                const tolPix = Math.floor(40 / this.scaleY);
                
                const seamTransposed = finder.findVerticalSeam(pixelY_Target - tolPix, pixelY_Target + tolPix);
                
                this.collectedCutPaths.push(seamTransposed.map(p => ({ x: p.y, y: p.x })));
                const horizontalPathMm = seamTransposed.map(p => ({ x: p.y * this.scaleX, y: (this.fullHeightMap.length - p.x) * this.scaleY }));

                const result = await this.geo.sliceHorizontal(item.mesh, horizontalPathMm, {min: bounds.min, max: bounds.max}, tolerance);

                if (result.top.numTri() > 0) queue.push({ mesh: result.top, name: item.name + "_T" });
                if (result.bottom.numTri() > 0) queue.push({ mesh: result.bottom, name: item.name + "_B" });
                item.mesh.delete();
                continue;
            }

            console.log(`   ✅ Pezzo OK.`);
            finishedParts.push(item);
        }

        return { parts: finishedParts, paths: this.collectedCutPaths };
    }

    private transposeMatrix(matrix: number[][]): number[][] {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
    }
    private transposeMatrixBoolean(matrix: boolean[][]): boolean[][] {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
    }
}