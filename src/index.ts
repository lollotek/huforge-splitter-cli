import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GeometryProcessor } from './core/GeometryProcessor';
import { TilingManager } from './core/TilingManager';
import { TileGenerator } from './core/TileGenerator';
import { RegionSplitter } from './core/RegionSplitter';
import { GuideParser } from './core/GuideParser';
import { TriangleClipper } from './core/TriangleClipper';
import { MeshRepair } from './utils/MeshRepair';
import { SvgExporter } from './utils/SvgExporter';
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
    .option('--autofix', 'Alias per --repair-admesh (Auto-fix manifold errors)', false)
    .option('--repair-meshlab', 'Ripara con meshlab CLI (se installato)', false)
    .option('--svg-export', 'Esporta il layout dei tile in un unico file SVG (Experimental)', false)
    .option('--svg-mode', 'Usa modalità SVG ', false)
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
    const CLIP_MODE = opts.clip;
    const CAP_MODE = opts.cap;
    const FIX_MANIFOLD = opts.fixManifold;
    const REPAIR_ADMESH = opts.repairAdmesh || opts.autofix;
    const REPAIR_MESHLAB = opts.repairMeshlab;
    const SVG_EXPORT = opts.svgExport;
    const SVG_MODE = opts.svgMode;

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Tolleranza ${TOLERANCE}mm`);
    console.log(`🔧 Mode: ${PREVIEW_ONLY ? 'PREVIEW' : 'EXPORT'} | Clip: ${CLIP_MODE} | Cap: ${CAP_MODE} | Verbose: ${VERBOSE}`);

    // Branch to Clip mode if enabled (preferred for large meshes)
    if (SVG_MODE) {
        await runSvgMode(stlPath, GUIDE_FILE, OUT_DIR, PREVIEW_ONLY, VERBOSE, RESOLUTION, SVG_EXPORT);
        return;
    }

    // Branch to Clip mode if enabled (preferred for large meshes)
    if (CLIP_MODE) {
        await runClipMode(stlPath, GUIDE_FILE, OUT_DIR, PREVIEW_ONLY, VERBOSE, RESOLUTION, FIX_MANIFOLD, CAP_MODE, REPAIR_ADMESH, REPAIR_MESHLAB, SVG_EXPORT);
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
    FIX_MANIFOLD: boolean = false,
    CAP_MODE: boolean = false,
    repairAdmesh: boolean = false,
    repairMeshlab: boolean = false,
    svgExport: boolean = false
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
    const globalMinY = fullBbox.minY;
    const globalMaxX = fullBbox.maxX;

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
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            // Vertical seam flows along Y. Start (Top) should be MaxY, End (Bottom) should be MinY.
            // Coordinate mapping: y = globalMaxY - p.y * scaleY
            // p.y=0 -> y=globalMaxY. p.y=Height -> y=globalMinY.
            // Force first point to Top, last point to Bottom.
            seamMm[0].y = globalMaxY;
            seamMm[seamMm.length - 1].y = globalMinY;

            verticalPaths.push(seamMm);
        }

        if (verbose && seamMm.length > 0) {
            const xMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            const xMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            console.log(`   Vertical path: X range [${xMin}, ${xMax}] (Snapped Y)`);
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
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            // Horizontal seam flows along X. Start (Left) should be MinX, End (Right) should be MaxX.
            // Coordinate mapping: x = globalMinX + p.y * scaleX (Transposed logic)
            // p.y (original x) = 0 -> x=globalMinX.

            seamMm[0].x = globalMinX;
            seamMm[seamMm.length - 1].x = globalMaxX;

            horizontalPaths.push(seamMm);
        }

        if (verbose && seamMm.length > 0) {
            const yMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            const yMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            console.log(`   Horizontal path: Y range [${yMin}, ${yMax}] (Snapped X)`);
        }
    }

    // SORT: Ensure paths are spatially ordered (Left->Right, Top->Bottom)
    verticalPaths.sort((a, b) => {
        const avgA = a.reduce((sum, p) => sum + p.x, 0) / a.length;
        const avgB = b.reduce((sum, p) => sum + p.x, 0) / b.length;
        return avgA - avgB;
    });

    horizontalPaths.sort((a, b) => {
        const avgA = a.reduce((sum, p) => sum + p.y, 0) / a.length;
        const avgB = b.reduce((sum, p) => sum + p.y, 0) / b.length;
        return avgA - avgB;
    });

    console.log(`   -> ${verticalPaths.length} vertical, ${horizontalPaths.length} horizontal paths (Sorted)`);

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

    // --- FASE 5: SVG Export (New) ---
    if (svgExport) {
        // Using the original Seam Paths (Robust Method Phase 10)
        // width and height arguments in GuideParser are in PIXELS (unless they match mm).
        // GuideParser.parse takes width, height.
        // We used widthMm and heightMm for SvgBuilder.
        // Note: verticalPaths are in the coordinate space of the Guide (pixels or mm adjusted).
        // Let's pass the same width/height used for parsing.

        const svgOut = path.join(outDir, 'tiles_layout.svg');
        await SvgExporter.generateFromPaths(verticalPaths, horizontalPaths, widthMm, heightMm, svgOut);
    }

    // --- FASE 4: Auto-Repair ---
    if (repairAdmesh) {
        console.log("\n--- FASE 4: Auto-Repair (Admesh) ---");
        const files = fs.readdirSync(outDir).filter(f => f.endsWith('.stl'));
        if (files.length === 0) {
            console.log("⚠️  Nessun file STL trovato in output per la riparazione.");
        } else {
            for (const file of files) {
                const fullPath = path.join(outDir, file);
                await MeshRepair.repairFile(fullPath);
            }
        }
    }
    console.log("\n✅ Clip mode completato (Streaming)!");
}

async function runSvgMode(
    stlPath: string,
    guideFile: string | undefined,
    outDir: string,
    previewOnly: boolean,
    verbose: boolean,
    resolution: number,
    svgExport: boolean = false
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
    const globalMinY = fullBbox.minY;
    const globalMaxX = fullBbox.maxX;

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
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            // Vertical seam flows along Y. Start (Top) should be MaxY, End (Bottom) should be MinY.
            // Coordinate mapping: y = globalMaxY - p.y * scaleY
            // p.y=0 -> y=globalMaxY. p.y=Height -> y=globalMinY.
            // Force first point to Top, last point to Bottom.
            seamMm[0].y = globalMaxY;
            seamMm[seamMm.length - 1].y = globalMinY;

            verticalPaths.push(seamMm);
        }

        if (verbose && seamMm.length > 0) {
            const xMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            const xMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            console.log(`   Vertical path: X range [${xMin}, ${xMax}] (Snapped Y)`);
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
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            // Horizontal seam flows along X. Start (Left) should be MinX, End (Right) should be MaxX.
            // Coordinate mapping: x = globalMinX + p.y * scaleX (Transposed logic)
            // p.y (original x) = 0 -> x=globalMinX.

            seamMm[0].x = globalMinX;
            seamMm[seamMm.length - 1].x = globalMaxX;

            horizontalPaths.push(seamMm);
        }

        if (verbose && seamMm.length > 0) {
            const yMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            const yMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.y)).toFixed(1);
            console.log(`   Horizontal path: Y range [${yMin}, ${yMax}] (Snapped X)`);
        }
    }

    // SORT: Ensure paths are spatially ordered (Left->Right, Top->Bottom)
    verticalPaths.sort((a, b) => {
        const avgA = a.reduce((sum, p) => sum + p.x, 0) / a.length;
        const avgB = b.reduce((sum, p) => sum + p.x, 0) / b.length;
        return avgA - avgB;
    });

    horizontalPaths.sort((a, b) => {
        const avgA = a.reduce((sum, p) => sum + p.y, 0) / a.length;
        const avgB = b.reduce((sum, p) => sum + p.y, 0) / b.length;
        return avgA - avgB;
    });

    console.log(`   -> ${verticalPaths.length} vertical, ${horizontalPaths.length} horizontal paths (Sorted)`);


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

    // --- FASE 5: SVG Export (New) ---
    if (svgExport) {
        await SvgExporter.generateFromPaths(verticalPaths, horizontalPaths, widthMm, heightMm, outDir);
    }


    console.log("\n✅ Clip mode completato (Streaming)!");
}
program.parse(process.argv);