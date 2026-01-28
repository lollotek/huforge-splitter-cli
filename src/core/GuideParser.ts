import { parse } from 'svg-parser';
import { createCanvas, CanvasRenderingContext2D } from 'canvas';
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d'; 
import fs from 'fs';

// Setup Polyfill
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

export type GuideSet = {
    verticals: boolean[][][];   
    horizontals: boolean[][][]; 
};

export class GuideParser {
    
    static parse(svgPath: string, width: number, height: number): GuideSet {
        console.log(`📖 Parsing guida SVG: ${svgPath}`);
        const svgContent = fs.readFileSync(svgPath, 'utf-8');
        const root = parse(svgContent);
        
        const guides: GuideSet = { verticals: [], horizontals: [] };

        // FIX: Ora usiamo una funzione di ricerca più flessibile (ID o Label)
        const verticalGroup = this.findLayer(root, 'cuts-vertical');
        const horizontalGroup = this.findLayer(root, 'cuts-horizontal');

        if (verticalGroup) {
            const paths = this.extractPaths(verticalGroup);
            console.log(`   -> Trovati ${paths.length} percorsi guida verticali.`);
            guides.verticals = paths.map(d => this.rasterizePath(d, width, height));
        } else {
            console.log("   -> Nessun layer 'cuts-vertical' trovato.");
        }

        if (horizontalGroup) {
            const paths = this.extractPaths(horizontalGroup);
            console.log(`   -> Trovati ${paths.length} percorsi guida orizzontali.`);
            guides.horizontals = paths.map(d => this.rasterizePath(d, width, height));
        } else {
            console.log("   -> Nessun layer 'cuts-horizontal' trovato.");
        }

        return guides;
    }

    private static rasterizePath(pathData: string, w: number, h: number): boolean[][] {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');

        // Sfondo nero
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);

        // Disegna il path in bianco (ROI)
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 40; // Larghezza del "corridoio" di ricerca
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        const p = new Path2D(pathData);
        (ctx as any).stroke(p);

        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        
        const grid: boolean[][] = [];
        for (let y = 0; y < h; y++) {
            const row: boolean[] = [];
            for (let x = 0; x < w; x++) {
                const index = (y * w + x) * 4;
                row.push(data[index] > 50);
            }
            grid.push(row);
        }
        return grid;
    }

    // --- FIX: Logica di ricerca migliorata ---
    private static findLayer(node: any, targetName: string): any {
        if (node.properties) {
            // 1. Controllo ID diretto
            if (node.properties.id === targetName) return node;
            
            // 2. Controllo Inkscape Label (spesso usato dai software di grafica)
            if (node.properties['inkscape:label'] === targetName) return node;
            
            // 3. Controllo Label generico
            if (node.properties.label === targetName) return node;
        }

        if (node.children) {
            for (const child of node.children) {
                const found = this.findLayer(child, targetName);
                if (found) return found;
            }
        }
        return null;
    }

    private static extractPaths(groupNode: any): string[] {
        const paths: string[] = [];
        // Navigazione ricorsiva dentro il gruppo per trovare tutti i path
        // (A volte Inkscape raggruppa path dentro path)
        const traverse = (node: any) => {
            if (node.tagName === 'path' && node.properties.d) {
                paths.push(node.properties.d);
            } else if (node.tagName === 'line') {
                const { x1, y1, x2, y2 } = node.properties;
                paths.push(`M ${x1} ${y1} L ${x2} ${y2}`);
            }
            
            if (node.children) {
                node.children.forEach(traverse);
            }
        };

        traverse(groupNode);
        return paths;
    }
}