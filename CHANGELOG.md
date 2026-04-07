# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
