import { Command } from 'commander';
import { HeightMapper } from './core/HeightMapper';
import { GeometryProcessor } from './core/GeometryProcessor';
import { TilingManager } from './core/TilingManager';
import { SvgBuilder } from './utils/SvgBuilder';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
  .name('hueslicer')
  .description('CLI tool per tagliare STL HueForge con seam carving organico')
  .version('1.0.0')
  .argument('<file>', 'File STL di input')
  .option('-w, --width <number>', 'Larghezza piatto (mm)', '200')
  .option('-h, --height <number>', 'Altezza piatto (mm)', '200')
  .option('-t, --tolerance <number>', 'Tolleranza/Gap taglio (mm)', '0.2')
  .option('-p, --preview', 'Genera solo SVG di anteprima (nessun export STL)', false)
  .option('-o, --out <path>', 'Cartella di output', 'output')
  .action(async (file, options) => {
      await run(file, options);
  });

async function run(inputFile: string, opts: any) {
    const stlPath = path.resolve(inputFile);
    
    // Parsing Opzioni
    const BED_W = parseFloat(opts.width);
    const BED_H = parseFloat(opts.height);
    const TOLERANCE = parseFloat(opts.tolerance);
    const PREVIEW_ONLY = opts.preview;
    const OUT_DIR = opts.out;

    if (!fs.existsSync(stlPath)) {
        console.error(`❌ Errore: File '${stlPath}' non trovato.`);
        process.exit(1);
    }

    console.log(`\n🚀 Avvio HueSlicer su: ${path.basename(stlPath)}`);
    console.log(`⚙️  Config: Bed ${BED_W}x${BED_H}mm, Tolleranza ${TOLERANCE}mm, Mode: ${PREVIEW_ONLY ? 'PREVIEW' : 'EXPORT'}`);

    console.time("Tempo Totale");

    // 1. HeightMap
    console.log("\n--- FASE 1: Analisi Topologica ---");
    const mapData = await HeightMapper.stlToGrid(stlPath);
    // Nota: HeightMapper.RESOLUTION deve essere 0.5 (controlla il file core)
    const RESOLUTION = 0.5; 
    const widthMm = mapData.width * RESOLUTION;
    const heightMm = mapData.height * RESOLUTION;
    
    // 2. Geometria
    console.log("\n--- FASE 2: Setup Geometria ---");
    const geo = new GeometryProcessor();
    await geo.init();
    const originalMesh = await geo.loadMesh(stlPath);

    // --- FIX: Salviamo i bounds ORA, prima che la mesh venga distrutta dal Tiler ---
    const globalBounds = originalMesh.boundingBox();
    const globalMinX = globalBounds.min[0];
    const globalMaxY = globalBounds.max[1];
    // -----------------------------------------------------------------------------

    // 3. Processo Tiling
    console.log("\n--- FASE 3: Calcolo Tagli ---");
    const tiler = new TilingManager(geo, mapData.grid, widthMm, heightMm);
    
    // Eseguiamo sempre il processo completo per calcolare i percorsi corretti
    const result = await tiler.process(originalMesh, BED_W, BED_H, TOLERANCE);

    // 4. Export SVG Preview (Sempre utile)
    console.log("\n--- FASE 4: Generazione Report ---");
    const svg = new SvgBuilder(mapData.width, mapData.height);
    // Disegna tutti i tagli raccolti
    result.paths.forEach(path => svg.addCutLine(path, '#ff0055'));
    
    // Disegna i box dei pezzi finali
    for (const part of result.parts) {
        // La mesh parziale esiste ancora (è in finishedParts), quindi possiamo chiederne i bounds
        const bounds = part.mesh.boundingBox();
        
        // --- FIX: Usiamo le variabili salvate (globalMinX, globalMaxY) ---
        const bX = (bounds.min[0] - globalMinX) / RESOLUTION;
        
        // Inversione Y per coordinate immagine
        // STL Y_MAX -> Img Y_0. STL Y -> Img Y = (MaxY_Global - Y) / Res
        const bY = (globalMaxY - bounds.max[1]) / RESOLUTION;
        
        const bW = (bounds.max[0] - bounds.min[0]) / RESOLUTION;
        const bH = (bounds.max[1] - bounds.min[1]) / RESOLUTION;
        svg.addRect(bX, bY, bW, bH, '#00ccff');
    }
    svg.save('preview_cuts.svg');

    // 5. Export STL (Solo se non siamo in preview mode)
    if (!PREVIEW_ONLY) {
        console.log(`\n--- FASE 5: Salvataggio STL in '${OUT_DIR}/' ---`);
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

        for (const part of result.parts) {
            geo.saveMesh(part.mesh, path.join(OUT_DIR, `${part.name}.stl`));
            part.mesh.delete(); 
        }
    } else {
        console.log("\n⚠️  Modalità Preview: File STL non salvati.");
        // Pulizia memoria comunque
        result.parts.forEach(p => p.mesh.delete());
    }

    console.timeEnd("Tempo Totale");
}

program.parse(process.argv);