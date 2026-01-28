export class SeamFinder {
    private width: number;
    private height: number;
    private data: number[][]; 
    private mask: boolean[][] | null = null; // Nuova Maschera Opzionale

    constructor(heightMap: number[][]) {
        this.data = heightMap;
        this.height = heightMap.length;
        this.width = heightMap[0].length;
    }

    // Permette di caricare una maschera (true = zona permessa, false = zona proibita)
    public setMask(mask: boolean[][]) {
        // Verifica dimensioni
        if (mask.length !== this.height || mask[0].length !== this.width) {
            console.warn("⚠️ Warning: Dimensioni maschera diverse dalla mappa. La maschera verrà ignorata.");
            return;
        }
        this.mask = mask;
    }

    private calculateEnergyMap(): number[][] {
        const energyMap: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(0));

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                // SE C'È UNA MASCHERA e siamo fuori zona -> Costo Infinito
                if (this.mask && !this.mask[y][x]) {
                    energyMap[y][x] = Infinity;
                    continue;
                }

                const rightNeighbor = x < this.width - 1 ? this.data[y][x + 1] : this.data[y][x];
                const gradient = Math.abs(this.data[y][x] - rightNeighbor);
                
                // Costo standard: Più alto il gradiente (bordo), minore il costo.
                energyMap[y][x] = 100 / (gradient + 1); 
            }
        }
        return energyMap;
    }

    public findVerticalSeam(roiStart: number, roiEnd: number): {x: number, y: number}[] {
        const energyMap = this.calculateEnergyMap();
        const dist: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(Infinity));
        const parent: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(0));

        // Inizializzazione prima riga
        for (let x = roiStart; x <= roiEnd; x++) {
            if (x >= 0 && x < this.width) {
                // Se la maschera blocca l'inizio, è infinito
                dist[0][x] = energyMap[0][x];
            }
        }

        // DP
        for (let y = 0; y < this.height - 1; y++) {
            for (let x = roiStart; x <= roiEnd; x++) {
                if (dist[y][x] === Infinity) continue;

                const neighbors = [x - 1, x, x + 1];
                for (const nx of neighbors) {
                    if (nx >= roiStart && nx <= roiEnd && nx >= 0 && nx < this.width) {
                        const cost = energyMap[y + 1][nx];
                        if (cost === Infinity) continue; // Non camminare su lava

                        const newCost = dist[y][x] + cost;
                        if (newCost < dist[y + 1][nx]) {
                            dist[y + 1][nx] = newCost;
                            parent[y + 1][nx] = x;
                        }
                    }
                }
            }
        }

        // Backtracking
        let minCost = Infinity;
        let endX = -1;
        
        // Cerchiamo l'uscita migliore
        for (let x = roiStart; x <= roiEnd; x++) {
            if (dist[this.height - 1][x] < minCost) {
                minCost = dist[this.height - 1][x];
                endX = x;
            }
        }

        if (endX === -1) {
            // Fallback: Se l'utente ha disegnato un percorso impossibile (interrotto), 
            // restituisci una linea retta al centro della ROI per non crashare.
            console.warn("⚠️ Percorso impossibile nella guida. Uso linea retta fallback.");
            const mid = Math.floor((roiStart + roiEnd) / 2);
            return Array(this.height).fill(0).map((_, y) => ({ x: mid, y }));
        }

        const path: {x: number, y: number}[] = [];
        let currX = endX;
        for (let y = this.height - 1; y >= 0; y--) {
            path.push({ x: currX, y });
            currX = parent[y][currX];
        }

        return path.reverse();
    }
}