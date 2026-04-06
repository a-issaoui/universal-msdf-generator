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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[UMG Static] ${req.method} ${url.pathname}`);

  try {
    // ═════════════════════════════════════════════════════════════════════
    // API ENDPOINT: Dynamic MSDF Generation
    // ═════════════════════════════════════════════════════════════════════

    if (url.pathname === '/api/generate') {
      /**
       * Query parameter: font
       * Default: 'Orbitron'
       * Specifies the font family to generate
       */
      const font = url.searchParams.get('font') || 'Orbitron';
      console.log(`🎨 Dynamic Generation Request: ${font}`);

      /**
       * GENERATION CONFIGURATION
       *
       * These parameters control the quality and characteristics of the
       * generated MSDF texture. They must match the client's expectations
       * for optimal rendering.
       *
       * fontSize: 256
       *   - The size at which glyphs are rasterized for SDF generation
       *   - Larger = more detail but bigger texture
       *   - Must match the fontSize used in PixiJS BitmapText
       *
       * textureSize: [2048, 2048]
       *   - Size of the output texture atlas
       *   - Must be power-of-2 for mipmapping (though we disable it)
       *   - 2048x2048 fits ~100-200 glyphs at 256px each
       *
       * fieldRange: 4
       *   - Distance in pixels from the edge to store in SDF
       *   - Higher = better quality at small sizes, but less precision
       *   - 4 is optimal for 256px glyphs
       *
       * outputFormat: 'all'
       *   - Generates both .png (texture) and .fnt (metadata)
       *
       * reuseExisting: true
       *   - Skip regeneration if files already exist
       *   - Speeds up server restarts
       */
      const result = await generator.generate(font, {
        verbose: true,
        reuseExisting: true,
        outputDir: ASSETS_DIR,
        fontSize: 256, // ← Match client fontSize
        textureSize: [2048, 2048], // ← Power of 2
        fieldRange: 4, // ← Distance field range
        outputFormat: 'all', // ← PNG + FNT
      });

      if (!result.success) throw new Error(result.error);

      /**
       * RESPONSE OPTIMIZATION
       *
       * The generator returns large Base64/Binary data buffers.
       * We strip these from the JSON response because:
       * 1. Client loads textures separately via PIXI.Assets.load()
       * 2. Reduces response from ~5MB to ~500 bytes
       * 3. Client only needs fontName to construct URLs
       */
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
    res.end(`Internal Server Error: ${err.message}`);
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
