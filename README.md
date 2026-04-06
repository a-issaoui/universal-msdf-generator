# Universal MSDF Generator (UMG) 🛰️

[![NPM Version](https://img.shields.io/npm/v/@a-issaoui/universal-msdf-generator.svg)](https://www.npmjs.com/package/@a-issaoui/universal-msdf-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![NPM Downloads](https://img.shields.io/npm/dm/@a-issaoui/universal-msdf-generator.svg)](https://www.npmjs.com/package/@a-issaoui/universal-msdf-generator)

The **Universal MSDF Generator** is an enterprise-grade orchestration engine for creating Multi-channel Signed Distance Field typographic assets. Built for **Node.js 18+**, it leverages **WebAssembly** (via `msdf-bmfont-xml`) to provide fast generation speeds and production-grade stability.

## 🚀 Key Features
- **High-Performance Rendering**: Leverages WebAssembly for fast, cross-platform MSDF conversion.
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
# Generate Orbitron from Google Fonts with automatic "Smart Re-use"
npx universal-msdf "Orbitron" --out ./assets

# Process a local file with specific charset and weight
npx universal-msdf "./fonts/MyFont.ttf" --charset "alphanumeric" --weight 700

# Force re-generation (bypass smart re-use)
npx universal-msdf "Roboto" --force
```

### CLI Flags
| Flag | Description | Default |
|------|-------------|---------|
| `--out`, `-o` | Output directory | Current Dir |
| `--charset`, `-c` | Preset name (`ascii`, `alphanumeric`, `latin`, `cyrillic`) or a literal character string | `ascii` |
| `--reuse` | Enable "Smart Re-use" to skip existing files | `true` |
| `--force`, `-f` | Disable "Smart Re-use" and force generation | `false` |
| `--verbose`, `-v` | Enable detailed processing logs | `true` |

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
| `charset` | `string \| string[]` | `'alphanumeric'` | Preset name or literal character string |
| `fontSize` | `number` | `48` | Glyph rasterization size in pixels |
| `fieldRange` | `number` | `4` | SDF distance range in pixels |
| `textureSize` | `[number, number]` | auto | Atlas texture dimensions |
| `weight` | `string` | `'400'` | Font weight (used in output filename) |
| `style` | `string` | `'normal'` | Font style (used in output filename) |
| `name` | `string` | derived | Override the output filename stem |
| `reuseExisting` | `boolean` | `false` | Skip generation if output files already exist |
| `force` | `boolean` | `false` | Regenerate even when `reuseExisting` is set |
| `concurrency` | `number` | unlimited | Max parallel fonts in `generateMultiple` |
| `generationTimeout` | `number` | `60000` | Max ms before a generation attempt times out |
| `verbose` | `boolean` | `true` | Log progress to stdout |

---

## 🏅 Technical Excellence

- **100% Code Coverage**: Every single branch and line is rigorously tested.
- **Wasm Powered**: Leveraging WebAssembly for fast, cross-platform MSDF conversion.
- **Node.js 18+ Compatible**: Tested on Node.js 18, 20, and 22.
- **Dual Build**: Ships with both **ESM** and **CJS** support.

---

## 🤝 Authors & License
Maintained by **[a-issaoui](https://github.com/a-issaoui)**.

Licensed under the **MIT License**. Check the `LICENSE` file for more details.