import fs from 'fs';

export class SvgBuilder {
    private width: number;
    private height: number;
    private elements: string[] = [];
    private backgroundImage: string = "";

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    // NUOVO: Imposta immagine di sfondo
    setBackground(base64Image: string) {
        this.backgroundImage = `<image href="${base64Image}" x="0" y="0" width="${this.width}" height="${this.height}" />`;
    }

    addCutLine(path: { x: number, y: number }[], color: string = 'red') {
        if (path.length === 0) return;
        // path points are mostly likely floats, ensuring safe SVG data
        const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        this.elements.push(
            `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" vector-effect="non-scaling-stroke" opacity="0.9" />`
        );
    }

    addRect(x: number, y: number, w: number, h: number, color: string = 'cyan') {
        this.elements.push(
            `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" 
              fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="10,5" opacity="0.8"/>`
        );
    }

    save(filename: string) {
        const svgBody = `
        <svg width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#111"/>
            ${this.backgroundImage}
            ${this.elements.join('\n')}
        </svg>`;
        
        fs.writeFileSync(filename, svgBody);
        console.log(`🖼️ SVG Preview salvata in: ${filename}`);
    }
}