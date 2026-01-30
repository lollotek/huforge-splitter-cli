
# Project Context: HueSlicer CLI

## 1. Descrizione del Progetto

**HueSlicer** è un tool CLI (Command Line Interface) scritto in TypeScript/Node.js per tagliare modelli STL (specificamente bassorilievi tipo HueForge) in parti più piccole per adattarsi al piatto di stampa.
A differenza degli slicer tradizionali che usano tagli netti (dovetail/puzzle standard), HueSlicer utilizza un algoritmo di **Seam Carving topologico**: analizza la heightmap del modello per trovare percorsi di taglio che seguono i contorni naturali dell'immagine, rendendo le giunzioni meno visibili.
il file initial_plan.md mostra l'idea da cui è partito il progetto.

## 2. Stack Tecnologico

* **Runtime:** Node.js (con `ts-node` per l'esecuzione diretta TS).
* **Geometria 3D:** `manifold-3d` (Binding WASM della libreria Manifold). Gestisce operazioni booleane veloci e robuste.
* **Analisi 2D:** `canvas` (per rasterizzazione percorsi e heightmap), `svg-parser` (per leggere le guide utente).
* **CLI:** `commander` per il parsing degli argomenti.

## 3. Architettura Core

### A. Moduli Principali

1. **`HeightMapper`**: Converte l'STL in una griglia 2D (Matrice `number[][]`) di altezze Z.
* *Nota Critica:* Mappa le coordinate in modo che `Y_MAX` (Mondo 3D) corrisponda alla `Riga 0` (Immagine). Questo è fondamentale per allineare l'SVG di input con la geometria 3D.


2. **`SeamFinder`**: Implementa l'algoritmo di Seam Carving (Programmazione Dinamica). Calcola la "mappa di energia" (bordi) e trova il percorso a costo minimo attraverso l'immagine (o dentro una maschera definita dall'utente).
3. **`GuideParser`**: Legge file SVG per la modalità "User-Guided". Estrae i path dai layer/gruppi specifici (`cuts-vertical`, `cuts-horizontal`) e crea maschere booleane per il SeamFinder.
4. **`GeometryProcessor`**: Wrapper attorno a `manifold-3d`.
* Converte i percorsi 2D (pixel) in 3D (mm).
* Esegue l'estrusione della "lama" di taglio e l'intersezione booleana.
* Gestisce il **Fallback a Cascata** per evitare crash WASM.


5. **`TilingManager`**: Orchestratore. Gestisce la coda dei pezzi da tagliare, applica la logica ricorsiva (Auto Mode) o sequenziale (Guided Mode) e gestisce il ciclo di vita della memoria degli oggetti Manifold.

### B. Flusso Dati (Coordinate System)

È stato risolto un conflitto di coordinate critico. Il sistema deve rispettare rigorosamente:

* **Mondo 3D (STL):**  in basso a sinistra. Y cresce verso l'alto.
* **Mondo Immagine (Grid/SVG):**  in alto a sinistra. Y cresce verso il basso.
* **Conversione:**
* `HeightMapper`: `GridY = floor((MaxY_Global - WorldY) / Resolution)`.
* `TilingManager`: `WorldY = MaxY_Global - (GridY * ScaleY)`.



## 4. Scelte Progettuali e Soluzioni Tecniche

### Gestione della Stabilità WASM (GeometryProcessor)

La libreria `manifold-3d` può andare in crash (WASM Trap) su geometrie degeneri o micro-segmenti. Abbiamo implementato una strategia di **Graceful Degradation** a 3 livelli:

1. **Livello 1 (Alta Qualità):** Smoothing attivo (Chaikin), pulizia punti fine (0.35mm).
2. **Livello 2 (Media):** No Smoothing (linee rette), pulizia punti fine.
3. **Livello 3 (Safe Mode):** No Smoothing, pulizia aggressiva (0.5mm).

* Se un livello fallisce, il sistema cattura l'errore, pulisce la memoria (Safe Cleanup) e tenta il livello successivo.

### Gestione della Memoria (Manifold)

Gli oggetti WASM (`Manifold`, `CrossSection`) non vengono raccolti dal Garbage Collector di JS. Devono essere distrutti manualmente (`.delete()`).

* **Soluzione:** Uso rigoroso di blocchi `try...finally` per garantire che le lame di taglio vengano distrutte anche in caso di errore.
* **Eccezione:** La mesh originale del pezzo (`item.mesh`) viene distrutta *solo* se il taglio ha successo e sono stati generati i pezzi figli (`_L`, `_R`).

### Tolleranza vs Smoothing (Fit dei pezzi)

* **Problema:** Gli angoli vivi stampati in 3D tendono a gonfiare ("blob"), impedendo l'incastro.
* **Tentativo scartato:** Usare un forte smoothing geometrico (curve) causava troppi crash nel motore geometrico.
* **Soluzione Adottata:** Mantenere i tagli geometricamente semplici (Safe Mode) ma aumentare il **Gap di Tolleranza** (`-t 0.4` mm). Questo crea un canale d'aria che assorbe le imperfezioni di stampa.

## 5. Guida all'Uso e Debug

### Comandi Tipici

* **Preview:** `npx ts-node src/index.ts file.stl --preview`
* **Guided Cut (Safe):** `npx ts-node src/index.ts file.stl -g guide.svg -t 0.4 --safe`
* **Debug:** `npx ts-node src/index.ts file.stl -g guide.svg --verbose` (Salva gli STL intermedi delle lame di taglio).

### Formato SVG Guida

L'SVG di input deve avere gruppi/layer specifici (identificati tramite `id`, `label` o `inkscape:label`):

1. `cuts-vertical`: Linee che tagliano l'asse X (dividono Sinistra/Destra).
2. `cuts-horizontal`: Linee che tagliano l'asse Y (dividono Sopra/Sotto).
I tracciati devono essere "path" o "line" semplici. L'algoritmo userà questi tracciati come "suggerimento" per cercare il percorso ottimale nelle vicinanze.

## 6. Roadmap / TODO

* [ ] Ottimizzare la velocità di raycasting in `HeightMapper` (attualmente basata su vertici, potrebbe essere imprecisa su low-poly).
* [ ] Creare un eseguibile standalone (pkg/nexe).
