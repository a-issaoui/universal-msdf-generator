/**
 * Universal MSDF Generator Server
 *
 * This server provides:
 * 1. Dynamic MSDF font generation via /api/generate
 * 2. Static file serving for the demo application
 *
 * MSDF (Multi-channel Signed Distance Field) is a technique for rendering
 * scalable text/textures. Unlike standard bitmap fonts, MSDF maintains
 * sharp edges at any resolution by storing signed distance to the nearest
 * edge in each pixel's RGB channels.
 */

import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import UniversalMSDFGenerator from '../dist/index.js';

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

/** @const {number} Server port */
const PORT = 3003;

/**
 * @const {string} Directory for generated font assets
 * Must be accessible from the client via /examples/assets/fonts/
 */
const ASSETS_DIR = path.resolve('examples/assets/fonts');

/**
 * Initialize the MSDF Generator
 * verbose: true - Logs generation details to console
 */
const generator = new UniversalMSDFGenerator({ verbose: true });

// ═════════════════════════════════════════════════════════════════════════════
// MIME TYPE MAPPING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * MIME types for static file serving
 * Required for browsers to interpret files correctly
 */
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png', // MSDF texture format
  '.fnt': 'application/xml', // AngelCode BMFont format (XML)
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
};

// ═════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════════

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: script server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[UMG Static] ${req.method} ${url.pathname}`);

  try {
    // ═════════════════════════════════════════════════════════════════════
    // API ENDPOINT: Dynamic MSDF Generation
    // ═════════════════════════════════════════════════════════════════════

    if (url.pathname === '/api/generate') {
      const font = url.searchParams.get('font') || 'Orbitron';
      // `text`    — RTL-only string that gets shaped through HarfBuzz.
      //             Must NOT include LTR text; HarfBuzz BiDi would reverse it.
      // `charset` — full set of characters to include in the atlas (LTR + RTL).
      //             When absent, falls back to `text`, then 'latin'.
      const text = url.searchParams.get('text') || '';
      const charset = url.searchParams.get('charset') || text || 'latin';
      const complexShaping = url.searchParams.get('complexShaping') === 'true';

      console.log(`🎨 Dynamic Generation Request: ${font} (Complex: ${complexShaping})`);
      console.log(
        `   charset (${charset.length} chars): ${JSON.stringify(charset.slice(0, 80))}${charset.length > 80 ? '…' : ''}`,
      );
      console.log(`   shapingText: ${JSON.stringify(text || '(none)')}`);

      const startTime = performance.now();
      const result = await generator.generate(font, {
        verbose: true,
        reuseExisting: false,
        outputDir: ASSETS_DIR,
        fontSize: 256,
        textureSize: [2048, 2048],
        fieldRange: 4,
        outputFormat: 'all',
        saveFontFile: true,
        charset,
        complexShaping,
        ...(text ? { shapingText: text } : {}),
      });
      const duration = performance.now() - startTime;
      console.log(`⏱️ Generation took ${duration.toFixed(2)}ms`);

      if (!result.success) throw new Error(result.error);

      // Debug: log shaping metadata
      if (result.metadata) {
        console.log(`🔍 Shaping metadata:`);
        console.log(`   shapingEngine : ${result.metadata.shapingEngine ?? 'none'}`);
        console.log(`   shapedText    : ${JSON.stringify(result.metadata.shapedText ?? '(none)')}`);
        if (result.metadata.shapedText) {
          const codes = [...result.metadata.shapedText].map(
            (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
          );
          console.log(`   shapedText codepoints: ${codes.join(' ')}`);
        }
        console.log(
          `   glyphIdMap keys: ${result.metadata.glyphIdMap ? Object.keys(result.metadata.glyphIdMap).length : 0}`,
        );
        console.log(`   charset size  : ${result.metadata.charset}`);
      }

      const { data: _data, atlases: _atlases, ...clientSafeResult } = result;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(clientSafeResult));
      return;
    }

    // ═════════════════════════════════════════════════════════════════════
    // STATIC FILE SERVING
    // ═════════════════════════════════════════════════════════════════════

    /**
     * URL Routing:
     * / → /examples/pixi-demo.html (main application)
     * /examples/assets/fonts/* → Generated MSDF files
     * /* → Static files relative to cwd
     */
    const urlPath = url.pathname === '/' ? '/examples/pixi-demo.html' : url.pathname;
    const filePath = path.join(process.cwd(), urlPath);

    try {
      // Read file from disk
      const content = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Serve with appropriate MIME type
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      });
      res.end(content);
    } catch (_err) {
      // File not found
      res.writeHead(404);
      res.end(`File not found: ${url.pathname}`);
    }
  } catch (err) {
    // Server error
    console.error('💥 Server Error:', err);
    res.writeHead(500);
    res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═════════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`\n🚀 Universal MSDF Engine Visualizer: http://localhost:${PORT}`);
  console.log(`📂 Serving assets from: ${ASSETS_DIR}`);
  console.log(`\n📖 API Endpoints:`);
  console.log(`   GET /api/generate?font=FontName - Generate MSDF font`);
  console.log(`   GET /examples/assets/fonts/*     - Access generated files`);
});
