# Developer Documentation: HueSlicer CLI

Questo documento fornisce una panoramica tecnica dell'architettura di **HueSlicer CLI**, aggiornata alla versione **SVG-Only**.

## 🎯 Obiettivo del Progetto

L'obiettivo è consentire il tiling (divisione) di file STL di grandi dimensioni (es. HueForge) in "piastrelle" (tiles) più piccole per adattarsi alle dimensioni del piatto di stampa. 

A differenza della versione precedente che tentava di tagliare la mesh 3D direttamente (Streaming Slicer), l'attuale architettura si concentra sulla generazione di un **Layout di taglio SVG 2D** ottimizzato, delegando poi l'operazione booleana pesante (Intersection) a software esterni robusti e ottimizzati come **OpenSCAD**.

## 🏗️ Architettura: SVG Export & OpenSCAD Bridge

Il flusso di lavoro è stato semplificato in una pipeline lineare:

### 1. Analisi Topologica (`HeightMapper.ts`)
L'STL viene analizzato per generare una "HeightMap" (griglia di altezze).
*   Input: File STL.
*   Processo: Ray-casting su griglia XY.
*   Output: `Float32Array` (Z-buffer) che rappresenta la topologia del modello 2.5D.

### 2. Estrazione Percorsi di Taglio (`GuideParser.ts` & `SeamFinder`)
Determina dove effettuare i tagli per evitare di interrompere dettagli importanti.
*   **Guide Mode**: Se presente un file SVG (`-g`), estrae i path definiti dall'utente.
    *   *Novità*: Supporta `stroke-width` variabile per definire la tolleranza di ricerca per ogni taglio.
*   **Auto-Tiling**: Se manca il file guida, genera automaticamente percorsi rettilinei basati sulle dimensioni del piatto (`-w`, `-h`).
*   **Seam Carving**: Usa l'algoritmo *Seam Carving* (via `SeamFinder`) per deviare i percorsi rettilinei ed evitare le zone ad alto dettaglio/contrasto nella HeightMap.

### 3. Generazione Layout SVG (`SvgExporter.ts`)
I percorsi di taglio ottimizzati vengono convertiti in poligoni chiusi rappresentanti i singoli tile.
*   Calcolo intersezioni tra tagli verticali e orizzontali.
*   Generazione di curve chiuse per ogni "cella" della griglia.
*   Export di un file `.svg` per ogni tile.

### 4. Generazione STL (`ScadGenerator.ts`)
Automazione dell'intersezione 3D.
*   Per ogni tile generato (SVG), viene creato uno script `.scad`.
*   Lo script importa l'STL originale e usa `linear_extrude` + `intersection` con il profilo SVG del tile.
*   Viene invocato **OpenSCAD CLI** per renderizzare il risultato finale in STL.

## 🧩 Moduli Chiave

### `index.ts` (Entry Point)
Orchestra i passaggi sopra descritti.
*   Gestisce i flag CLI (es. `--generate-stls`, `--preview`).
*   Inizializza la pipeline e gestisce il fallback dell'Auto-Tiling.

### `GuideParser.ts`
*   Estrae percorsi da file SVG.
*   Rasterizza i percorsi su maschere booleane usate dal Seam Finder.
*   Rispetta lo `stroke-width` SVG per definire l'ampiezza del corridoio di ricerca.

### `Utils`
*   `SvgBuilder.ts`: Genera l'anteprima `_preview_cuts.svg` (ora con background HeightMap).
*   `ScadGenerator.ts`: Wrapper per lanciare comandi OpenSCAD.

## 🛠️ Comandi Utili per Sviluppatori

*   **Build**: `npm run build`
*   **Test Run (Preview)**: `node dist/index.js test.stl -w 200 -h 200 --preview`
*   **Test Run (Full)**: `node dist/index.js test.stl -g guide.svg --generate-stls`
