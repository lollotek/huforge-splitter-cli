import fs from 'fs';

export class SvgBuilder {
    private width: number;
    private height: number;
    private elements: string[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    // Aggiunge la linea di taglio
    // points: coordinate in PIXEL
    addCutLine(path: { x: number, y: number }[], color: string = 'red') {
        if (path.length === 0) return;

        // Costruisce la stringa "M x y L x y ..."
        const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        
        this.elements.push(
            `<path d="${d}" stroke="${color}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" />`
        );
    }

    // Aggiunge il bordo di un pezzo (bounding box)
    addRect(x: number, y: number, w: number, h: number, color: string = 'cyan') {
        this.elements.push(
            `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" 
              fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5,5" opacity="0.5"/>`
        );
    }

    save(filename: string) {
        const svgBody = `
        <svg width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#1a1a1a"/>
            ${this.elements.join('\n')}
        </svg>`;
        
        fs.writeFileSync(filename, svgBody);
        console.log(`🖼️ SVG Preview salvata in: ${filename}`);
    }
}