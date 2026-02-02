import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GuideParser } from './core/GuideParser';
import { SvgExporter } from './utils/SvgExporter';
import { SvgBuilder } from './utils/SvgBuilder';
import { ScadGenerator } from './utils/ScadGenerator';
import { WatershedSegmenter } from './core/watershed/WatershedSegmenter';
import { BoundaryTracer } from './core/watershed/BoundaryTracer';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
    .name('hueslicer')
    .description('CLI tool per generare layout SVG da STL HueForge')
    .version('1.0.0')
    .argument('<file>', 'File STL di input')
    .option('-g, --guide <path>', 'File SVG con i percorsi guida (Opzionale: se mancante, usa auto-tiling)')
    .option('-w, --width <number>', 'Larghezza piatto (mm)', '200')
    .option('-h, --height <number>', 'Altezza piatto (mm)', '200')
    .option('-r, --resolution <number>', 'Risoluzione HeightMap (mm/pixel), default 0.5', '0.5')
    .option('-o, --out <path>', 'Cartella di output', 'output')
    .option('-v, --verbose', 'Attiva log di debug', false)
    .option('--preview', 'Genera solo anteprima SVG, non esporta i singoli tile', false)
    .option('--preview-only', 'Genera solo anteprima SVG, non esporta i singoli tile', false)
    .option('--generate-stls', 'Usa OpenSCAD per generare gli STL finali dei tile', false)
    .option('--openscad <path>', 'Percorso eseguibile OpenSCAD', 'openscad')
    .option('--legacy', 'Usa il metodo legacy (Seam Carving Grid) invece del nuovo Watershed', false)
    .action(async (file, options) => {
        await run(file, options);
    });

async function run(inputFile: string, opts: any) {
    const stlPath = path.resolve(inputFile);
    const GUIDE_FILE = opts.guide;
    const BED_W = parseFloat(opts.width);
    const BED_H = parseFloat(opts.height);
    const RESOLUTION = parseFloat(opts.resolution);
    const OUT_DIR = opts.out;
    const VERBOSE = opts.verbose;
    const PREVIEW = opts.preview;
    const PREVIEW_ONLY = opts.previewOnly;
    const GENERATE_STLS = opts.generateStls;
    const OPENSCAD_PATH = opts.openscad;
    const LEGACY = opts.legacy;

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer SVG Generator su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Res ${RESOLUTION}mm/px`);
    console.log(`🔧 Mode: ${LEGACY ? 'LEGACY (Seam Carving)' : 'WATERSHED'} | Preview: ${PREVIEW || PREVIEW_ONLY}`);
    if (GENERATE_STLS) console.log(`🔨 OpenSCAD STL Generation: ACTIVE (Path: ${OPENSCAD_PATH})`);

    const { SeamFinder } = await import('./prototypes/SeamFinderInfo');

    // 1. Genera HeightMap per trovare seam paths ottimali
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, RESOLUTION);
    const widthMm = mapData.width * RESOLUTION;
    const heightMm = mapData.height * RESOLUTION;

    // Output containers
    let verticalPaths: { x: number, y: number }[][] = [];
    let horizontalPaths: { x: number, y: number }[][] = [];
    let watershedPolygons: { x: number, y: number }[][] = [];
    let generatedTilesFilePaths: string[] = [];

    // 2. Determine Layout (Legacy or Watershed)
    if (LEGACY) {
        console.log("\n--- FASE 2: Estrazione Seam Paths (Legacy) ---");
        let guides: { verticals: boolean[][][], horizontals: boolean[][][] } = { verticals: [], horizontals: [] };

        if (GUIDE_FILE && fs.existsSync(GUIDE_FILE)) {
            guides = GuideParser.parse(GUIDE_FILE, mapData.width, mapData.height);
        } else {
            console.log("⚠️  Nessun file guida fornito. Attivazione AUTO-TILING (Grid).");
            // Auto-Generate Guides
            const cols = Math.ceil(widthMm / BED_W);
            const rows = Math.ceil(heightMm / BED_H);
            console.log(`   -> Auto-Layout: ${cols}x${rows} tiles (Grid based on ${BED_W}x${BED_H}mm)`);

            const SEARCH_WIDTH = 40;
            for (let i = 1; i < cols; i++) {
                const xMm = i * BED_W;
                const xPx = (xMm / widthMm) * mapData.width;
                const pathString = `M ${xPx} 0 L ${xPx} ${mapData.height}`;
                guides.verticals.push(GuideParser.rasterizePath(pathString, SEARCH_WIDTH, mapData.width, mapData.height));
            }
            for (let j = 1; j < rows; j++) {
                const yMm = j * BED_H;
                const yPx = (yMm / heightMm) * mapData.height;
                const pathString = `M 0 ${yPx} L ${mapData.width} ${yPx}`;
                guides.horizontals.push(GuideParser.rasterizePath(pathString, SEARCH_WIDTH, mapData.width, mapData.height));
            }
        }

        const scaleX = widthMm / mapData.width;
        const scaleY = heightMm / mapData.height;

        // Process Verticals
        for (const mask of guides.verticals) {
            const finder = new SeamFinder(mapData.grid, mapData.width, mapData.height);
            finder.setMask(mask);
            const seamPixels = finder.findVerticalSeam(0, mapData.width - 1);
            const seamMm = seamPixels.map((p: any) => ({ x: p.x * scaleX, y: p.y * scaleY }));
            if (seamMm.length > 0) {
                seamMm[0].y = 0; seamMm[seamMm.length - 1].y = heightMm; // Snap
                verticalPaths.push(seamMm);
            }
        }

        // Process Horizontals (Transpose)
        // ... (Simplified inline logic or helper?)
        function transposeMask(mask: boolean[][]): boolean[][] {
            const rows = mask.length; const cols = mask[0].length;
            const result: boolean[][] = Array(cols).fill(null).map(() => Array(rows).fill(false));
            for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) result[x][y] = mask[y][x];
            return result;
        }
        const transposedGrid = new Float32Array(mapData.width * mapData.height);
        for (let y = 0; y < mapData.height; y++)
            for (let x = 0; x < mapData.width; x++)
                transposedGrid[x * mapData.height + y] = mapData.grid[y * mapData.width + x];

        for (const mask of guides.horizontals) {
            const transposedW = mapData.height;
            const transposedH = mapData.width;
            const transposedMask = transposeMask(mask);
            const finder = new SeamFinder(transposedGrid, transposedW, transposedH);
            finder.setMask(transposedMask);
            const seamPixels = finder.findVerticalSeam(0, transposedW - 1);
            const seamMm = seamPixels.map((p: any) => ({ x: p.y * scaleX, y: p.x * scaleY }));
            if (seamMm.length > 0) {
                seamMm[0].x = 0; seamMm[seamMm.length - 1].x = widthMm; // Snap
                horizontalPaths.push(seamMm);
            }
        }

    } else {
        // WATERSHED MODE
        console.log("\n--- FASE 2: Watershed Segmentation ---");

        // 1. Prepare Seeds (Grid Centers)
        const cols = Math.ceil(widthMm / BED_W);
        const rows = Math.ceil(heightMm / BED_H);
        const seeds: { x: number, y: number, label: number }[] = [];
        let labelCounter = 1;

        console.log(`   -> Grid Strategy: ${cols}x${rows} tiles anticipated.`);

        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const cxMm = (i + 0.5) * BED_W; // Midpoint of intended tile
                const cyMm = (j + 0.5) * BED_H;

                // Clamp to image bounds
                const cxMmClamped = Math.min(Math.max(cxMm, 0), widthMm - 1);
                const cyMmClamped = Math.min(Math.max(cyMm, 0), heightMm - 1);

                const cx = Math.floor((cxMmClamped / widthMm) * mapData.width);
                const cy = Math.floor((cyMmClamped / heightMm) * mapData.height);
                seeds.push({ x: cx, y: cy, label: labelCounter++ });
            }
        }
        console.log(`   -> Placed ${seeds.length} seeds.`);

        // 2. Segment
        const segmenter = new WatershedSegmenter(mapData.width, mapData.height, mapData.grid);

        // Apply Barriers from Guide if present
        if (GUIDE_FILE && fs.existsSync(GUIDE_FILE)) {
            const guides = GuideParser.parse(GUIDE_FILE, mapData.width, mapData.height);
            // Use both verticals and horizontal paths as barriers
            for (const mask of guides.verticals) segmenter.applyBarriers(mask, 5000);
            for (const mask of guides.horizontals) segmenter.applyBarriers(mask, 5000);
            console.log("   -> Applied Guide Barriers (High Cost).");
        }

        const labels = segmenter.segment(seeds);
        console.log("   -> Segmentation complete.");

        // 3. Trace
        const tracer = new BoundaryTracer(mapData.width, mapData.height, labels);
        const polygonsMap = tracer.traceAll();

        // Convert to SVG MM Coords
        const scaleX = widthMm / mapData.width;
        const scaleY = heightMm / mapData.height;

        for (const poly of polygonsMap.values()) {
            // Simplify and Scale
            const scaledPoly = poly.map(p => ({
                x: p.x * scaleX,
                y: p.y * scaleY
            }));
            watershedPolygons.push(scaledPoly);
        }
        console.log(`   -> Traced ${watershedPolygons.length} polygon regions.`);
    }

    // Helper: Generate Base64 HeightMap Image
    function generateHeightMapImage(data: { grid: Float32Array, width: number, height: number }): string {
        const { createCanvas } = require('canvas');
        const canvas = createCanvas(data.width, data.height);
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(data.width, data.height);

        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < data.grid.length; i++) {
            if (data.grid[i] > maxZ) maxZ = data.grid[i];
            if (data.grid[i] < minZ) minZ = data.grid[i];
        }
        const range = maxZ - minZ || 1;

        for (let i = 0; i < data.grid.length; i++) {
            const val = data.grid[i];
            const norm = Math.floor(((val - minZ) / range) * 255);
            const idx = i * 4;
            imgData.data[idx] = norm;     // R
            imgData.data[idx + 1] = norm; // G
            imgData.data[idx + 2] = norm; // B
            imgData.data[idx + 3] = 255;  // A
        }

        ctx.putImageData(imgData, 0, 0);
        return canvas.toDataURL();
    }

    // 4. Generate SVG Preview
    if (VERBOSE || PREVIEW_ONLY || PREVIEW) {
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        const svgPath = path.join(OUT_DIR, '_preview_cuts.svg');
        console.log(`\n--- Generating Preview: ${svgPath} ---`);
        const builder = new SvgBuilder(widthMm, heightMm);

        try {
            const bgImage = generateHeightMapImage(mapData);
            builder.setBackground(bgImage);
        } catch (e) {
            console.warn("   -> Failed to generate background image:", e);
        }

        if (LEGACY) {
            verticalPaths.forEach(p => builder.addCutLine(p, 'red'));
            horizontalPaths.forEach(p => builder.addCutLine(p, 'blue'));
        } else {
            // Visualize Watershed Polygons
            watershedPolygons.forEach(p => builder.addCutLine(p, 'lime'));
        }

        builder.save(svgPath);
    }

    // --- FASE 5: SVG Export ---
    if (!PREVIEW_ONLY) {
        console.log("\n--- FASE 5: Exporting Tiles Layout SVG ---");
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

        if (LEGACY) {
            generatedTilesFilePaths = await SvgExporter.generateFromPaths(verticalPaths, horizontalPaths, widthMm, heightMm, OUT_DIR);
        } else {
            generatedTilesFilePaths = await SvgExporter.generateFromPolygons(watershedPolygons, widthMm, heightMm, OUT_DIR);
        }

        console.log(`✅ ${generatedTilesFilePaths.length} Tile SVGs generati in: ${OUT_DIR}`);

        // FASE 6: OpenSCAD STL Generation
        if (GENERATE_STLS) {
            console.log("\n--- FASE 6: Generazione STL con OpenSCAD ---");
            const scadGen = new ScadGenerator(OPENSCAD_PATH);

            for (const tileSvg of generatedTilesFilePaths) {
                const tileName = path.basename(tileSvg, '.svg');
                const stlOut = path.join(OUT_DIR, `${tileName}.stl`);

                try {
                    await scadGen.generateTileStl(stlPath, tileSvg, stlOut, 100);
                    console.log(`   ✨ Generated: ${path.basename(stlOut)}`);
                } catch (e) {
                    console.error(`   ❌ Failed to generate STL for ${tileName}`);
                }
            }
        }
    }

    console.log("\n✅ Processo completato!");
}

program.parse(process.argv);