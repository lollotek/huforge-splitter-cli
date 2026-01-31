# HueSlicer CLI - Manuale Utente

HueSlicer CLI è uno strumento avanzato per tagliare (slicing) modelli STL di grandi dimensioni (es. HueForge) in "piastrelle" (tiles) più piccole, seguendo percorsi di taglio personalizzati definiti via SVG.

Il tool è progettato per preservare al 100% la geometria originale (nessuna voxelizzazione) e gestire file di grandi dimensioni senza esaurire la memoria (Streaming Slicer).

## 📋 Prerequisiti

### Obbligatori
- **Node.js** (v18 o superiore)
- **NPM** (incluso in Node.js)

### Opzionali (per Auto-Repair)
Per utilizzare la funzionalità di riparazione automatica (`--autofix`):
- **ADMesh**: Tool command-line leggero e veloce.
- **PrusaSlicer**: Se installato (e disponibile nel PATH come `prusa-slicer-console` o `prusa-slicer`), viene rilevato automaticamente e usato per la riparazione.
  *Nota*: Assicurarsi che la versione installata supporti il flag `--repair`.

Se nessuno dei due è trovato, `--autofix` verrà ignorato con un warning.

## 🚀 Installazione

1. Clonare o scaricare la repository.
2. Aprire un terminale nella cartella del progetto.
3. Installare le dipendenze:
   ```bash
   npm install
   ```

## 📖 Utilizzo Base

Il comando principale si esegue tramite `npx ts-node src/index.ts`.

### 1. Taglio Standard (Consigliato)
Taglia un file STL usando una maschera SVG, attivando lo Streaming Slicer (`-c`) per la massima stabilità e qualità.

```bash
npx ts-node src/index.ts "input/mio_modello.stl" -g "input/guide.svg" -c -r 0.5 --autofix
```

### 2. Solo Anteprima
Genera solo un'immagine SVG (`_preview_cuts.svg`) per verificare dove verranno effettuati i tagli, senza processare l'STL (molto veloce).

```bash
npx ts-node src/index.ts "input/mio_modello.stl" -g "input/guide.svg" -p
```

## ⚙️ Opzioni e Flag

| Flag | Variante | Descrizione | Default | Note |
|------|----------|-------------|---------|------|
| `-g` | `--guide` | **[Richiesto]** Percorso al file SVG con le linee guida di taglio. | - | L'SVG deve avere le stesse dimensioni (pixel) della HeightMap attesa o proporzioni corrette. |
| `-c` | `--clip` | **[Consigliato]** Usa la modalità **Streaming Slicer**. Necessario per file grandi e per evitare OOM. | `false` | Se omesso, usa una modalità legacy. Usalo sempre per HueForge. |
| `-r` | `--resolution` | Risoluzione di analisi (mm/pixel). Definisce quanto densa è la griglia di navigazione. | `0.5` | `0.5` è un buon compromesso. `0.1` è più preciso ma più lento. |
| `--autofix`| `-f` | Tenta di riparare automaticamente i file generati usando `admesh`. | `false` | Richiede `admesh` installato nel sistema. |
| `--svg-export`| - | Esporta il layout 2D dei tile in un singolo file SVG. | `false` | Utile per taglio laser o CNC. I tile sono separati (exploded view). |
| `-o` | `--out` | Cartella di output dove salvare i file STL generati. | `output` | La cartella viene creata se non esiste. |
| `-p` | `--preview` | Genera solo l'anteprima dei tagli (SVG) senza creare i file STL. | `false` | Utile per debuggare le guide SVG. |
| `-w` | `--width` | Larghezza fisica del piatto (mm). | `200` | Usato per il calcolo della griglia. |
| `-h` | `--height` | Altezza fisica del piatto (mm). | `200` | Usato per il calcolo della griglia. |
| `-v` | `--verbose` | Attiva log dettagliati nel terminale. | `false` | Utile per debug avanzato. |

## 🛠️ Guida ai File SVG

Il file SVG (`-g`) serve a indicare *dove* tagliare. HueSlicer cerca percorsi (pixellati) in base al colore delle linee o maschere.

- Assicurati che l'SVG abbia dimensioni e proporzioni coerenti con il modello.
- Usa colori distinti o livelli per le linee di taglio verticali e orizzontali (configurabile in `src/core/GuideParser.ts` se necessario, di default parseggia maschere binarie).

## 🔧 Risoluzione Problemi

### "Percorso impossibile / No Path Found"
Significa che il Seam Finder non riesce a trovare un percorso valido da un lato all'altro della griglia senza attraversare zone "proibite" o uscire dai bordi.
- **Soluzione**: Aumenta la risoluzione (`-r 0.5` invece di `0.1`).
- **Soluzione**: Controlla che le linee guida nell'SVG tocchino effettivamente i bordi dell'immagine.

### "Out of Memory (OOM)"
- **Soluzione**: Assicurati di usare sempre il flag `-c` (Streaming Mode). Questa modalità usa memoria costante indipendentemente dalla grandezza del file.

### "Non-Manifold Edges" / Modello aperto
Lo Streaming Slicer è molto preciso ma la virgola mobile può lasciare micro-buchi (epsilon).
- **Soluzione**: Usa il flag `--autofix`. Questo lancerà `admesh` per chiudere automaticamente i micro-buchi (stitch).

## 📦 Output

Il tool genererà file nella cartella di output con la seguente nomenclatura:
`tile_r{RIGA}_c{COLONNA}.stl`

Esempio:
- `tile_r0_c0.stl`: In alto a sinistra.
- `tile_r0_c1.stl`: In alto a destra.
- `tile_r1_c0.stl`: In basso a sinistra.
... ecc.
