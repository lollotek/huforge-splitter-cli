export class SeamFinder {
    private width: number;
    private height: number;
    private data: Float32Array;
    private mask: Int8Array | null = null; // Flattened mask

    constructor(heightMap: Float32Array, width: number, height: number) {
        this.data = heightMap;
        this.width = width;
        this.height = height;
    }

    // Permette di caricare una maschera (true = zona permessa, false = zona proibita)
    public setMask(mask: boolean[][]) {
        // Verifica dimensioni
        if (mask.length !== this.height || mask[0].length !== this.width) {
            console.warn("⚠️ Warning: Dimensioni maschera diverse dalla mappa. La maschera verrà ignorata.");
            return;
        }
        this.mask = new Int8Array(this.width * this.height);
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                this.mask[y * this.width + x] = mask[y][x] ? 1 : 0;
            }
        }
    }

    private calculateEnergyMap(): Float32Array {
        const energyMap = new Float32Array(this.width * this.height);

        for (let y = 0; y < this.height; y++) {
            const rowOffset = y * this.width;
            for (let x = 0; x < this.width; x++) {
                const idx = rowOffset + x;

                // SE C'È UNA MASCHERA e siamo fuori zona -> Costo Infinito
                if (this.mask && this.mask[idx] === 0) {
                    energyMap[idx] = Infinity;
                    continue;
                }

                const rightNeighbor = x < this.width - 1 ? this.data[idx + 1] : this.data[idx];
                const gradient = Math.abs(this.data[idx] - rightNeighbor);

                // Costo standard: Più alto il gradiente (bordo), minore il costo.
                energyMap[idx] = 100.0 / (gradient + 1.0);
            }
        }
        return energyMap;
    }

    public findVerticalSeam(roiStart: number, roiEnd: number): { x: number, y: number }[] {
        const energyMap = this.calculateEnergyMap();
        const dist = new Float32Array(this.width * this.height).fill(Infinity);
        const parent = new Int32Array(this.width * this.height).fill(0);

        // Inizializzazione prima riga
        for (let x = roiStart; x <= roiEnd; x++) {
            if (x >= 0 && x < this.width) {
                // Se la maschera blocca l'inizio, è infinito
                dist[x] = energyMap[x];
            }
        }

        // DP
        for (let y = 0; y < this.height - 1; y++) {
            const rowOffset = y * this.width;
            const nextRowOffset = (y + 1) * this.width;

            for (let x = roiStart; x <= roiEnd; x++) {
                const currIdx = rowOffset + x;
                if (dist[currIdx] === Infinity) continue;

                // neighbors relative to x: -1, 0, +1
                const startNx = Math.max(0, x - 1);
                const endNx = Math.min(this.width - 1, x + 1);

                for (let nx = startNx; nx <= endNx; nx++) {
                    // Check logic constraints
                    if (nx < roiStart || nx > roiEnd) continue;

                    const nextIdx = nextRowOffset + nx;
                    const cost = energyMap[nextIdx];

                    if (cost === Infinity) continue; // Non camminare su lava

                    const newCost = dist[currIdx] + cost;
                    if (newCost < dist[nextIdx]) {
                        dist[nextIdx] = newCost;
                        parent[nextIdx] = x; // store PARENT x coordinate
                    }
                }
            }
        }

        // Backtracking
        let minCost = Infinity;
        let endX = -1;

        const lastRowOffset = (this.height - 1) * this.width;

        // Cerchiamo l'uscita migliore
        for (let x = roiStart; x <= roiEnd; x++) {
            const idx = lastRowOffset + x;
            if (dist[idx] < minCost) {
                minCost = dist[idx];
                endX = x;
            }
        }

        if (endX === -1) {
            // Fallback
            console.warn("⚠️ Percorso impossibile nella guida. Uso linea retta fallback.");
            const mid = Math.floor((roiStart + roiEnd) / 2);
            return Array(this.height).fill(0).map((_, y) => ({ x: mid, y }));
        }

        const path: { x: number, y: number }[] = [];
        let currX = endX;
        for (let y = this.height - 1; y >= 0; y--) {
            path.push({ x: currX, y });
            // Look up parent for current pixel
            currX = parent[y * this.width + currX];
        }

        return path.reverse();
    }
}