import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

export class MeshRepair {
  /**
   * Attempts to repair the STL file using 'admesh' CLI.
   * @param filePath Path to the STL file (repaired in-place or overwritten)
   * @returns True if successful, False if admesh failed or not found.
   */
  static async repairFile(filePath: string): Promise<boolean> {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`MeshRepair: File not found ${filePath}`);
      return false;
    }

    // Check if admesh is available (simple check)
    // Actually, we'll just try to run it and catch error.

    // Command: admesh --remove-unconnected --fill-holes --normal-values --write-binary-stl <file> <file>
    // Note: admesh modifies in place if output is not specified?
    // Let's force write back to the same file.
    // admesh [options] input output
    const cmd = `admesh --remove-unconnected --fill-holes --normal-values --write-binary-stl "${filePath}" "${filePath}"`;

    try {
      console.log(`Auto-Fixing: ${filePath}...`);
      const { stdout, stderr } = await execAsync(cmd);
      if (stderr && stderr.length > 0) {
        // admesh writes stats to stderr sometimes or info.
        // We only care if it crashes.
      }
      return true;
    } catch (error) {
      console.error(`MeshRepair failed: Is 'admesh' installed and in PATH?`);
      // console.error(error);
      return false;
    }
  }
}
