import fs from 'fs';

export class HeightMapper {
    // Configurazione risoluzione (mm per pixel)
    // 0.1mm è buono per HueForge

    static async stlToGrid(filePath: string, resolution: number): Promise<{ grid: Float32Array, width: number, height: number, maxZ: number }> {
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
        const gridW = Math.ceil(widthMm / resolution);
        const gridH = Math.ceil(heightMm / resolution);

        console.log(`Dimensioni Mesh: ${widthMm.toFixed(1)}x${heightMm.toFixed(1)}mm`);
        console.log(`Griglia Analisi: ${gridW}x${gridH} pixels (Res: ${resolution}mm)`);

        // Step 2: Popolare la HeightMap (Z-Buffer)
        // Inizializza con 0 (o -1 se necessario, ma 0 è ok per depth map base)
        const grid = new Float32Array(gridW * gridH).fill(0);

        for (let i = 0; i < triangleCount; i++) {
            const offset = headerSize + (i * 50);
            // Prendiamo solo i vertici (approx point cloud)
            for (let v = 0; v < 3; v++) {
                const vOffset = offset + 12 + (v * 12);
                const x = buffer.readFloatLE(vOffset);
                const y = buffer.readFloatLE(vOffset + 4);
                const z = buffer.readFloatLE(vOffset + 8);

                // Mappa coordinate mondo -> coordinate griglia
                const gx = Math.floor((x - minX) / resolution);
                const gy = Math.floor((maxY - y) / resolution);

                // Safe check e Z-Buffer (tieni il punto più alto)
                if (gy >= 0 && gy < gridH && gx >= 0 && gx < gridW) {
                    const idx = gy * gridW + gx;
                    if (z > grid[idx]) {
                        grid[idx] = z;
                    }
                }
            }
        }

        // Step 3: Post-processing (Gap Filling semplice)
        this.fillGaps(grid, gridW, gridH);

        return { grid, width: gridW, height: gridH, maxZ };
    }

    private static fillGaps(grid: Float32Array, w: number, h: number) {
        // Nota: Questa implementazione semplice non è perfetta per Float32Array in place,
        // ma va bene per buchi isolati.
        for (let y = 1; y < h - 1; y++) {
            const rowOffset = y * w;
            const prevRowOffset = (y - 1) * w;
            const nextRowOffset = (y + 1) * w;

            for (let x = 1; x < w - 1; x++) {
                const idx = rowOffset + x;

                if (grid[idx] === 0) {
                    // Media dei vicini se il punto è vuoto
                    // idx-1, idx+1, prevRow+x, nextRow+x
                    const left = grid[idx - 1];
                    const right = grid[idx + 1];
                    const top = grid[prevRowOffset + x];
                    const bottom = grid[nextRowOffset + x];

                    let sum = 0;
                    let count = 0;
                    if (left > 0) { sum += left; count++; }
                    if (right > 0) { sum += right; count++; }
                    if (top > 0) { sum += top; count++; }
                    if (bottom > 0) { sum += bottom; count++; }

                    if (count > 0) {
                        grid[idx] = sum / count;
                    }
                }
            }
        }
    }
}