// src/index.ts
import { HeightMapper } from './core/HeightMapper';
import { SeamFinder } from './prototypes/SeamFinderInfo';
import { SvgBuilder } from './utils/SvgBuilder';
import { GeometryProcessor } from './core/GeometryProcessor'; // Import nuovo
import path from 'path';
import fs from 'fs';

async function main() {
    // 1. CONFIGURAZIONE
    const inputFile = 'test-model.stl'; // File da mettere nella root
    const stlPath = path.join(process.cwd(), inputFile);
    const tolerance = 0.2; // mm di gap

    if (!fs.existsSync(stlPath)) {
        console.error(`❌ Errore: File '${inputFile}' non trovato.`);
        process.exit(1);
    }

    console.time("Tempo Totale");

    // 2. ANALISI 2D
    console.log("\n--- FASE 1: Analisi Topologica ---");
    // Risoluzione 0.2mm per pixel per bilanciare velocità e dettaglio
    const mapData = await HeightMapper.stlToGrid(stlPath); 
    
    // Cerchiamo il taglio al centro +/- 15mm
    const pixelScale = 0.5; // (Deve coincidere con quello usato in HeightMapper, controlla quel file!)
    // NB: Nel HeightMapper precedente avevi messo RESOLUTION = 0.5. 
    // Assicurati che mapData.width corrisponda ai mm reali / 0.5
    
    const midPixel = Math.floor(mapData.width / 2);
    const rangePixels = Math.floor(30 / 0.5); // 30mm di range totale
    
    console.log(`Analisi taglio su range pixel: ${midPixel - rangePixels/2} - ${midPixel + rangePixels/2}`);
    
    const finder = new SeamFinder(mapData.grid);
    const seamPath = finder.findVerticalSeam(
        midPixel - rangePixels/2, 
        midPixel + rangePixels/2
    );

    // 3. EXPORT PREVIEW
    console.log("Generazione Preview SVG...");
    const svg = new SvgBuilder(mapData.width, mapData.height);
    // svg.addHeightMapBackground(mapData.grid, mapData.maxZ); // Opzionale: decommenta per vedere sfondo (lento)
    svg.addROI(midPixel - rangePixels/2, rangePixels);
    svg.addCutLine(seamPath);
    svg.save('preview-cut.svg');

    // 4. ELABORAZIONE 3D
    console.log("\n--- FASE 2: Taglio Geometrico ---");
    const geo = new GeometryProcessor();
    
    await geo.sliceAndSave(
        stlPath,
        seamPath,
        mapData.width,
        mapData.height,
        'output_part', // Prefisso file output
        tolerance
    );

    console.timeEnd("Tempo Totale");
}

main();