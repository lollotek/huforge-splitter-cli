import fs from 'fs';

export class SvgBuilder {
    private width: number;
    private height: number;
    private elements: string[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    // Aggiunge lo sfondo basato sulla heightmap
    addHeightMapBackground(data: number[][], maxZ: number) {
        // NOTA: In produzione, questo si farebbe incorporando un'immagine Base64 per efficienza.
        // Qui usiamo rettangoli SVG per ogni pixel (Lento ma non richiede dipendenze esterne per la demo)
        // Per ottimizzare, raggruppiamo pixel simili o usiamo <image> tag.
        
        let svgContent = `<g id="background">`;
        // Semplificazione: Renderizziamo a risoluzione ridotta per non fare file enormi in debug
        const step = 2; 
        
        for (let y = 0; y < this.height; y += step) {
            for (let x = 0; x < this.width; x += step) {
                const z = data[y][x];
                // Normalizza Z in colore (0=Nero, Max=Bianco)
                const val = Math.floor((z / maxZ) * 255);
                const color = `rgb(${val},${val},${val})`;
                svgContent += `<rect x="${x}" y="${y}" width="${step}" height="${step}" fill="${color}" stroke="none"/>`;
            }
        }
        svgContent += `</g>`;
        this.elements.push(svgContent);
    }

    // Disegna la linea di taglio
    addCutLine(path: { x: number, y: number }[], color: string = 'red') {
        if (path.length === 0) return;

        // Costruisce la stringa "M x y L x y ..."
        const d = path.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
        
        this.elements.push(
            `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" />`
        );
    }

    // Aggiunge la bounding box (Area di tolleranza)
    addROI(xStart: number, width: number) {
        this.elements.push(
            `<rect x="${xStart}" y="0" width="${width}" height="${this.height}" 
              fill="yellow" fill-opacity="0.2" stroke="yellow" stroke-dasharray="5,5"/>`
        );
    }

    save(filename: string) {
        const svgBody = `
        <svg width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="black"/>
            ${this.elements.join('\n')}
        </svg>`;
        
        fs.writeFileSync(filename, svgBody);
        console.log(`SVG salvato in: ${filename}`);
    }
}