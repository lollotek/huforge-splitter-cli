/**
 * HueSlicer - Core Algorithm Prototype
 * Obiettivo: Trovare il percorso a 'costo minimo' dall'alto al basso.
 * In HueForge: Costo Basso = Bordi/Dettagli (nascondono il taglio).
 * Costo Alto = Zone Piatte (il taglio si vede).
 */

type Point = { x: number; y: number };

export class SeamFinder {
    private width: number;
    private height: number;
    private data: number[][]; // La mappa di altezza (0-255 o float)

    constructor(heightMap: number[][]) {
        this.data = heightMap;
        this.height = heightMap.length;
        this.width = heightMap[0].length;
    }

    // 1. Calcola la "Mappa dei Costi" (Inversa del gradiente)
    // Se c'è una forte differenza tra pixel vicini (bordo), il costo è BASSO.
    // Se è piatto, il costo è ALTO.
    private calculateEnergyMap(): number[][] {
        const energyMap: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(0));

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                // Calcolo semplice del gradiente (differenza col vicino destro)
                const rightNeighbor = x < this.width - 1 ? this.data[y][x + 1] : this.data[y][x];
                const gradient = Math.abs(this.data[y][x] - rightNeighbor);
                
                // FORMULA CHIAVE: 
                // Più alto è il gradiente, più basso è il costo.
                // Aggiungiamo 1 per evitare divisioni per zero.
                // 100 è un peso arbitrario per penalizzare le zone piatte.
                energyMap[y][x] = 100 / (gradient + 1); 
            }
        }
        return energyMap;
    }

    // 2. Dynamic Programming per trovare il percorso
    public findVerticalSeam(roiStart: number, roiEnd: number): Point[] {
        const energyMap = this.calculateEnergyMap();
        
        // Matrice di accumulo costi
        const dist: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(Infinity));
        // Matrice per ricostruire il percorso (da dove vengo?)
        const parent: number[][] = Array(this.height).fill(0).map(() => Array(this.width).fill(0));

        // Inizializzazione prima riga (solo dentro la ROI)
        for (let x = roiStart; x <= roiEnd; x++) {
            if (x >= 0 && x < this.width) {
                dist[0][x] = energyMap[0][x];
            }
        }

        // Calcolo percorso minimo (Dijkstra semplificato per griglia DAG)
        for (let y = 0; y < this.height - 1; y++) {
            for (let x = roiStart; x <= roiEnd; x++) { // Restiamo nella ROI tollerata
                if (dist[y][x] === Infinity) continue;

                // Controlla i 3 vicini sotto: giù-sinistra, giù, giù-destra
                const neighbors = [x - 1, x, x + 1];

                for (const nx of neighbors) {
                    if (nx >= roiStart && nx <= roiEnd && nx >= 0 && nx < this.width) {
                        const newCost = dist[y][x] + energyMap[y + 1][nx];
                        if (newCost < dist[y + 1][nx]) {
                            dist[y + 1][nx] = newCost;
                            parent[y + 1][nx] = x; // Mi salvo da quale X vengo
                        }
                    }
                }
            }
        }

        // 3. Backtracking: Trova il punto finale con costo minore e risali
        let minCost = Infinity;
        let endX = -1;
        for (let x = roiStart; x <= roiEnd; x++) {
            if (dist[this.height - 1][x] < minCost) {
                minCost = dist[this.height - 1][x];
                endX = x;
            }
        }

        // Ricostruisci il percorso
        const path: Point[] = [];
        let currX = endX;
        for (let y = this.height - 1; y >= 0; y--) {
            path.push({ x: currX, y });
            currX = parent[y][currX];
        }

        return path.reverse(); // Ordina dall'alto al basso
    }
}

// --- ESEMPIO DI ESECUZIONE ---

// Creiamo una mappa 10x10.
// Immagina che i valori siano altezze in mm (o luminosità 0-255).
// Creiamo una "cresta" diagonale (bordo netto) che l'algoritmo dovrebbe seguire.
const mappaTest = [
    [10, 10, 10, 10, 50, 10, 10, 10, 10, 10], // La cresta inizia a X=4
    [10, 10, 10, 10, 10, 50, 10, 10, 10, 10], // Si sposta a X=5
    [10, 10, 10, 10, 10, 50, 10, 10, 10, 10],
    [10, 10, 10, 10, 10, 10, 50, 10, 10, 10], // Si sposta a X=6
    [10, 10, 10, 10, 10, 10, 50, 10, 10, 10],
    [10, 10, 10, 10, 10, 10, 10, 50, 10, 10], // Si sposta a X=7
    [10, 10, 10, 10, 10, 10, 10, 50, 10, 10],
    [10, 10, 10, 10, 10, 10, 10, 10, 50, 10], // Si sposta a X=8
    [10, 10, 10, 10, 10, 10, 10, 10, 50, 10],
    [10, 10, 10, 10, 10, 10, 10, 10, 50, 10],
];

const slicer = new SeamFinder(mappaTest);
// Chiediamo di tagliare tra x=2 e x=8 (ROI)
const taglio = slicer.findVerticalSeam(2, 8); 

console.log("--- Mappa Altezze (Il 50 rappresenta un bordo netto) ---");
console.log(mappaTest.map(r => r.join("\t")).join("\n"));

console.log("\n--- Percorso di Taglio Calcolato (X, Y) ---");
// Visualizzazione ASCII
const visual = mappaTest.map((row, y) => row.map((val, x) => {
    const isPath = taglio.find(p => p.x === x && p.y === y);
    return isPath ? "||" : "..";
}).join("  "));

console.log(visual);
console.log("\nCoordinate:", taglio.map(p => `[${p.x},${p.y}]`).join(" -> "));