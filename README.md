# Universal MSDF Generator (UMG) 🛰️

[![NPM Version](https://img.shields.io/npm/v/universal-msdf-generator.svg)](https://www.npmjs.com/package/universal-msdf-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Node.js 25](https://img.shields.io/badge/Node.js-25-green)](https://nodejs.org/)
[![NPM Downloads](https://img.shields.io/npm/dm/universal-msdf-generator.svg)](https://www.npmjs.com/package/universal-msdf-generator)

The **Universal MSDF Generator** is a high-performance orchestration engine for creating Multi-channel Signed Distance Field typographic assets. Built for **Node.js 18+**, it leverages **Native C++ bindings via N-API** to provide sub-millisecond generation speeds and production-grade stability.

## 🚀 Key Features
- **High-Performance Rendering**: Leverages native C++ code for industry-leading speed.
- **AngelCode Compliance**: Generates standard `.fnt` and `.png` assets compatible with PixiJS v8.
- **Hyper-Range Stability**: Support for massive 32px distance fields for razor-sharp edges.
- **Universal Fetching**: Download directly from Google Fonts, remote URLs, or local files.
- **Identity Sync**: Deterministic asset naming ensures zero cache-misses and 404s.

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
2. **Open the link**: [http://localhost:3000/](http://localhost:3000/)
3. **Explore**: Zoom deep into the font's edges and witness the zero-pixelation advantage of MSDF.

---

## 🛠️ Installation

```bash
npm install universal-msdf-generator
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
| `--charset`, `-c` | Character set (ascii, alphanumeric, or custom) | `ascii` |
| `--reuse` | Enable "Smart Re-use" to skip existing files | `true` |
| `--force`, `-f` | Disable "Smart Re-use" and force generation | `false` |
| `--verbose`, `-v` | Enable detailed processing logs | `true` |

---

## 📦 Documentation (API)

UMG is built with **TypeScript 6.0** and provides full type safety for your projects.

### Single Generation
```typescript
import { generate } from 'universal-msdf-generator';

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
Efficiently process an entire font library in a single call.

```typescript
import { generateMultiple } from 'universal-msdf-generator';

const results = await generateMultiple(['Roboto', 'Open Sans', 'Lato'], {
  outputDir: './assets',
  charset: 'ascii'
});
```

---

## 🏅 Technical Excellence

- **100% Code Coverage**: Every single branch and line is rigorously tested.
- **Wasm Powered**: Leveraging the speed of C++ via WebAssembly for sub-millisecond conversion.
- **Node.js 25 Optimized**: Fully compatible with the latest modern runtimes.
- **Dual Build**: Ships with both **ESM** and **CJS** support.

---

## 🤝 Authors & License
Maintained by **[a-issaoui](https://github.com/a-issaoui)**.

Licensed under the **MIT License**. Check the `LICENSE` file for more details.