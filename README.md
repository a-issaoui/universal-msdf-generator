# Universal MSDF Generator (UMG) 🛰️

[![NPM Version](https://img.shields.io/npm/v/@a-issaoui/universal-msdf-generator.svg)](https://www.npmjs.com/package/@a-issaoui/universal-msdf-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![NPM Downloads](https://img.shields.io/npm/dm/@a-issaoui/universal-msdf-generator.svg)](https://www.npmjs.com/package/@a-issaoui/universal-msdf-generator)

The **Universal MSDF Generator** is an enterprise-grade orchestration engine for creating Multi-channel Signed Distance Field typographic assets. Built for **Node.js 18+**, it leverages **WebAssembly** (via `msdfgen-wasm`, Viktor Chlumský's msdfgen) for fast generation speeds, zero CVEs, and production-grade stability.

## 🚀 Key Features
- **High-Performance Rendering**: Leverages `msdfgen-wasm` (Viktor Chlumský's authoritative msdfgen, compiled to WASM) for fast, cross-platform MSDF conversion with zero CVEs.
- **AngelCode Compliance**: Generates standard `.fnt` and `.png` assets compatible with PixiJS v8.
- **Hyper-Range Stability**: Support for massive 32px distance fields for razor-sharp edges.
- **Universal Fetching**: Download directly from Google Fonts, remote URLs, or local files.
- **Identity Sync**: Deterministic asset naming ensures zero cache-misses and 100% certified reliability.

### 🧠 Smart Re-use (Filesystem Cache)
The CLI and Node API are engineered for build-time efficiency. UMG automatically detects existing output files and skips redundant generation, saving critical seconds in your development and CI/CD pipelines.

### 🌍 Universal Fetching
One engine to rule them all. UMG flawlessly resolves fonts from:
- **Google Fonts**: Download by name (e.g., `Orbitron`, `Roboto:700`).
- **Remote URLs**: Direct processing from any CDN.
- **Local Filesystem**: Direct support for `.ttf` and `.otf` files.

### ♾️ Infinity Zoom (Interactive Demo)
Witness the perfection. Our generated fonts maintain **perfectly sharp, vector-like edges** even at extreme magnification (25.0x zoom and beyond). Check the `examples/` directory for an interactive PixiJS visualization.

---

## 🎨 Interactive Visualization

Want to see the quality in action? We've provided a **PixiJS Infinity Zoom** demo:

1. **Launch the Demo Server**:
   ```bash
   node examples/serve.js
   ```
2. **Open the link**: [http://localhost:3003/](http://localhost:3003/)
3. **Explore**: Zoom deep into the font's edges and witness the zero-pixelation advantage of MSDF.

---

## 🛠️ Installation

```bash
npm install @a-issaoui/universal-msdf-generator
```

---

## 💻 CLI Usage (Enterprise Mode)

UMG provides a sophisticated CLI for build-time asset generation.

```bash
# Generate from Google Fonts with smart re-use
npx universal-msdf "Orbitron" --out ./assets

# Batch mode: multiple fonts in one command
npx universal-msdf Roboto "Open Sans" Lato --concurrency 2 --out ./assets

# Local file with custom quality settings
npx universal-msdf "./fonts/MyFont.ttf" --size 64 --range 8 --edge-coloring inktrap

# Force re-generation and output both JSON and FNT
npx universal-msdf "Roboto" --force --format both --weight 700
```

### CLI Flags
| Flag | Description | Default |
|------|-------------|---------|
| `--out`, `-o` | Output directory | `./output` |
| `--charset`, `-c` | Preset (`ascii`, `alphanumeric`, `latin`, `cyrillic`) or literal string | `latin` |
| `--size`, `-s` | Font size in pixels | `48` |
| `--range`, `-r` | Distance field range in pixels | `4` |
| `--format` | Output format: `json` \| `fnt` \| `both` \| `all` | `json` |
| `--weight`, `-w` | Font weight, e.g. `400`, `700`, `bold` | `400` |
| `--style` | Font style, e.g. `normal`, `italic` | `normal` |
| `--name`, `-n` | Override output filename stem | derived |
| `--edge-coloring` | Edge algorithm: `simple` \| `inktrap` \| `distance` | `simple` |
| `--padding` | Glyph padding in atlas (px) | `2` |
| `--fix-overlaps` | Pre-process glyph paths to fix overlapping contours | `true` |
| `--no-fix-overlaps` | Disable overlap fixing | — |
| `--timeout` | Max ms to wait for generation before failing | `60000` |
| `--concurrency` | Max parallel fonts in batch mode | unlimited |
| `--reuse` | Skip generation if output files exist | `true` |
| `--no-reuse` | Always re-generate | — |
| `--force`, `-f` | Force re-generation (overrides `--reuse`) | `false` |
| `--save-font` | Persist downloaded font binary to output directory | `false` |
| `--verbose`, `-v` | Enable detailed logs | `true` |
| `--quiet`, `-q` | Suppress all non-error output | — |

---

## 📦 Documentation (API)

UMG is built with **TypeScript 6.0** and provides full type safety for your projects.

### Single Generation
```typescript
import { generate } from '@a-issaoui/universal-msdf-generator';

const result = await generate('Orbitron', {
  outputDir: './assets',
  reuseExisting: true
});

if (result.success) {
  console.log(`Generated: ${result.fontName}`);
  console.log(`Paths: ${result.savedFiles.join(', ')}`);
}
```

### Batch Processing
Efficiently process an entire font library in a single call. Runs in parallel by default; use `concurrency` to cap simultaneous jobs.

```typescript
import { generateMultiple } from '@a-issaoui/universal-msdf-generator';

const results = await generateMultiple(['Roboto', 'Open Sans', 'Lato'], {
  outputDir: './assets',
  charset: 'ascii',
  concurrency: 2, // optional: max parallel generations
});
```

### Generation Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `outputDir` | `string` | — | Directory to save output files |
| `outputFormat` | `'json' \| 'fnt' \| 'both' \| 'all'` | `'json'` | Which layout file(s) to write |
| `charset` | `string \| string[]` | `'latin'` | Preset name or literal character string |
| `fontSize` | `number` | `48` | Glyph rasterization size in pixels |
| `fieldRange` | `number` | `4` | SDF distance range in pixels — `2–4` for sharp UI text, `6–8` for glow/outline effects |
| `textureSize` | `[number, number]` | auto | Atlas texture dimensions; auto-sizes to next POT if omitted |
| `edgeColoring` | `'simple' \| 'inktrap' \| 'distance'` | `'simple'` | Edge coloring algorithm — `inktrap` reduces artifacts on decorative glyphs |
| `padding` | `number` | `2` | Glyph padding in atlas (px) — prevents bleed, required for mipmapping |
| `fixOverlaps` | `boolean` | `true` | Pre-process glyph paths to fix overlapping contours |
| `weight` | `string` | `'400'` | Font weight (used in output filename) |
| `style` | `string` | `'normal'` | Font style (used in output filename) |
| `name` | `string` | derived | Override the output filename stem |
| `reuseExisting` | `boolean` | `true` | Skip generation if output files already exist |
| `force` | `boolean` | `false` | Regenerate even when `reuseExisting` is set |
| `saveFontFile` | `boolean` | `false` | Save the downloaded font binary to the `outputDir` |
| `concurrency` | `number` | unlimited | Max parallel fonts in `generateMultiple` |
| `generationTimeout` | `number` | `60000` | Max ms before a generation attempt times out |
| `verbose` | `boolean` | `true` | Log progress to stdout |
| `onProgress` | `function` | — | `(progress, completed, total) => void` progress callback |

---

## 🏅 Technical Excellence

- **100% Code Coverage**: Every single branch and line is rigorously tested.
- **Wasm Powered**: Single-dependency runtime via `msdfgen-wasm` — zero CVEs, no native builds.
- **Node.js 18+ Compatible**: Tested on Node.js 18, 20, and 22.
- **Dual Build**: Ships with both **ESM** and **CJS** support.

---

## 🤝 Authors & License
Maintained by **[a-issaoui](https://github.com/a-issaoui)**.

Licensed under the **MIT License**. Check the `LICENSE` file for more details.