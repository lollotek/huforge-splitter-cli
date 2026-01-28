import { createCanvas } from 'canvas';

export class ImageGenerator {
    static gridToBase64(grid: number[][], width: number, height: number, maxZ: number): string {
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        
        // Creiamo il buffer di pixel
        const imgData = ctx.createImageData(width, height);
        const data = imgData.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const z = grid[y][x];
                // Normalizza Z in grigio (0..255)
                // Usiamo una logica non-lineare per evidenziare i dettagli bassi
                let val = 0;
                if (z > 0) {
                     val = Math.floor((z / maxZ) * 255);
                }
                
                const idx = (y * width + x) * 4;
                data[idx] = val;     // R
                data[idx + 1] = val; // G
                data[idx + 2] = val; // B
                data[idx + 3] = 255; // Alpha (Opaco)
            }
        }

        ctx.putImageData(imgData, 0, 0);
        return canvas.toDataURL('image/png');
    }
}