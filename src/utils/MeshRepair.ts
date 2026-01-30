import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * MeshRepair - Utility for repairing meshes using external tools
 * 
 * Supports:
 * - admesh: Fast STL repair tool (https://github.com/admesh/admesh)
 * - meshlab: Powerful mesh processing (meshlabserver CLI)
 */
export class MeshRepair {

  /**
   * Check which repair tools are available on the system
   */
  static async detectAvailableTools(): Promise<string[]> {
    const available: string[] = [];

    // Check admesh
    try {
      await execAsync('admesh --version');
      available.push('admesh');
    } catch { }

    // Check meshlab (meshlabserver or meshlab.meshlab)
    try {
      await execAsync('meshlabserver --version');
      available.push('meshlab');
    } catch {
      try {
        // Windows: may be installed as meshlab
        await execAsync('meshlab --help');
        available.push('meshlab');
      } catch { }
    }

    return available;
  }

  /**
   * Repair STL with admesh
   * admesh fixes: duplicate/degenerate facets, non-manifold edges, etc.
   * 
   * @returns true if repair successful
   */
  static async repairWithAdmesh(stlPath: string, verbose: boolean = false): Promise<boolean> {
    const outputPath = stlPath.replace('.stl', '_repaired.stl');

    try {
      const cmd = `admesh --write-binary-stl="${outputPath}" "${stlPath}"`;
      if (verbose) console.log(`   Running: ${cmd}`);

      await execAsync(cmd);

      // Replace original with repaired
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(stlPath);
        fs.renameSync(outputPath, stlPath);
        return true;
      }
    } catch (e: any) {
      if (verbose) console.error(`   admesh error: ${e.message}`);
    }

    return false;
  }

  /**
   * Repair STL with MeshLab CLI
   * Uses a repair script for more advanced repair operations
   * 
   * @param scriptPath Optional path to custom .mlx script
   * @returns true if repair successful
   */
  static async repairWithMeshlab(
    stlPath: string,
    verbose: boolean = false,
    scriptPath?: string
  ): Promise<boolean> {
    const outputPath = stlPath.replace('.stl', '_repaired.stl');

    // Default repair script (inline)
    const defaultScript = `
<!DOCTYPE FilterScript>
<FilterScript>
 <filter name="Merge Close Vertices"/>
 <filter name="Remove Duplicate Faces"/>
 <filter name="Remove Duplicate Vertices"/>
 <filter name="Remove Unreferenced Vertices"/>
 <filter name="Repair non Manifold Edges by removing faces"/>
 <filter name="Close Holes">
  <Param type="RichInt" value="30" name="MaxHoleSize"/>
 </filter>
</FilterScript>
    `.trim();

    const tempScriptPath = stlPath.replace('.stl', '_repair_script.mlx');

    try {
      // Write script if not provided
      const script = scriptPath || tempScriptPath;
      if (!scriptPath) {
        fs.writeFileSync(tempScriptPath, defaultScript);
      }

      const cmd = `meshlabserver -i "${stlPath}" -o "${outputPath}" -s "${script}"`;
      if (verbose) console.log(`   Running: ${cmd}`);

      await execAsync(cmd, { timeout: 120000 }); // 2 min timeout

      // Cleanup temp script
      if (!scriptPath && fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }

      // Replace original with repaired
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(stlPath);
        fs.renameSync(outputPath, stlPath);
        return true;
      }
    } catch (e: any) {
      if (verbose) console.error(`   meshlab error: ${e.message}`);

      // Cleanup temp script on error
      if (fs.existsSync(tempScriptPath)) {
        try { fs.unlinkSync(tempScriptPath); } catch { }
      }
    }

    return false;
  }

  /**
   * Repair using best available tool
   * Priority: admesh (fast) -> meshlab (thorough)
   */
  static async repairAuto(stlPath: string, verbose: boolean = false): Promise<boolean> {
    const tools = await this.detectAvailableTools();

    if (tools.includes('admesh')) {
      return this.repairWithAdmesh(stlPath, verbose);
    }

    if (tools.includes('meshlab')) {
      return this.repairWithMeshlab(stlPath, verbose);
    }

    if (verbose) {
      console.log('   No repair tools available (install admesh or meshlab)');
    }
    return false;
  }
}
