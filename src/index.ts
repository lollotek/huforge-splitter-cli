import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GuideParser } from './core/GuideParser';
import { SvgExporter } from './utils/SvgExporter';
import { SvgBuilder } from './utils/SvgBuilder';
import { ScadGenerator } from './utils/ScadGenerator';
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

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer SVG Generator su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Res ${RESOLUTION}mm/px`);
    console.log(`🔧 Mode: ${PREVIEW_ONLY ? 'PREVIEW ONLY' : 'EXPORT'} | Verbose: ${VERBOSE}`);
    if (GENERATE_STLS) console.log(`🔨 OpenSCAD STL Generation: ACTIVE (Path: ${OPENSCAD_PATH})`);

    const { SeamFinder } = await import('./prototypes/SeamFinderInfo');

    // 1. Genera HeightMap per trovare seam paths ottimali
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, RESOLUTION);
    const widthMm = mapData.width * RESOLUTION;
    const heightMm = mapData.height * RESOLUTION;

    // 2. Determine Guides (File or Auto-Gen)
    console.log("\n--- FASE 2: Estrazione Seam Paths ---");
    let guides: { verticals: boolean[][][], horizontals: boolean[][][] } = { verticals: [], horizontals: [] };

    if (GUIDE_FILE && fs.existsSync(GUIDE_FILE)) {
        guides = GuideParser.parse(GUIDE_FILE, mapData.width, mapData.height);
    } else {
        console.log("⚠️  Nessun file guida fornito. Attivazione AUTO-TILING.");

        // Auto-Generate Guides
        const cols = Math.ceil(widthMm / BED_W);
        const rows = Math.ceil(heightMm / BED_H);
        console.log(`   -> Auto-Layout: ${cols}x${rows} tiles (Grid based on ${BED_W}x${BED_H}mm)`);

        const SEARCH_WIDTH = 40; // Default search corridor width for auto-tiling

        // Generate Vertical Cuts
        for (let i = 1; i < cols; i++) {
            const xMm = i * BED_W;
            // Let's use PIXELS because 'w' and 'h' passed to rasterizePath are mapData.width/height (pixels).
            const xPx = (xMm / widthMm) * mapData.width;
            const pathString = `M ${xPx} 0 L ${xPx} ${mapData.height}`;
            console.log(`   -> Auto Vertical Cut @ ${xMm.toFixed(1)}mm (px: ${xPx.toFixed(1)})`);

            const mask = GuideParser.rasterizePath(pathString, SEARCH_WIDTH, mapData.width, mapData.height);
            guides.verticals.push(mask);
        }

        // Generate Horizontal Cuts
        for (let j = 1; j < rows; j++) {
            const yMm = j * BED_H;
            const yPx = (yMm / heightMm) * mapData.height;
            const pathString = `M 0 ${yPx} L ${mapData.width} ${yPx}`;
            console.log(`   -> Auto Horizontal Cut @ ${yMm.toFixed(1)}mm (px: ${yPx.toFixed(1)})`);

            const mask = GuideParser.rasterizePath(pathString, SEARCH_WIDTH, mapData.width, mapData.height);
            guides.horizontals.push(mask);
        }
    }

    // Estrai paths (SVG Layout coords mm 0,0 Top-Left) usando SeamFinder
    const verticalPaths: { x: number, y: number }[][] = [];
    const horizontalPaths: { x: number, y: number }[][] = [];

    const scaleX = widthMm / mapData.width;
    const scaleY = heightMm / mapData.height;

    for (const mask of guides.verticals) {
        const finder = new SeamFinder(mapData.grid, mapData.width, mapData.height);
        finder.setMask(mask);
        const seamPixels = finder.findVerticalSeam(0, mapData.width - 1);
        // Converti pixel -> SVG coords mm (Y-Down, 0,0 Top-Left)
        const seamMm = seamPixels.map((p: { x: number, y: number }) => ({
            x: p.x * scaleX,
            y: p.y * scaleY
        }));
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            seamMm[0].y = 0;
            seamMm[seamMm.length - 1].y = heightMm;

            verticalPaths.push(seamMm);
        }

        if (VERBOSE && seamMm.length > 0) {
            const xMin = Math.min(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            const xMax = Math.max(...seamMm.map((p: { x: number, y: number }) => p.x)).toFixed(1);
            console.log(`   Vertical path: X range [${xMin}, ${xMax}] (Snapped Y)`);
        }
    }

    // Helper: Transpone una maschera booleana 2D
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
            x: p.y * scaleX,   // Trasposto (y originale = x)
            y: p.x * scaleY    // Trasposto (x originale = y)
        }));
        if (seamMm.length > 0) {
            // SNAP TO BOUNDS (Fix gap error)
            seamMm[0].x = 0;
            seamMm[seamMm.length - 1].x = widthMm;

            horizontalPaths.push(seamMm);
        }

        if (VERBOSE && seamMm.length > 0) {
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

    // 4. Generate SVG Preview (Always useful to debug what we found)
    if (VERBOSE || PREVIEW_ONLY || PREVIEW) {
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        const svgPath = path.join(OUT_DIR, '_preview_cuts.svg');
        console.log(`\n--- Generating Preview: ${svgPath} ---`);
        const builder = new SvgBuilder(widthMm, heightMm);

        try {
            const bgImage = generateHeightMapImage(mapData);
            builder.setBackground(bgImage);
            console.log("   -> Background image set (HeightMap)");
        } catch (e) {
            console.warn("   -> Failed to generate background image:", e);
        }

        verticalPaths.forEach(p => builder.addCutLine(p, 'red'));
        horizontalPaths.forEach(p => builder.addCutLine(p, 'blue'));

        builder.save(svgPath);
    }

    // --- FASE 5: SVG Export ---
    if (!PREVIEW_ONLY) {
        console.log("\n--- FASE 5: Exporting Tiles Layout SVG ---");
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

        // Export SVGs
        const generatedTiles = await SvgExporter.generateFromPaths(verticalPaths, horizontalPaths, widthMm, heightMm, OUT_DIR);
        console.log(`✅ ${generatedTiles.length} Tile SVGs generati in: ${OUT_DIR}`);

        // FASE 6: OpenSCAD STL Generation
        if (GENERATE_STLS) {
            console.log("\n--- FASE 6: Generazione STL con OpenSCAD ---");
            const scadGen = new ScadGenerator(OPENSCAD_PATH);

            for (const tileSvg of generatedTiles) {
                const tileName = path.basename(tileSvg, '.svg');
                const stlOut = path.join(OUT_DIR, `${tileName}.stl`);

                try {
                    await scadGen.generateTileStl(stlPath, tileSvg, stlOut, 100); // 100mm extrusion height
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