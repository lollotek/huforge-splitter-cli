import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GuideParser } from './core/GuideParser';
import { SvgExporter } from './utils/SvgExporter';
import { SvgBuilder } from './utils/SvgBuilder';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
    .name('hueslicer')
    .description('CLI tool per generare layout SVG da STL HueForge')
    .version('1.0.0')
    .argument('<file>', 'File STL di input')
    .requiredOption('-g, --guide <path>', 'File SVG con i percorsi guida')
    .option('-w, --width <number>', 'Larghezza piatto (mm)', '200')
    .option('-h, --height <number>', 'Altezza piatto (mm)', '200')
    .option('-r, --resolution <number>', 'Risoluzione HeightMap (mm/pixel), default 0.5', '0.5')
    .option('-o, --out <path>', 'Cartella di output', 'output')
    .option('-v, --verbose', 'Attiva log di debug', false)
    .option('--preview', 'Genera solo anteprima SVG, non esporta i singoli tile', false)
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
    const PREVIEW_ONLY = opts.preview;

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }
    if (!fs.existsSync(GUIDE_FILE)) { console.error("File guida non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer SVG Generator su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Res ${RESOLUTION}mm/px`);
    console.log(`🔧 Mode: ${PREVIEW_ONLY ? 'PREVIEW ONLY' : 'EXPORT'} | Verbose: ${VERBOSE}`);

    const { SeamFinder } = await import('./prototypes/SeamFinderInfo');

    // 1. Genera HeightMap per trovare seam paths ottimali
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath, RESOLUTION);
    const widthMm = mapData.width * RESOLUTION;
    const heightMm = mapData.height * RESOLUTION;

    // 2. Parse Guide SVG per estrarre seam paths
    console.log("\n--- FASE 2: Estrazione Seam Paths ---");
    const guides = GuideParser.parse(GUIDE_FILE, mapData.width, mapData.height);

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

    // 4. Generate SVG Preview (Always useful to debug what we found)
    if (VERBOSE || PREVIEW_ONLY) {
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        const svgPath = path.join(OUT_DIR, '_preview_cuts.svg');
        console.log(`\n--- Generating Preview: ${svgPath} ---`);
        const builder = new SvgBuilder(widthMm, heightMm);

        verticalPaths.forEach(p => builder.addCutLine(p, 'red'));
        horizontalPaths.forEach(p => builder.addCutLine(p, 'blue'));

        builder.save(svgPath);
    }

    // --- FASE 5: SVG Export ---
    if (!PREVIEW_ONLY) {
        console.log("\n--- FASE 5: Exporting Tiles Layout SVG ---");
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        // Use standard name for output
        await SvgExporter.generateFromPaths(verticalPaths, horizontalPaths, widthMm, heightMm, OUT_DIR);
        console.log(`✅ SVG generato in: ${OUT_DIR}`);
    }

    console.log("\n✅ Processo completato!");
}

program.parse(process.argv);