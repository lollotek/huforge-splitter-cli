import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export class ScadGenerator {
  private openscadPath: string;

  constructor(openscadPath: string = 'openscad.com') {
    this.openscadPath = openscadPath;
  }

  /**
   * Genera uno script OpenSCAD per intersecare un tile SVG con l'STL originale
   */
  public async generateTileStl(
    originalStlPath: string,
    tileSvgPath: string,
    outputStlPath: string,
    extrusionHeight: number = 100
  ): Promise<void> {
    // Usa percorsi assoluti per evitare problemi con OpenSCAD
    const absStlPath = path.resolve(originalStlPath).replace(/\\/g, '/');
    const absSvgPath = path.resolve(tileSvgPath).replace(/\\/g, '/');
    const absOutPath = path.resolve(outputStlPath).replace(/\\/g, '/');

    // Crea il contenuto dello script SCAD
    const scadContent = `
intersection() {
    import("${absStlPath}");
    linear_extrude(height = ${extrusionHeight})
        import("${absSvgPath}");
}
`;

    // Scrivi file temporaneo .scad
    const tempScadPath = absOutPath.replace(/\.stl$/i, '.scad');
    fs.writeFileSync(tempScadPath, scadContent);

    // Esegui OpenSCAD
    // Command: openscad -o output.stl input.scad
    const command = `"${this.openscadPath}" -o "${absOutPath}" "${tempScadPath}"`;

    try {
      console.log(`Resource Heavy Operation: Generating STL for ${path.basename(tileSvgPath)}...`);
      const { stdout, stderr } = await execPromise(command);
      if (stderr && !stderr.includes("Geometries in cache")) {
        // OpenSCAD often writes to stderr even for info/warnings
        // console.warn(`OpenSCAD stderr: ${stderr}`);
      }
    } catch (error) {
      console.error(`Error executing OpenSCAD for ${tileSvgPath}:`, error);
      throw error;
    } finally {
      // Cleanup temp file
      if (fs.existsSync(tempScadPath)) {
        fs.unlinkSync(tempScadPath);
      }
    }
  }
}
