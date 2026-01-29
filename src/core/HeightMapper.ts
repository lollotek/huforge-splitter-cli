import fs from 'fs';

export class HeightMapper {
    // Configurazione risoluzione (mm per pixel)
    // 0.1mm è buono per HueForge
    private static RESOLUTION = 0.5; // Teniamo 0.5 per test veloci, abbassare a 0.1 per produzione

    static async stlToGrid(filePath: string): Promise<{ grid: number[][], width: number, height: number, maxZ: number }> {
        const buffer = fs.readFileSync(filePath);
        
        // STL Binary Header è 80 bytes
        // Poi 4 bytes (unsigned long) per il numero di triangoli
        const triangleCount = buffer.readUInt32LE(80);
        
        console.log(`Processing STL: ${triangleCount} triangles...`);

        // Step 1: Trovare i limiti (Bounding Box) per dimensionare la griglia
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let maxZ = -Infinity;

        // Loop veloce per trovare le dimensioni
        // Ogni triangolo è 50 bytes: Normal(12) + V1(12) + V2(12) + V3(12) + Attr(2)
        const headerSize = 84;
        
        for (let i = 0; i < triangleCount; i++) {
            const offset = headerSize + (i * 50);
            for (let v = 0; v < 3; v++) {
                const vOffset = offset + 12 + (v * 12); // Salta la normale
                const x = buffer.readFloatLE(vOffset);
                const y = buffer.readFloatLE(vOffset + 4);
                const z = buffer.readFloatLE(vOffset + 8);

                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                if (z > maxZ) maxZ = z;
            }
        }

        const widthMm = maxX - minX;
        const heightMm = maxY - minY;
        const gridW = Math.ceil(widthMm / this.RESOLUTION);
        const gridH = Math.ceil(heightMm / this.RESOLUTION);

        console.log(`Dimensioni Mesh: ${widthMm.toFixed(1)}x${heightMm.toFixed(1)}mm`);
        console.log(`Griglia Analisi: ${gridW}x${gridH} pixels`);

        // Step 2: Popolare la HeightMap (Z-Buffer)
        // Inizializza con -1
        const grid: number[][] = Array(gridH).fill(0).map(() => Array(gridW).fill(0));

        for (let i = 0; i < triangleCount; i++) {
            const offset = headerSize + (i * 50);
            // Prendiamo solo i vertici (approx point cloud)
            // Per maggiore precisione servirebbe rasterizzazione triangolo, 
            // ma per HueForge i vertici sono molto densi.
            for (let v = 0; v < 3; v++) {
                const vOffset = offset + 12 + (v * 12);
                const x = buffer.readFloatLE(vOffset);
                const y = buffer.readFloatLE(vOffset + 4);
                const z = buffer.readFloatLE(vOffset + 8);

                // Mappa coordinate mondo -> coordinate griglia
                const gx = Math.floor((x - minX) / this.RESOLUTION);
                const gy = Math.floor((maxY - y) / this.RESOLUTION);

                // Safe check e Z-Buffer (tieni il punto più alto)
                if (gy >= 0 && gy < gridH && gx >= 0 && gx < gridW) {
                    if (z > grid[gy][gx]) {
                        grid[gy][gx] = z;
                    }
                }
            }
        }

        // Step 3: Post-processing (Gap Filling semplice)
        // Se la risoluzione è troppo alta rispetto alla mesh, ci saranno buchi neri (0)
        // Facciamo un passaggio semplice per riempire i buchi con i vicini
        this.fillGaps(grid, gridW, gridH);

        return { grid, width: gridW, height: gridH, maxZ };
    }

    private static fillGaps(grid: number[][], w: number, h: number) {
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                if (grid[y][x] === 0) {
                    // Media dei vicini se il punto è vuoto
                    const neighbors = [
                        grid[y][x-1], grid[y][x+1], 
                        grid[y-1][x], grid[y+1][x]
                    ].filter(n => n > 0);
                    
                    if (neighbors.length > 0) {
                        grid[y][x] = neighbors.reduce((a,b) => a+b) / neighbors.length;
                    }
                }
            }
        }
    }
}