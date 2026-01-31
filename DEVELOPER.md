# Developer Documentation: HueSlicer CLI

Questo documento fornisce una panoramica tecnica approfondita dell'architettura di **HueSlicer CLI**, con focus sul motore di **Streaming Slicer** implementato per risolvere i limiti di memoria (OOM).

## 🎯 Obiettivo del Progetto

L'obiettivo principale era consentire il scomposizione (tiling) di file STL di grandi dimensioni (es. HueForge, >500MB, >10M triangoli) su hardware consumer, senza caricare l'intero modello in RAM.

### Il Problema Originale
L'approccio classico (CSG o Voxel Grid) richiedeva di caricare l'intera mesh in memoria per costruire una struttura dati spaziale (es. Octree, BSP Tree). Con mesh ad alta densità, questo portava rapidamente a **Out-Of-Memory (OOM)** su Node.js (heap limit ~2GB/4GB).

## 🏗️ Architettura: Streaming Slicer

Abbiamo implementato un'architettura **"2.5D Streaming Bisector"**.
Invece di processare il volume, processiamo il *flusso* di triangoli.

### Flusso Dati

1.  **Input Stream**: Lettura sequenziale del file STL (chunk da 64KB).
2.  **Triangle Routing**: Ogni triangolo viene analizzato singolarmente.
3.  **Bisection**: Se un triangolo interseca una linea di taglio, viene diviso geometricamente.
4.  **Output Streams**: I frammenti risultanti vengono scritti *immediatamente* nei file STL di destinazione (`tile_rX_cY.stl`).
5.  **Post-Processing**: Generazione dei "tappi" (Caps) e riparazione.

**Vantaggio Chiave**: Uso di RAM costante (~50-100MB) indipendentemente dalla dimensione del file (anche 10GB).

## 🧩 Moduli Chiave

### 1. `StreamingSlicer.ts` (Il Motore)
Gestisce i buffer di lettura/scrittura e la logica di routing.
*   **Bounding Box Cache**: Pre-calcola i min/max dei percorsi di taglio per scartare rapidamente (99% dei casi) i triangoli che non toccano i bordi.
*   **Recursive Slicing**: Gestisce il routing.
    *   Vertical Slicing: Divide lungo l'asse X.
    *   Horizontal Slicing: Divide i risultati lungo l'asse Y.
    *   **Importante**: I muri generati dai tagli verticali vengono ri-passati nello slicer orizzontale (e viceversa) per garantire che i vertici combacino agli incroci (T-Junctions).

### 2. `TriangleSplitter.ts` (La Geometria)
Implementa l'algoritmo di taglio (simile a *Sutherland-Hodgman*).
*   Taglia un triangolo 3D con un piano verticale infinito definito da un segmento 2D.
*   Interpola le coordinate Z, U, V e le Normali per i nuovi vertici creati sulla linea di taglio.
*   Restituisce:
    *   `Left`: Triangoli a sinistra della linea.
    *   `Right`: Triangoli a destra.
    *   `CutSegment`: Il segmento 3D generato dal taglio (usato per creare i muri).

### 3. `CapUtils.ts` (Chiusura Mesh)
Responsabile di rendere i tile "Watertight" (chiusi).
*   **Loop Reconstruction**: Unisce migliaia di segmenti di taglio disordinati in loop chiusi.
    *   *Miglioramento*: Usa **Vertex Snapping** (precisione 0.01mm) e **Force Close** per gestire imperfezioni numeriche.
*   **Triangulation**: Usa `earcut` per riempire i loop.
    *   *Innovazione*: **Arc Length Unrolling**. Invece di proiettare su un piano 2D fisso (che distorcerebbe tagli curvi creando "ribbons"), srotola il loop basandosi sulla distanza percorsa lungo il perimetro. Questo garantisce muri verticali perfetti anche su curve complesse.

## ⚖️ Valutazioni e Trade-offs

Durnate lo sviluppo, abbiamo affrontato diverse sfide che hanno guidato le scelte tecniche.

### Precisione vs Memoria
*   **Scelta**: Streaming puro.
*   **Pro**: Scalabilità infinita su RAM.
*   **Contro**: Impossibile usare strutture dati globali per garantire la connettività perfetta (Manifoldness).
*   **Conseguenza**: I tile generati possono avere micro-buchi (epsilon gaps) agli incroci dei tagli.
*   **Soluzione**: Integrazione di `admesh` (`--autofix`) come step finale per "cucire" questi micro-errori.

### Qualità della Mesh Base
*   **Problema**: I triangoli grandi (>10mm) tagliati da linee curve diventavano poligonali (low-poly) sulla base.
*   **Soluzione**: **Adaptive Tessellation**. Prima di tagliare, `StreamingSlicer` suddivide i triangoli grandi che intersecano i bordi. Questo aumenta il conteggio triangoli (~20%) ma preserva la curvatura del taglio.

### Artefatti "Straight Line"
*   **Problema**: L'algoritmo usava una linea globale per tagliare, ignorando la curvatura locale del percorso SVG.
*   **Soluzione**: Implementazione di **Local Best Fit Line**. Per ogni triangolo, calcoliamo la regressione lineare solo sui punti del path SVG vicini al triangolo. Margin ridotto a `0.1mm`.

## 🔮 Sviluppi Futuri

Se si volesse evolvere ulteriormente il progetto:

1.  **WASM Core**: Portare `TriangleSplitter` in Rust/WASM per performance superiori.
2.  **Shared Vertex Buffer**: Invece di scrivere subito su disco, mantenere un piccolo buffer di vertici condivisi (LRU cache) per ridurre la duplicazione dei vertici sui bordi.
3.  **Analisi Binaria STL**: Per ora l'header STL è gestito in modo basilare. Un parser più robusto potrebbe gestire formati STL colore o ASCII (attualmente supportiamo solo Binary standard).

## 🛠️ Comandi Utili per Sviluppatori

*   **Build**: `npm run build`
*   **Test Run**: `npx ts-node src/index.ts test-models/wave.stl -g test-models/wave_cuts.svg -c -r 0.5`
*   **Verify Tile**: `npx ts-node src/tools/verifyTile.ts output/tile_r0_c0.stl`
