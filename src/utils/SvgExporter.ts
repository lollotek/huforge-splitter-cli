import fs from 'fs';
import { Point } from '../core/GuideParser';
import path from 'path';

// Helper for loose intersection
function getPolylineIntersection(metrics: { width: number, height: number }, vPath: Point[], hPath: Point[]): Point {
  // Brute force segment-segment intersection
  // vPath is mostly vertical, hPath is mostly horizontal.
  // They MUST intersect once essentially.

  // Quick check: Intersect logic
  // We assume segments are p1->p2

  for (let i = 0; i < vPath.length - 1; i++) {
    const p1 = vPath[i];
    const p2 = vPath[i + 1];

    for (let j = 0; j < hPath.length - 1; j++) {
      const p3 = hPath[j];
      const p4 = hPath[j + 1];

      // Standard line-line intersection
      const denom = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);

      if (denom === 0) continue; // Parallel

      const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / denom;
      const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / denom;

      if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
        return {
          x: p1.x + ua * (p2.x - p1.x),
          y: p1.y + ua * (p2.y - p1.y)
        };
      }
    }
  }

  // Should not happen for full-span paths, but if it does (e.g. at edges), clamp?
  // If hPath is at y=0, and vPath crosses 0, it intersects.
  // But if paths are mathematical lines...
  // Let's return a sensible default if not found?
  // Or warn.
  return { x: 0, y: 0 };
}

// Extract sub-path between two points on the polyline
// Warning: start and end MUST be ON the polyline (or close enough)
// and we assume monotonic progression for simplicity, but real paths are monotonic.
function getSubPath(path: Point[], start: Point, end: Point, isHorizontal: boolean): Point[] {
  const result: Point[] = [start];

  // Determine bounds
  let minV: number, maxV: number, primaryAxis: 'x' | 'y';
  if (isHorizontal) {
    primaryAxis = 'x';
    minV = Math.min(start.x, end.x);
    maxV = Math.max(start.x, end.x);
  } else {
    primaryAxis = 'y';
    minV = Math.min(start.y, end.y);
    maxV = Math.max(start.y, end.y);
  }

  // Collect intermediate points strictly between limits
  // We iterate through path.
  // NOTE: Path points might slightly zigzag, but generally flow.
  // We check if point is "between" start and end along the primary axis.
  for (const p of path) {
    const val = p[primaryAxis];
    // Epsilon to avoid duplicating start/end if they match exactly logic
    if (val > minV + 0.001 && val < maxV - 0.001) {
      result.push(p);
    }
  }

  result.push(end);

  // Sort logic: We want order from 'start' to 'end'.
  // Result is currently [start, ...intermediates(sorted by path index?), end]
  // If 'path' goes Left->Right, intermediates are L->R.
  // If 'start' is Left, 'end' is Right: Good.
  // If 'start' is Right, 'end' is Left: Bad. Intermediates are wrong order?
  // No, existing order in 'path' is preserved.
  // If 'path' is increasing X.
  // And Start.x > End.x.
  // Then intermediates are increasing X.
  // So [Start (High X), ...Intermediates(Low->High), End (Low X)] -> Messy.

  // Correct approach: 
  // Filter points based on Path Index? simpler.
  // But determining "Index" of an intersection point is hard (it's between indices).

  // Robust approach: Sort all points (start, end, intermediates) by projected distance along the line?
  // For Horizontal: Sort by X.
  // For Vertical: Sort by Y.

  result.sort((a, b) => a[primaryAxis] - b[primaryAxis]);

  // Now result is ordered Low->High.
  // If start > end, reverse it.
  if (start[primaryAxis] > end[primaryAxis]) {
    result.reverse();
  }

  return result;
}


export class SvgExporter {

  public static async generateFromPaths(
    vPaths: Point[][],
    hPaths: Point[][],
    width: number,
    height: number,
    outputPath: string
  ) {
    console.log(`\n--- SVG Export (From Cut Paths) ---`);
    console.log(`Grid: ${hPaths.length + 1} Rows x ${vPaths.length + 1} Cols`);

    // 1. Build Boundaries
    const allHPaths = [
      [{ x: 0, y: 0 }, { x: width, y: 0 }],          // Top Edge
      ...hPaths,
      [{ x: 0, y: height }, { x: width, y: height }] // Bottom Edge
    ];

    const allVPaths = [
      [{ x: 0, y: 0 }, { x: 0, y: height }],         // Left Edge
      ...vPaths,
      [{ x: width, y: 0 }, { x: width, y: height }]  // Right Edge
    ];

    // 2. Compute Intersections Grid [Row][Col]
    // This grid represents the "Knots" of the net.
    const knots: Point[][] = [];

    for (let r = 0; r < allHPaths.length; r++) {
      const rowKnots: Point[] = [];
      for (let c = 0; c < allVPaths.length; c++) {
        const pt = getPolylineIntersection({ width, height }, allVPaths[c], allHPaths[r]);
        rowKnots.push(pt);
      }
      knots.push(rowKnots);
    }

    // 3. Generate Tiles content
    const explodedTiles: { svg: string, id: string }[] = [];
    const GAP = 0; // add to exploded tiles to avoid overlapping

    // Calculate ViewBox bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    // Iterate Cells
    for (let r = 0; r < allHPaths.length - 1; r++) {
      for (let c = 0; c < allVPaths.length - 1; c++) {

        // Get corners of this cell from the knot grid
        const tl = knots[r][c];
        const tr = knots[r][c + 1];
        const br = knots[r + 1][c + 1];
        const bl = knots[r + 1][c];

        // Extract precise edges from the actual paths
        const topEdge = getSubPath(allHPaths[r], tl, tr, true);
        const rightEdge = getSubPath(allVPaths[c + 1], tr, br, false);
        const bottomEdge = getSubPath(allHPaths[r + 1], br, bl, true);
        // Note: bottomEdge returned from getSubPath goes Left->Right (based on sorting).
        // We need it Right->Left (BR -> BL).
        // But getSubPath handles direction if we pass start=BR, end=BL?
        // Yes, logic: if start > end, reverse.
        // BR.x > BL.x (usually). So it should reverse correctly.

        const leftEdge = getSubPath(allVPaths[c], bl, tl, false); // BL -> TL (Up). BL.y > TL.y. Reverse.

        // Concatenate Loop
        const loopPoints = [...topEdge, ...rightEdge, ...bottomEdge, ...leftEdge];

        // Remove duplicates (Start of one is End of previous)
        // Filter if dist < epsilon
        const cleanLoop: Point[] = [];
        if (loopPoints.length > 0) cleanLoop.push(loopPoints[0]);

        for (let k = 1; k < loopPoints.length; k++) {
          const last = cleanLoop[cleanLoop.length - 1];
          const curr = loopPoints[k];
          const d = (last.x - curr.x) ** 2 + (last.y - curr.y) ** 2;
          if (d > 0.0001) cleanLoop.push(curr);
        }

        // Explode Shift
        const shiftX = c * GAP;
        const shiftY = r * GAP;

        let d = `M ${(cleanLoop[0].x + shiftX).toFixed(2)} ${(cleanLoop[0].y + shiftY).toFixed(2)} `;
        for (let k = 1; k < cleanLoop.length; k++) {
          const p = cleanLoop[k];
          d += `L ${(p.x + shiftX).toFixed(2)} ${(p.y + shiftY).toFixed(2)} `;

          // Update global bounds
          minX = Math.min(minX, p.x + shiftX);
          maxX = Math.max(maxX, p.x + shiftX);
          minY = Math.min(minY, p.y + shiftY);
          maxY = Math.max(maxY, p.y + shiftY);
        }
        d += "Z";

        explodedTiles.push({
          svg: `<g id="tile_r${r}_c${c}">
                    <path d="${d}" class="tile" />
                </g>`, id: `tile_r${r}_c${c}`
        });
      }
    }

    // 4. Write File
    const generatedFiles: string[] = [];
    const m = 0; // increment for margin
    const vbX = minX - m;
    const vbY = minY - m;
    const vbW = (maxX - minX) + m * 2;
    const vbH = (maxY - minY) + m * 2;

    // Fallback if empty
    if (!isFinite(vbW)) { console.warn("SVG Bounds infinite?"); return []; }

    for (const tile of explodedTiles) {
      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(2)} ${vbY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}" width="${vbW}mm" height="${vbH}mm" style="background-color:white">\n`;
      svgContent += `<style> .tile { fill:#f0f0f0; stroke:none; } </style>\n`;
      svgContent += tile.svg;
      svgContent += `\n</svg>`;

      const svgOut = path.join(outputPath, `${tile.id}.svg`);
      fs.writeFileSync(svgOut, svgContent);
      console.log(`💾 SVG Layout saved: ${svgOut}`);
      generatedFiles.push(svgOut);
    }

    return generatedFiles;
  }

  public static async generateFromPolygons(
    polygons: Point[][],
    width: number,
    height: number,
    outputPath: string
  ): Promise<string[]> {
    console.log(`\n--- SVG Export (From Watershed Polygons) ---`);
    console.log(`Tiles: ${polygons.length}`);

    const generatedFiles: string[] = [];

    // Calculate Global Bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polygons) {
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }

    const m = 0;
    const vbX = minX !== Infinity ? minX - m : 0;
    const vbY = minY !== Infinity ? minY - m : 0;
    const vbW = minX !== Infinity ? (maxX - minX) + m * 2 : width;
    const vbH = minY !== Infinity ? (maxY - minY) + m * 2 : height;

    // Fallback
    if (!isFinite(vbW)) { console.warn("SVG Bounds infinite?"); return []; }

    for (let i = 0; i < polygons.length; i++) {
      const poly = polygons[i];

      let d = `M ${poly[0].x.toFixed(2)} ${poly[0].y.toFixed(2)} `;
      for (let k = 1; k < poly.length; k++) {
        d += `L ${poly[k].x.toFixed(2)} ${poly[k].y.toFixed(2)} `;
      }
      d += "Z";

      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX.toFixed(2)} ${vbY.toFixed(2)} ${vbW.toFixed(2)} ${vbH.toFixed(2)}" width="${vbW}mm" height="${vbH}mm" style="background-color:white">\n`;
      svgContent += `<style> .tile { fill:#f0f0f0; stroke:none; } </style>\n`;
      svgContent += `<g id="tile_${i}"> <path d="${d}" class="tile" /> </g>`;
      svgContent += `\n</svg>`;

      const svgOut = path.join(outputPath, `tile_${i}.svg`);
      fs.writeFileSync(svgOut, svgContent);
      console.log(`💾 SVG Layout saved: ${svgOut}`);
      generatedFiles.push(svgOut);
    }

    return generatedFiles;
  }
}
