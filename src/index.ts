import { HeightMapper } from './core/HeightMapper';
import { GeometryProcessor } from './core/GeometryProcessor';
import { TilingManager } from './core/TilingManager';
import path from 'path';
import fs from 'fs';

async function main() {
    // --- CONFIGURAZIONE ---
    const inputFile = 'test-model.stl'; 
    const BED_W = 200; // Esempio: Piatto 200x200
    const BED_H = 200;
    const TOLERANCE = 0.2;
    // ----------------------

    const stlPath = path.join(process.cwd(), inputFile);
    if (!fs.existsSync(stlPath)) { console.error("File non trovato"); process.exit(1); }

    console.time("Processo Completo");

    // 1. Mappa 2D
    console.log("--- FASE 1: Analisi HeightMap ---");
    const mapData = await HeightMapper.stlToGrid(stlPath);
    // Nota: HeightMapper.RESOLUTION deve essere consistente.
    // Calcoliamo le dimensioni reali in base alla mappa
    const widthMm = mapData.width * 0.5; // Assumendo RESOLUTION = 0.5 in HeightMapper
    const heightMm = mapData.height * 0.5;
    
    // 2. Setup Geometria
    console.log("--- FASE 2: Setup Geometria ---");
    const geo = new GeometryProcessor();
    await geo.init();
    const originalMesh = await geo.loadMesh(stlPath);

    // 3. Tiling Manager (Il Cervello)
    console.log("--- FASE 3: Tiling Intelligente ---");
    const tiler = new TilingManager(geo, mapData.grid, widthMm, heightMm);
    
    // Avvia processo ricorsivo
    const finalParts = await tiler.process(originalMesh, BED_W, BED_H, TOLERANCE);

    // 4. Salvataggio
    console.log(`\n--- FASE 4: Salvataggio (${finalParts.length} parti) ---`);
    if (!fs.existsSync('output')) fs.mkdirSync('output');

    for (const part of finalParts) {
        geo.saveMesh(part.mesh, `output/${part.name}.stl`);
    }

    console.timeEnd("Processo Completo");
}

main();