# HueSlicer CLI - Manuale Utente

HueSlicer CLI è uno strumento per dividere (tiling) modelli STL di grandi dimensioni (es. HueForge) in parti più piccole, ottimizzando i tagli per nascondere le giunzioni.

> **Nuova Architettura**: Dalla versione 1.0, il tool si concentra sulla generazione di layout di taglio SVG intelligenti e usa **OpenSCAD** per generare i modelli 3D finali.

## 📋 Prerequisiti

### Obbligatori
- **Node.js** (v18 o superiore)
- **OpenSCAD**: Necessario per generare i file STL finali (comando `--generate-stls`). Assicurati che sia installato e accessibile da terminale o specifica il percorso.

## 🚀 Installazione

1. Clonare la repository.
2. Installare le dipendenze:
   ```bash
   npm install
   npm run build
   ```

## 📖 Utilizzo

Il comando base si esegue tramite `node dist/index.js`.

### 1. Anteprima Automatica (Auto-Tiling)
Se non hai un file guida, HueSlicer calcolerà automaticamente una griglia basata sulle dimensioni del tuo piatto di stampa.

```bash
node dist/index.js "input/modello.stl" -w 200 -h 200 --preview
```
*   Genera `_preview_cuts.svg`: un'immagine che mostra dove verranno effettuati i tagli (linee rosse/blu) sovrapposti alla mappa di altezze del modello.

### 2. Taglio con Guida Personalizzata
Per un controllo preciso, disegna le linee di guida in un software vettoriale (Inkscape/Illustrator) e salvale come SVG.
*   Lo spessore della linea (`stroke-width`) nel file SVG determina quanto il taglio può "deviare" per cercare il percorso migliore. Linee più spesse = più libertà (seam carving).

```bash
node dist/index.js "input/modello.stl" -g "guide.svg" --preview
```

### 3. Generazione e Export STL
Per generare i file finali pronti per la stampa, usa l'opzione `--generate-stls`.

```bash
node dist/index.js "modello.stl" -w 200 -h 200 --generate-stls --openscad "C:/Program Files/OpenSCAD/openscad.exe"
```
*   Se OpenSCAD è nel PATH di sistema, puoi omettere `--openscad`.
*   Il processo genererà un file STL separato per ogni tile nella cartella di output.

## ⚙️ Opzioni e Flag

| Flag | Descrizione | Default | Note |
|------|-------------|---------|------|
| `-g`, `--guide` | File SVG con le linee guida. | (Auto) | Se omesso, usa Auto-Tiling. |
| `-w`, `--width` | Larghezza piatto (mm). | `200` | Fondamentale per Auto-Tiling. |
| `-h`, `--height` | Altezza piatto (mm). | `200` | Fondamentale per Auto-Tiling. |
| `--preview` | Genera solo l'anteprima SVG. | `false` | Utile per verificare i tagli. |
| `--generate-stls` | Attiva la generazione dei file STL finali. | `false` | Richiede OpenSCAD. |
| `--openscad` | Percorso dell'eseguibile OpenSCAD. | `openscad` | Necessario se non è nel PATH globale. |
| `-o`, `--out` | Cartella di output. | `output` | |
| `-r`, `--resolution` | Risoluzione analisi (mm/pixel). | `0.5` | Valori più bassi = più precisione ma più lenti. |
| `-v`, `--verbose` | Log dettagliati. | `false` | |

## 🔧 Risoluzione Problemi

### "I tagli non seguono bene i dettagli"
*   Se usi Auto-Tiling, prova a creare un file guida personalizzato.
*   Se usi un file guida, aumenta lo spessore delle linee (`stroke-width`) nel tuo editor SVG per dare più "spazio di manovra" all'algoritmo.

### "Errore durante generazione STL"
*   Verifica che OpenSCAD sia installato correttamente.
*   Controlla i log con `-v` per vedere l'errore specifico di OpenSCAD.
