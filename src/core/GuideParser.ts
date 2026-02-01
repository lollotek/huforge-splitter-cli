import { parse } from 'svg-parser';
import { createCanvas, CanvasRenderingContext2D } from 'canvas';
import { Path2D, applyPath2DToCanvasRenderingContext } from 'path2d';
import fs from 'fs';

// Setup Polyfill
applyPath2DToCanvasRenderingContext(CanvasRenderingContext2D as any);

export type Point = { x: number, y: number };

export type GuideSet = {
    verticals: boolean[][][];
    horizontals: boolean[][][];
    verticalPaths: Point[][];
    horizontalPaths: Point[][];
};

export class GuideParser {

    static parse(svgPath: string, width: number, height: number): GuideSet {
        console.log(`📖 Parsing guida SVG: ${svgPath}`);
        const svgContent = fs.readFileSync(svgPath, 'utf-8');
        const root = parse(svgContent);

        const guides: GuideSet = { verticals: [], horizontals: [], verticalPaths: [], horizontalPaths: [] };

        // FIX: Ora usiamo una funzione di ricerca più flessibile (ID o Label)
        const verticalGroup = this.findLayer(root, 'cuts-vertical');
        const horizontalGroup = this.findLayer(root, 'cuts-horizontal');

        // Helper to convert SVG path strings to Point[]
        const parsePath = (d: string): Point[] => {
            // Very basic SVG path parser (supports M and L)
            const pts: Point[] = [];
            const commands = d.match(/[ML][^ML]*/g) || [];

            for (const cmd of commands) {
                const nums = cmd.trim().substring(1).trim().split(/[\s,]+/).map(Number);
                if (nums.length >= 2) pts.push({ x: nums[0], y: nums[1] });
            }
            return pts;
        };

        if (verticalGroup) {
            const paths = this.extractPaths(verticalGroup);
            console.log(`   -> Trovati ${paths.length} percorsi guida verticali.`);
            guides.verticals = paths.map(p => this.rasterizePath(p.d, p.strokeWidth, width, height));
            guides.verticalPaths = paths.map(p => parsePath(p.d));
        } else {
            console.log("   -> Nessun layer 'cuts-vertical' trovato.");
        }

        if (horizontalGroup) {
            const paths = this.extractPaths(horizontalGroup);
            console.log(`   -> Trovati ${paths.length} percorsi guida orizzontali.`);
            guides.horizontals = paths.map(p => this.rasterizePath(p.d, p.strokeWidth, width, height));
            guides.horizontalPaths = paths.map(p => parsePath(p.d));
        } else {
            console.log("   -> Nessun layer 'cuts-horizontal' trovato.");
        }

        return guides;
    }

    private static rasterizePath(pathData: string, strokeWidth: number, w: number, h: number): boolean[][] {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');

        // Sfondo nero
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);

        // Disegna il path in bianco (ROI)
        ctx.strokeStyle = 'white';
        ctx.lineWidth = strokeWidth; // Usa larghezza dinamica dallo stroke SVG
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

    private static extractPaths(groupNode: any): { d: string, strokeWidth: number }[] {
        const paths: { d: string, strokeWidth: number }[] = [];
        // Navigazione ricorsiva dentro il gruppo per trovare tutti i path
        const traverse = (node: any) => {
            let strokeWidth = 40; // Default
            if (node.properties && node.properties['stroke-width']) {
                const sw = parseFloat(node.properties['stroke-width']);
                if (!isNaN(sw)) strokeWidth = sw;
            }

            if (node.tagName === 'path' && node.properties.d) {
                paths.push({ d: node.properties.d, strokeWidth });
            } else if (node.tagName === 'line') {
                const { x1, y1, x2, y2 } = node.properties;
                paths.push({ d: `M ${x1} ${y1} L ${x2} ${y2}`, strokeWidth });
            }

            if (node.children) {
                node.children.forEach(traverse);
            }
        };

        traverse(groupNode);
        return paths;
    }
}
