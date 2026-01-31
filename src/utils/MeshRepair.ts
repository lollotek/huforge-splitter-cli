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

    // Detect command
    const tool = await this.detectAdmeshCommand();
    if (!tool) {
      console.error("MeshRepair: No repair tool found (admesh or PrusaSlicer).");
      return false;
    }

    let cmd = '';
    if (tool.type === 'admesh') {
      cmd = `"${tool.path}" --remove-unconnected --fill-holes --normal-values --write-binary-stl "${filePath}" "${filePath}"`;
    } else {
      // PrusaSlicer
      // --repair produces .obj by default.
      // --export-stl converts to STL.
      // We need to repair then export? Or combined?
      // PrusaSlicer console: --repair input.stl --output output.stl --export-stl
      // Note: PrusaSlicer might require different invocation for repair-to-stl.
      // Let's try: --repair --export-stl --output <same> <input>
      cmd = `"${tool.path}" --repair --export-stl --output "${filePath}" "${filePath}"`;
    }

    try {
      console.log(`Auto-Fixing: ${filePath} using ${tool.type} (${tool.path})...`);
      const { stdout, stderr } = await execAsync(cmd);
      if (stderr && stderr.length > 0) {
        // admesh writes stats to stderr sometimes or info.
        // We only care if it crashes.
      }
      return true;
    } catch (error) {
      console.error(`MeshRepair failed during execution.`);
      console.error(error);
      return false;
    }
  }

  private static async detectAdmeshCommand(): Promise<{ path: string, type: 'admesh' | 'prusaslicer' } | null> {
    // 1. Candidate names to try blindly
    const candidates = process.platform === 'win32' ? ['admesh', 'admesh.bat', 'prusa-slicer-console.exe'] : ['admesh', 'prusa-slicer'];

    // 2. Add 'where' result to candidates if available
    try {
      const lookup = process.platform === 'win32' ? 'where admesh' : 'which admesh';
      const { stdout } = await execAsync(lookup);
      const lines = stdout.trim().split(/\r?\n/);
      for (const l of lines) {
        if (l.trim()) candidates.push(l.trim());
      }
    } catch (e) { }

    // Remove duplicates
    const uniqueCandidates = [...new Set(candidates)];
    // console.log("MeshRepair: Probing candidates:", uniqueCandidates);

    for (const c of uniqueCandidates) {
      try {
        // Try --help (most universal)
        // console.log("Probing:", c);
        const { stdout, stderr } = await execAsync(`"${c}" --help`);
        const output = (stdout + stderr).toLowerCase();

        if (output.includes('prusaslicer')) {
          // console.log("Detected PrusaSlicer at", c);
          return { path: c, type: 'prusaslicer' };
        }
        if (output.includes('admesh') || output.includes('usage: admesh')) {
          // console.log("Detected ADMesh at", c);
          return { path: c, type: 'admesh' };
        }
      } catch (e: any) {
        const msg = (e.stdout || "") + (e.stderr || "");
        if (msg.toLowerCase().includes('prusaslicer')) return { path: c, type: 'prusaslicer' };
      }
    }

    return null; // Not found
  }
}
