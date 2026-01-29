import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GeometryProcessor } from './core/GeometryProcessor';
import { TilingManager } from './core/TilingManager';
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
  .option('-p, --preview', 'Genera solo SVG di anteprima')
  .option('-o, --out <path>', 'Cartella di output', 'output')
  .option('-g, --guide <path>', 'File SVG con i percorsi guida')
  .option('-s, --safe', 'Usa modalità sicura (Niente smoothing, pulizia aggressiva). Utile se il tool crasha.', false)
  .option('-v, --verbose', 'Attiva log di debug e salva le mesh di taglio intermedie', false)
  .action(async (file, options) => {
      await run(file, options);
  });

async function run(inputFile: string, opts: any) {
    const stlPath = path.resolve(inputFile);
    const BED_W = parseFloat(opts.width);
    const BED_H = parseFloat(opts.height);
    const TOLERANCE = parseFloat(opts.tolerance);
    const PREVIEW_ONLY = opts.preview;
    const OUT_DIR = opts.out;
    const GUIDE_FILE = opts.guide;
    const SAFE_MODE = opts.safe;
    const VERBOSE = opts.verbose;

    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.log(`🚀 Avvio HueSlicer su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Tolleranza ${TOLERANCE}mm`);
    console.log(`🔧 Mode: ${PREVIEW_ONLY ? 'PREVIEW' : 'EXPORT'} | Safe: ${SAFE_MODE} | Verbose: ${VERBOSE}`);

    // 1. HeightMap
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath);
    const RESOLUTION = 0.5; 
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
    const tiler = new TilingManager(geo, mapData.grid, widthMm, heightMm);
    
    // Passiamo SAFE_MODE al tiler
    const result = await tiler.process(originalMesh, BED_W, BED_H, TOLERANCE, GUIDE_FILE, SAFE_MODE);

    // 4. Export SVG Preview
    console.log("\n--- FASE 4: Generazione Report ---");
    const svg = new SvgBuilder(mapData.width, mapData.height);
    
    try {
        const base64Img = ImageGenerator.gridToBase64(mapData.grid, mapData.width, mapData.height, mapData.maxZ);
        svg.setBackground(base64Img);
    } catch(e) { console.warn("⚠️ Impossibile generare sfondo immagine."); }

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

program.parse(process.argv);