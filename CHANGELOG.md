# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [1.10.0] - 2026-04-08

### Added
- **Streaming Atlas Output** (`streamAtlases: boolean`): Atlas pages are now written to disk one at a time as they are rendered, keeping peak memory at O(1 atlas page) regardless of charset size. Ideal for full CJK generation. Set `streamAtlases: true` alongside `outputDir` to enable.
- **Real WASM Termination**: `MSDFConverter` now runs the WASM computation in a dedicated Node.js `worker_thread`. On timeout, the worker thread is forcibly terminated — killing the WASM CPU task rather than merely abandoning a Promise.
- **`AtlasCallback` type**: Exported from `converter.ts` for advanced use cases where callers need to intercept each atlas page during generation.

### Changed
- **`font-fetcher.ts` refactored**: Network, security, Google Fonts, local file, and URL-handler concerns are split into dedicated sub-modules under `src/fetcher/`. Public API is unchanged.
- **Internal**: Incremental atlas loop replaces the previous bulk `bins.map(createAtlasImage)`, enabling streaming even without an explicit callback.

### Fixed
- **Code Quality**: Resolved all `biome` complexity warnings by extracting private helper methods (`_executeInlineConversion`, `_handleAtlasMsg`, `_resolveWorkerResult`, `setupAtlasStreaming`).

## [1.9.0] - 2026-04-08

### Added
- **WOFF2 Metadata**: Exposed `fontMetadata` in `MSDFResult`, providing detailed decompression stats (`originalFormat`, `wasConverted`, `compressionRatio`, `decompressionTimeMs`).
- **WOFF2 Example**: Added `examples/woff2-test.ts` to demonstrate automated decompression and generation from remote WOFF2 sources.

### Changed
- **Concurrency Control**: Upgraded `generateMultiple` with a high-throughput worker pool for faster multi-font generation.
- **Memory Optimization**: Refactored BMFont XML generation to use a streaming generator strategy, eliminating memory spikes for large glyph sets.

### Fixed
- **Security (SSRF/TOCTOU)**: Implemented DNS pinning in `FontFetcher` to prevent SSRF DNS rebinding attacks.
- **Security (Privacy)**: Anonymized filesystem error messages to prevent internal path leakage.
- **Networking**: Added dual support for `http.Agent` and `https.Agent` in the hardened network layer.
- **Caching**: Fixed non-deterministic cache misses in `utils.ts` by normalizing charset input keys.
- **Code Quality**: Achieved 100% test coverage across all new security and performance branches.
## [1.8.0] - 2026-04-07

### Added
- **Native WOFF2 Support**: Transparent, zero-configuration decompression of WOFF2 fonts into TTF/OTF format using `wawoff2` (WASM).
- **Automated Normalization**: All font acquisition channels (Google Fonts, URLs, local files, buffers) now automatically detect and decompress WOFF2 inputs.
- **Conversion Metadata**: Added `originalFormat`, `wasConverted`, and `stats` to the `FontData` interface for better observability.
- **Wasm Service**: Dedicated lazy-loaded `Woff2Service` with size validation and format verification.

### Changed
- **FontFetcher**: Integrated the unified `loadFont` pipeline into all acquisition channels, replacing legacy manual format detection.
- **CLI**: Updated help text and examples to emphasize native WOFF2 support.

### Fixed
- **Types**: Resolved implicit `any` issues in the test suite and added strict declarations for third-party WASM modules.

## [1.7.0] - 2026-04-07

### Added
- **FontFetcher**: Robust `AbortSignal` propagation across the entire asynchronous fetch pipeline (CSS resolution, network requests, retry logic, and local I/O).
- **Quality**: Achieved **100% branch coverage** for the entire `FontFetcher` lifecycle.

### Changed
- **Network**: Standardized `makeRequest` to bind internal timeouts with external `AbortSignal` reasons for precise cancellation handling.
- **Deduplication**: In-flight requests are now stored as `AbortController` instances to allow granular cancellation per cache key.

### Fixed
- **FontFetcher**: Resolved the `cancel()` bug where network requests and file system operations were not immediately terminated.


## [1.6.1] - 2026-04-07

### Added
- **FontFetcher**: Implemented full support for standard font weight aliases (Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Black). Normalization handles spaces and case-insensitivity.
- **Testing**: Expanded the test suite with a regression matrix for all weight aliases, maintaining 100% coverage.

## [1.6.0] - 2026-04-07

### Added
- **Core**: Added `saveFontFile` (API) / `--save-font` (CLI) feature to persist downloaded TTF binaries alongside MSDF assets.
- **FontFetcher**: Optimized Google Fonts fetching to prioritize compatible TTF/OTF formats when font-saving is enabled.
- **CLI**: Integrated font saving into the CLI with automated location reporting.

## [1.0.0] - 2026-04-06

### Added
- **Core**: Universal MSDF generation from Google Fonts, URLs, and Local Files.
- **CLI**: Enterprise-level CLI with `smart-reuse` filesystem caching.
- **Types**: Full TypeScript 6.0 support with exhaustive definitions.
- **Demo**: Interactive PixiJS v8 Infinity Zoom visualizer.
- **CI/CD**: Multi-version Node.js testing and coverage verification.
- **Quality**: 100% test coverage target with Biome linting.
