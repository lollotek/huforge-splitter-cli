// src/index.ts
import { HeightMapper } from './core/HeightMapper';
import { SeamFinder } from './prototypes/SeamFinderInfo'; // Usa la classe creata prima
import { SvgBuilder } from './utils/SvgBuilder';
import path from 'path';

async function main() {
    // 1. INPUT: Percorso STL (Metti un tuo stl nella cartella root per testare)
    const stlPath = path.join(__dirname, '../test-model.stl');
    
    // Se non hai un file, avvisa
    const fs = require('fs');
    if (!fs.existsSync(stlPath)) {
        console.error("ERRORE: Metti un file 'test-model.stl' nella root del progetto per testare!");
        process.exit(1);
    }

    console.log("1. Lettura STL e Generazione HeightMap...");
    const { grid, width, height, maxZ } = await HeightMapper.stlToGrid(stlPath);

    console.log("2. Calcolo Percorso di Taglio...");
    const slicer = new SeamFinder(grid);
    
    // DEFINIZIONE ROI:
    // Supponiamo che il file sia largo (es. 200mm) e vogliamo tagliare a metà
    // Con Resolution 0.5, larghezza pixel = width
    const midPoint = Math.floor(width / 2);
    const tolerance = 20; // +/- 20 pixel (circa 10mm)
    
    const seam = slicer.findVerticalSeam(midPoint - tolerance, midPoint + tolerance);

    console.log("3. Generazione SVG Preview...");
    const svg = new SvgBuilder(width, height);
    
    // Aggiungi sfondo (commentare se troppo lento con file grandi)
    svg.addHeightMapBackground(grid, maxZ);
    
    // Mostra area permessa
    svg.addROI(midPoint - tolerance, tolerance * 2);
    
    // Disegna il taglio
    svg.addCutLine(seam, 'red');

    svg.save('output-preview.svg');
    console.log("Fatto! Apri 'output-preview.svg' nel browser.");
}

main();