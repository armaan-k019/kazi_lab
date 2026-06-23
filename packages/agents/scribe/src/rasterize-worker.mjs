// Isolated PDF rasterizer. Runs in its OWN process (spawned by pdf-vision.ts)
// so a native segfault in pdfjs/canvas terminates only this worker, never the
// parent backfill. Plain .mjs (no TS) so it can be launched directly with node;
// it only uses pdfjs-dist + @napi-rs/canvas + node builtins.
//
// argv: <pdfPath> <outDir> <maxPages> <scale>
// Writes page-001.png ... to <outDir> and exits 0 on success, 1 on failure.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

async function main() {
  const [, , pdfPath, outDir, maxPagesArg, scaleArg] = process.argv;
  if (!pdfPath || !outDir) {
    process.stderr.write("rasterize-worker: missing pdfPath/outDir\n");
    process.exit(1);
  }
  const maxPages = Number(maxPagesArg) || 12;
  const scale = Number(scaleArg) || 2.0;

  const { createCanvas } = await import("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Resolve pdfjs's bundled standard fonts + cmaps from the installed package
  // (not a hardcoded path). Without standardFontDataUrl, PDFs using the
  // standard 14 fonts fail with "Ensure that the standardFontDataUrl API
  // parameter is provided" and can crash the native canvas layer.
  const require = createRequire(import.meta.url);
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const standardFontDataUrl = join(pdfjsRoot, "standard_fonts") + "/";
  const cMapUrl = join(pdfjsRoot, "cmaps") + "/";

  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    verbosity: 0, // errors only
    isEvalSupported: false,
  }).promise;

  const count = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const name = `page-${String(i).padStart(3, "0")}.png`;
    writeFileSync(join(outDir, name), canvas.toBuffer("image/png"));
    page.cleanup();
  }
  await doc.cleanup().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`rasterize-worker failed: ${e?.message ?? e}\n`);
  process.exit(1);
});
