# Universal MSDF Generator Examples

This directory contains examples and a demo application for the Universal MSDF Generator.

## 🚀 Interactive Engine Visualizer (PixiJS)

The recommended way to explore the engine is our interactive PixiJS demo. It allows you to generate and visualize MSDF fonts from Google Fonts in real-time, focusing on absolute crispness and precision.

### Running the Demo
1. Install dependencies: `npm install`
2. Start the demo server: `node examples/serve.js`
3. Open your browser to: `http://localhost:3003`

**New in v1.10.0:** The demo now supports **Complex Scripts (Arabic, Hebrew, Persian, etc.)**. Simply select an Arabic font or paste Arabic text into the preview area, and the engine will automatically enable HarfBuzz shaping and PUA mapping.

---

## 💻 Code Examples

### 1. [Basic Usage](basic-usage.js)
The bread and butter. Shows how to generate MSDF from a Google Font or a remote URL and save it to disk.

### 2. [Advanced Configuration](advanced.js)
Dive deep into `textureSize`, `fieldRange`, `inktrap` edge coloring, and custom charsets.

### 3. [Complex Script Support](complex-shaping.js) **(NEW)**
Demonstrates the high-performance HarfBuzz shaping engine.
*   **Contextual Forms**: Automatic Initial, Medial, Final, and Isolated forms for Arabic/Persian.
*   **RTL Support**: Correct Right-To-Left character ordering.
*   **PUA Mapping**: How shaped glyphs are automatically mapped to the Private Use Area (E000-F8FF).

### 4. [WOFF2 Support](woff2-support.js)
Demonstrates automatic decompression of `.woff2` files using `wawoff2`.
*   Fetches Inter from a remote URL.
*   Decompresses and generates MSDF in a single step.
*   Provides statistics on compression ratio and decompression speed.

### 5. [Google Fonts Batching](google-fonts.js)
Shows how to efficiently generate multiple font weights and families in a single pass.

---

## 🛠️ Assets
*   **assets/**: Input assets and generated output from examples.
*   **serve.js**: A lightweight HTTP server that provides a dynamic /api/generate endpoint for the demo.

## 📖 Best Practices for Multilingual MSDF
When using complex scripts (Arabic, Hebrew, etc.), always set `complexShaping: true` in your generation options. This ensures that:
1. Ligatures and contextual forms are calculated via HarfBuzz.
2. The output Atlas includes these unique forms.
3. The `.fnt` (BMFont) file contains the correct PUA mappings so your renderer (like PixiJS) can find the "Joined" versions of the characters.
