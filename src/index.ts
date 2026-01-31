import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GeometryProcessor } from './core/GeometryProcessor';
import { TilingManager } from './core/TilingManager';
import { TileGenerator } from './core/TileGenerator';
import { RegionSplitter } from './core/RegionSplitter';
import { GuideParser } from './core/GuideParser';
import { TriangleClipper } from './core/TriangleClipper';
import { MeshRepair } from './utils/MeshRepair';
import { SvgBuilder } from './utils/SvgBuilder';
import { ImageGenerator } from './utils/ImageGenerator';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
    .name('hueslicer')
    .description('CLI tool per tagliare STL HueForge')
    .version('1.0.0')
    .argument('<file>', 'File STL di input')
    .option('-w, --width <number>', 'Larghezza piatto (mm)', '200')
    .option('-h, --height <number>', 'Altezza piatto (mm)', '200')
    .option('-t, --tolerance <number>', 'Tolleranza/Gap taglio (mm)', '0.2')
    .option('-r, --resolution <number>', 'Risoluzione HeightMap (mm/pixel), default 0.5', '0.5')
    .option('-p, --preview', 'Genera solo SVG di anteprima')
    .option('-o, --out <path>', 'Cartella di output', 'output')
    .option('-g, --guide <path>', 'File SVG con i percorsi guida')
    .option('-s, --safe', 'Usa modalità sicura (Niente smoothing, pulizia aggressiva). Utile se il tool crasha.', false)
    .option('-v, --verbose', 'Attiva log di debug e salva le mesh di taglio intermedie', false)
    .option('-m, --heightmap', 'Usa modalità HeightMap (rigenera mesh da griglia, evita booleane)', false)
    .option('-c, --clip', 'Usa TriangleClipper (taglio diretto triangoli, preserva qualità)', false)
    .option('--cap', 'Genera cap triangles per chiudere mesh (watertight)', false)
    .option('-f, --fix-manifold', 'Ripara mesh non-manifold usando manifold-3d dopo il clipping', false)
    .option('--repair-admesh', 'Ripara con admesh CLI (se installato)', false)
    .option('--repair-meshlab', 'Ripara con meshlab CLI (se installato)', false)
    .action(async (file, options) => {
        await run(file, options);
    });

async function run(inputFile: string, opts: any) {
    const stlPath = path.resolve(inputFile);
    const BED_W = parseFloat(opts.width);
    const BED_H = parseFloat(opts.height);
    const TOLERANCE = parseFloat(opts.tolerance);
    const RESOLUTION = parseFloat(opts.resolution);
    const PREVIEW_ONLY = opts.preview;
    const OUT_DIR = opts.out;
    const GUIDE_FILE = opts.guide;
    const SAFE_MODE = opts.safe;
    const VERBOSE = opts.verbose;
    const HEIGHTMAP_MODE = opts.heightmap;
    const CLIP_MODE = opts.clip;
    const CAP_MODE = opts.cap;
    const FIX_MANIFOLD = opts.fixManifold;
    const REPAIR_ADMESH = opts.repairAdmesh;
    const REPAIR_MESHLAB = opts.repairMeshlab;

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Tolleranza ${TOLERANCE}mm`);
    console.log(`🔧 Mode: ${PREVIEW_ONLY ? 'PREVIEW' : 'EXPORT'} | Clip: ${CLIP_MODE} | Cap: ${CAP_MODE} | Verbose: ${VERBOSE}`);

    // Branch to Clip mode if enabled (preferred for large meshes)
    if (CLIP_MODE) {
        await runClipMode(stlPath, GUIDE_FILE, OUT_DIR, PREVIEW_ONLY, VERBOSE, RESOLUTION, FIX_MANIFOLD, CAP_MODE, REPAIR_ADMESH, REPAIR_MESHLAB);
        return;
    }

    // Branch to HeightMap mode if enabled
    if (HEIGHTMAP_MODE) {
        await runHeightmapMode(stlPath, GUIDE_FILE, OUT_DIR, PREVIEW_ONLY, VERBOSE, RESOLUTION);
        return;
    }

    // 1. HeightMap
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, RESOLUTION);
    // const RESOLUTION = 0.5; // override removed
    const widthMm = mapData.width * RESOLUTION;
    const heightMm = mapData.height * RESOLUTION;

    // 2. Geometria
    console.log("\n--- FASE 2: Setup Geometria ---");
    const geo = new GeometryProcessor(VERBOSE); // Passiamo verbose
    await geo.init();
    const originalMesh = await geo.loadMesh(stlPath);
    const globalBounds = originalMesh.boundingBox();
    const globalMinX = globalBounds.min[0];
    const globalMaxY = globalBounds.max[1];

    // 3. Processo Tiling
    console.log("\n--- FASE 3: Calcolo Tagli ---");
    const tiler = new TilingManager(geo, mapData.grid, mapData.width, mapData.height, widthMm, heightMm);

    // Passiamo SAFE_MODE al tiler
    const result = await tiler.process(originalMesh, BED_W, BED_H, TOLERANCE, GUIDE_FILE, SAFE_MODE);

    // 4. Export SVG Preview
    console.log("\n--- FASE 4: Generazione Report ---");
    const svg = new SvgBuilder(mapData.width, mapData.height);

    try {
        const base64Img = ImageGenerator.gridToBase64(mapData.grid, mapData.width, mapData.height, mapData.maxZ);
        svg.setBackground(base64Img);
    } catch (e) { console.warn("⚠️ Impossibile generare sfondo immagine."); }

    result.paths.forEach(path => svg.addCutLine(path, '#ff0055'));

    for (const part of result.parts) {
        const bounds = part.mesh.boundingBox();
        const bX = (bounds.min[0] - globalMinX) / RESOLUTION;
        const bY = (globalMaxY - bounds.max[1]) / RESOLUTION;
        const bW = (bounds.max[0] - bounds.min[0]) / RESOLUTION;
        const bH = (bounds.max[1] - bounds.min[1]) / RESOLUTION;
        svg.addRect(bX, bY, bW, bH, '#00ccff');
    }
    svg.save('preview_cuts.svg');

    // 5. Salvataggio
    if (!PREVIEW_ONLY) {
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        for (const part of result.parts) {
            geo.saveMesh(part.mesh, path.join(OUT_DIR, `${part.name}.stl`));
            part.mesh.delete();
        }
    } else {
        console.log("\n⚠️  Modalità Preview: File STL non salvati.");
        result.parts.forEach(p => p.mesh.delete());
    }
}

/**
 * Helper: Transpone una griglia 2D (righe <-> colonne)
 */
function transposeGrid(grid: number[][]): number[][] {
    const rows = grid.length;
    const cols = grid[0].length;
    const result: number[][] = Array(cols).fill(null).map(() => Array(rows).fill(0));
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            result[x][y] = grid[y][x];
        }
    }
    return result;
}

/**
 * Helper: Transpone una maschera booleana 2D
 */
function transposeMask(mask: boolean[][]): boolean[][] {
    const rows = mask.length;
    const cols = mask[0].length;
    const result: boolean[][] = Array(cols).fill(null).map(() => Array(rows).fill(false));
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            result[x][y] = mask[y][x];
        }
    }
    return result;
}

/**
 * HeightMap Mode: Rigenera mesh da heightmap invece di usare operazioni booleane
 */
async function runHeightmapMode(
    stlPath: string,
    guideFile: string | undefined,
    outDir: string,
    previewOnly: boolean,
    verbose: boolean,
    resolution: number
) {
    if (!guideFile) {
        console.error("❌ HeightMap mode richiede un file guida (-g)");
        process.exit(1);
    }

    const { SeamFinder } = await import('./prototypes/SeamFinderInfo');

    // 1. Genera HeightMap
    console.log("\n--- FASE 1: Generazione HeightMap ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, resolution);
    const widthMm = mapData.width * resolution;
    const heightMm = mapData.height * resolution;

    // 2. Parse Guide SVG per estrarre seam paths
    console.log("\n--- FASE 2: Estrazione Seam Paths ---");
    const guides = GuideParser.parse(guideFile, mapData.width, mapData.height);

    // Estrai paths (mm) usando SeamFinder
    const verticalPaths: { x: number, y: number }[][] = [];
    const horizontalPaths: { x: number, y: number }[][] = [];

    for (const mask of guides.verticals) {
        const finder = new SeamFinder(mapData.grid, mapData.width, mapData.height);
        finder.setMask(mask);
        const seamPixels = finder.findVerticalSeam(0, mapData.width - 1);
        // Converti pixel -> mm (Y invertito perché heightmap ha 0=top)
        const seamMm = seamPixels.map(p => ({
            x: p.x * resolution,
            y: p.y * resolution  // Nota: manteniamo coordinate pixel per le maschere
        }));
        verticalPaths.push(seamMm);
    }

    for (const mask of guides.horizontals) {
        // Per seams orizzontali, trasponiamo griglia e maschera
        // Helper inline per trasporre Float32Array
        const transposedGrid = new Float32Array(mapData.width * mapData.height);
        for (let y = 0; y < mapData.height; y++) {
            for (let x = 0; x < mapData.width; x++) {
                transposedGrid[x * mapData.height + y] = mapData.grid[y * mapData.width + x];
            }
        }
        const transposedW = mapData.height;
        const transposedH = mapData.width;

        // Mask transposition logic (number[][]) - wait, mask coming from GuideParser is boolean[][]
        const transposedMask = transposeMask(mask);

        const finder = new SeamFinder(transposedGrid, transposedW, transposedH);
        finder.setMask(transposedMask);
        const seamPixels = finder.findVerticalSeam(0, transposedW - 1);

        // Ri-trasponi le coordinate: (x, y) trasposto -> (y, x) originale
        const seamMm = seamPixels.map((p: { x: number, y: number }) => ({
            x: p.y * resolution,  // Era la riga nella griglia trasposta = X originale
            y: p.x * resolution   // Era la colonna nella griglia trasposta = Y originale
        }));
        horizontalPaths.push(seamMm);
    }

    console.log(`   -> ${verticalPaths.length} vertical paths, ${horizontalPaths.length} horizontal paths`);

    // 3. Genera tiles usando TileGenerator con seed-based flood fill
    console.log("\n--- FASE 3: Generazione Tiles da HeightMap ---");
    const tileGen = new TileGenerator(mapData.grid, mapData.width, mapData.height, resolution, verbose);
    const splitter = new RegionSplitter(mapData.width, mapData.height, resolution);

    // Combina tutti i paths per creare barriere
    const allPaths = [...verticalPaths, ...horizontalPaths];

    // Calcola seed points per ogni regione (centro di ogni cella della griglia)
    const numCols = verticalPaths.length + 1;
    const numRows = horizontalPaths.length + 1;

    const tiles: { name: string, buffer: Buffer }[] = [];

    for (let row = 0; row < numRows; row++) {
        for (let col = 0; col < numCols; col++) {
            // Calcola seed point al centro della regione
            const leftBound = col === 0 ? 0 :
                verticalPaths[col - 1].reduce((sum, p) => sum + p.x, 0) / verticalPaths[col - 1].length;
            const rightBound = col === numCols - 1 ? widthMm :
                verticalPaths[col].reduce((sum, p) => sum + p.x, 0) / verticalPaths[col].length;
            const topBound = row === 0 ? 0 :
                horizontalPaths[row - 1].reduce((sum, p) => sum + p.y, 0) / horizontalPaths[row - 1].length;
            const bottomBound = row === numRows - 1 ? heightMm :
                horizontalPaths[row].reduce((sum, p) => sum + p.y, 0) / horizontalPaths[row].length;

            const seedX = (leftBound + rightBound) / 2;
            const seedY = (topBound + bottomBound) / 2;

            if (verbose) console.log(`   Tile r${row}_c${col}: seed (${seedX.toFixed(1)}, ${seedY.toFixed(1)})`);

            // Crea maschera con flood fill dal seed
            const mask = splitter.createRegionMask(seedX, seedY, allPaths);

            // Estrai griglia e genera mesh
            const tileGrid = tileGen.extractTileGrid(mask);

            if (tileGrid.width > 0 && tileGrid.height > 0) {
                // UPDATE: Use gridToSTL_Flat
                const stlBuffer = tileGen.gridToSTL_Flat(
                    tileGrid.grid,
                    tileGrid.width,
                    tileGrid.height,
                    tileGrid.offsetX,
                    tileGrid.offsetY,
                    tileGrid.validMap
                );
                tiles.push({ name: `tile_r${row}_c${col}`, buffer: stlBuffer });
            }
        }
    }

    console.log(`   -> Generati ${tiles.length} tiles`);

    // 4. Salvataggio
    console.log("\n--- FASE 4: Salvataggio ---");
    if (!previewOnly) {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        for (const tile of tiles) {
            const filePath = path.join(outDir, `${tile.name}.stl`);
            fs.writeFileSync(filePath, tile.buffer);
            console.log(`💾 Saved: ${filePath}`);
        }
    } else {
        console.log("⚠️  Modalità Preview: File STL non salvati.");
    }

    console.log("\n✅ HeightMap mode completato!");
}

/**
 * Clip Mode: Usa TriangleClipper per tagliare la mesh lungo i seam paths
 * Preserva la qualità STL originale, funziona su mesh grandi
 */
async function runClipMode(
    stlPath: string,
    guideFile: string | undefined,
    outDir: string,
    previewOnly: boolean,
    verbose: boolean,
    resolution: number,
    fixManifold: boolean = false,
    capMode: boolean = false,
    repairAdmesh: boolean = false,
    repairMeshlab: boolean = false
) {
    if (!guideFile) {
        console.error("❌ Clip mode richiede un file guida (-g)");
        process.exit(1);
    }

    const { SeamFinder } = await import('./prototypes/SeamFinderInfo');

    // 1. Genera HeightMap per trovare seam paths ottimali
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, resolution);
    const widthMm = mapData.width * resolution;
    const heightMm = mapData.height * resolution;

    // Leggi STL per ottenere bounding box COMPLETO
    const stlBuffer = fs.readFileSync(stlPath);
    const triangleCount = stlBuffer.readUInt32LE(80);
    console.log(`   Triangles: ${triangleCount}`);

    // Usa TriangleClipper per calcolare bbox completo
    const tempClipper = new TriangleClipper(false);
    const fullBbox = tempClipper.getBoundingBox(stlBuffer);
    const globalMinX = fullBbox.minX;
    const globalMaxY = fullBbox.maxY;

    if (verbose) {
        console.log(`   Global BBox: X[${fullBbox.minX.toFixed(1)}, ${fullBbox.maxX.toFixed(1)}] Y[${fullBbox.minY.toFixed(1)}, ${fullBbox.maxY.toFixed(1)}]`);
    }

    // 2. Parse Guide SVG per estrarre seam paths
    console.log("\n--- FASE 2: Estrazione Seam Paths ---");
    const guides = GuideParser.parse(guideFile, mapData.width, mapData.height);

    // Estrai paths (world coords mm) usando SeamFinder
    const verticalPaths: { x: number, y: number }[][] = [];
    const horizontalPaths: { x: number, y: number }[][] = [];

    const scaleX = widthMm / mapData.width;
    const scaleY = heightMm / mapData.height;

    for (const mask of guides.verticals) {
        const finder = new SeamFinder(mapData.grid, mapData.width, mapData.height);
        finder.setMask(mask);
        const seamPixels = finder.findVerticalSeam(0, mapData.width - 1);
        // Converti pixel -> world coords mm
        const seamMm = seamPixels.map((p: { x: number, y: number }) => ({
            x: globalMinX + p.x * scaleX,
            y: globalMaxY - p.y * scaleY  // Y invertito
        }));
        verticalPaths.push(seamMm);

        if (verbose && seamMm.length > 0) {
            const xMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            const xMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            console.log(`   Vertical path: X range [${xMin}, ${xMax}]`);
        }
    }

    for (const mask of guides.horizontals) {
        // Transpose HeightMap manually
        const transposedGrid = new Float32Array(mapData.width * mapData.height);
        for (let y = 0; y < mapData.height; y++) {
            for (let x = 0; x < mapData.width; x++) {
                transposedGrid[x * mapData.height + y] = mapData.grid[y * mapData.width + x];
            }
        }
        const transposedW = mapData.height;
        const transposedH = mapData.width;

        const transposedMask = transposeMask(mask);
        const finder = new SeamFinder(transposedGrid, transposedW, transposedH);
        finder.setMask(transposedMask);
        const seamPixels = finder.findVerticalSeam(0, transposedW - 1);
        const seamMm = seamPixels.map((p: { x: number, y: number }) => ({
            x: globalMinX + p.y * scaleX,   // Trasposto
            y: globalMaxY - p.x * scaleY    // Trasposto + invertito
        }));
        horizontalPaths.push(seamMm);

        if (verbose && seamMm.length > 0) {
            const yMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            const yMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            console.log(`   Horizontal path: Y range [${yMin}, ${yMax}]`);
        }
    }

    console.log(`   -> ${verticalPaths.length} vertical, ${horizontalPaths.length} horizontal paths`);

    // 3. Streaming Slicer Phase
    console.log("\n--- FASE 3: Streaming Slicing (New Architecture) ---");
    const { StreamingSlicer } = await import('./core/StreamingSlicer');
    const streamSlicer = new StreamingSlicer(stlPath, outDir, verbose);

    // Assicurati che outDir esista
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    await streamSlicer.process(verticalPaths, horizontalPaths);

    // 4. Generate SVG Preview
    if (guideFile && !previewOnly) {
        const svgPath = path.join(outDir, '_preview_cuts.svg');
        console.log(`\n--- Generating Preview: ${svgPath} ---`);
        // SvgBuilder constructor takes (width, height)
        const builder = new SvgBuilder(widthMm, heightMm);

        verticalPaths.forEach(p => builder.addCutLine(p, 'red'));
        horizontalPaths.forEach(p => builder.addCutLine(p, 'blue'));

        builder.save(svgPath);
    }

    // Skip old logic
    return;
    /*
    const clipper = new TriangleClipper(verbose);
    // ... old clipper logic ...
    */

    /*
    // Strategia: prima tagli verticali, poi orizzontali su ogni pezzo
    let currentBuffers: { name: string, buffer: Buffer }[] = [
        { name: 'part', buffer: stlBuffer }
    ];
    
    // Tagli verticali
    for (let i = 0; i < verticalPaths.length; i++) {
        const seamPath = verticalPaths[i];
        const nextBuffers: { name: string, buffer: Buffer }[] = [];
    
        for (const item of currentBuffers) {
            const triCount = item.buffer.readUInt32LE(80);
            if (triCount === 0) {
                nextBuffers.push(item);
                continue;
            }
    
            // Check se il path interseca questo pezzo
            const bbox = clipper.getBoundingBox(item.buffer);
            if (!clipper.pathIntersectsBboxVertical(seamPath, bbox)) {
                if (verbose) console.log(`   Vertical cut ${i + 1} skipped on ${item.name} (path outside bbox)`);
                nextBuffers.push(item);
                continue;
            }
    
            console.log(`   Vertical cut ${i + 1} on ${item.name}...`);
            const result = capMode
                ? clipper.splitSTLWithCaps(item.buffer, seamPath, 'vertical')
                : clipper.splitSTL(item.buffer, seamPath);
    
            // Solo aggiungi parti non vuote
            const leftCount = result.leftBuffer.readUInt32LE(80);
            const rightCount = result.rightBuffer.readUInt32LE(80);
            if (leftCount > 0) nextBuffers.push({ name: `${item.name}_L`, buffer: result.leftBuffer });
            if (rightCount > 0) nextBuffers.push({ name: `${item.name}_R`, buffer: result.rightBuffer });
        }
    
        currentBuffers = nextBuffers;
    }
    
    // Tagli orizzontali
    for (let i = 0; i < horizontalPaths.length; i++) {
        const seamPath = horizontalPaths[i];
        const nextBuffers: { name: string, buffer: Buffer }[] = [];
    
        for (const item of currentBuffers) {
            const triCount = item.buffer.readUInt32LE(80);
            if (triCount === 0) {
                nextBuffers.push(item);
                continue;
            }
    
            // Check se il path interseca questo pezzo
            const bbox = clipper.getBoundingBox(item.buffer);
            if (!clipper.pathIntersectsBboxHorizontal(seamPath, bbox)) {
                if (verbose) console.log(`   Horizontal cut ${i + 1} skipped on ${item.name} (path outside bbox)`);
                nextBuffers.push(item);
                continue;
            }
    
            console.log(`   Horizontal cut ${i + 1} on ${item.name}...`);
            const result = capMode
                ? clipper.splitSTLWithCaps(item.buffer, seamPath, 'horizontal')
                : clipper.splitSTLHorizontal(item.buffer, seamPath);
    
            // Solo aggiungi parti non vuote
            const leftCount = result.leftBuffer.readUInt32LE(80);
            const rightCount = result.rightBuffer.readUInt32LE(80);
            if (leftCount > 0) nextBuffers.push({ name: `${item.name}_T`, buffer: result.leftBuffer });
            if (rightCount > 0) nextBuffers.push({ name: `${item.name}_B`, buffer: result.rightBuffer });
        }
    
        currentBuffers = nextBuffers;
    }
    
    console.log(`   -> ${currentBuffers.length} tiles generated`);
    
    // 4. Riparazione Manifold (opzionale)
    if (fixManifold) {
        console.log("\n--- FASE 4: Riparazione Manifold ---");
        const geo = new GeometryProcessor(verbose);
        await geo.init();
    
        const repairedBuffers: { name: string, buffer: Buffer }[] = [];
    
        for (const tile of currentBuffers) {
            const triCount = tile.buffer.readUInt32LE(80);
            if (triCount === 0) continue;
    
            const tempPath = path.join(outDir, `_temp_${tile.name}.stl`);
            const repairedPath = path.join(outDir, `${tile.name}.stl`);
    
            try {
                console.log(`   🔧 Repairing ${tile.name}...`);
                // Scrivi file temporaneo
                if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(tempPath, tile.buffer);
    
                // Carica in manifold (ripara automaticamente)
                const mesh = await geo.loadMesh(tempPath);
    
                // Esporta mesh riparata
                geo.saveMesh(mesh, repairedPath);
    
                // Rileggi come buffer
                const repairedBuffer = fs.readFileSync(repairedPath);
                const repairedTriCount = repairedBuffer.readUInt32LE(80);
                repairedBuffers.push({ name: tile.name, buffer: repairedBuffer });
    
                // Pulisci temp
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                mesh.delete();
    
                console.log(`   ✅ ${tile.name}: ${triCount} → ${repairedTriCount} triangles`);
            } catch (e: any) {
                console.log(`   ⚠️ ${tile.name}: Manifold repair failed, keeping original`);
                if (verbose) console.error(`      Error: ${e?.message || e}`);
    
                // Pulisci temp file se esiste
                if (fs.existsSync(tempPath)) {
                    try { fs.unlinkSync(tempPath); } catch { }
                }
    
                // Fallback: usa buffer originale ma salvalo direttamente
                fs.writeFileSync(repairedPath, tile.buffer);
                repairedBuffers.push({ name: tile.name, buffer: tile.buffer });
            }
        }
    
        currentBuffers = repairedBuffers;
        console.log(`   -> ${currentBuffers.length} tiles processed`);
    }
    
    // 5. Salvataggio
    console.log("\n--- FASE 5: Salvataggio ---");
    const savedPaths: string[] = [];
    if (!previewOnly) {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        for (const tile of currentBuffers) {
            const triCount = tile.buffer.readUInt32LE(80);
            if (triCount > 0) {
                const filePath = path.join(outDir, `${tile.name}.stl`);
                // Se fixManifold attivo, già salvati nella fase precedente
                if (!fixManifold) {
                    fs.writeFileSync(filePath, tile.buffer);
                }
                savedPaths.push(filePath);
                console.log(`💾 Saved: ${filePath} (${triCount} triangles)`);
            }
        }
    } else {
        console.log("⚠️  Modalità Preview: File STL non salvati.");
    }
    
    // 6. Riparazione Esterna (opzionale)
    if ((repairAdmesh || repairMeshlab) && savedPaths.length > 0) {
        console.log("\n--- FASE 6: Riparazione Esterna ---");
    
        const tools = await MeshRepair.detectAvailableTools();
        console.log(`   Available tools: ${tools.length > 0 ? tools.join(', ') : 'none'}`);
    
        for (const filePath of savedPaths) {
            if (repairAdmesh && tools.includes('admesh')) {
                console.log(`   🔧 Admesh: ${path.basename(filePath)}...`);
                const success = await MeshRepair.repairWithAdmesh(filePath, verbose);
                console.log(`   ${success ? '✅' : '❌'} ${path.basename(filePath)}`);
            }
    
            if (repairMeshlab && tools.includes('meshlab')) {
                console.log(`   🔧 Meshlab: ${path.basename(filePath)}...`);
                const success = await MeshRepair.repairWithMeshlab(filePath, verbose);
                console.log(`   ${success ? '✅' : '❌'} ${path.basename(filePath)}`);
            }
        }
    }
    
        */

    console.log("\n✅ Clip mode completato (Streaming)!");
}

program.parse(process.argv);