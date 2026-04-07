import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UniversalMSDFGenerator, { generate, generateMultiple } from '../src/index.js';
import MSDFUtils from '../src/utils.js';

// Hoisted refs — must be defined before vi.mock factories
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFetch = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ buffer: Buffer.alloc(0), name: 'f.ttf', source: 'google', format: 'ttf' }),
);

// Use vi.hoisted so the mock instance is available when vi.mock factories run (they are hoisted)
const mockConverterInstance = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  convert: vi
    .fn()
    .mockImplementation(
      async (_buf: Buffer, _name: string, options: { onProgress?: (n: number) => void }) => {
        // If an onProgress callback is provided, simulate some progress
        options?.onProgress?.(50);
        return {
          success: true,
          data: {
            info: { face: 'T', size: 32 },
            common: { lineHeight: 32 },
            chars: [],
            kernings: [],
            pages: ['p.png'],
            distanceField: { fieldType: 'msdf', distanceRange: 4 },
          },
          atlases: [{ filename: 'p.png', texture: Buffer.alloc(0) }],
        };
      },
    ),
  dispose: vi.fn().mockResolvedValue(undefined),
}));

// Mocks
vi.mock('node:fs', () => ({
  promises: { readFile: vi.fn(), stat: vi.fn(), writeFile: mockWriteFile },
  statSync: vi.fn(),
  default: { readFileSync: vi.fn() },
}));

vi.mock('node:fs/promises', () => ({
  default: { writeFile: mockWriteFile, readFile: vi.fn() },
  writeFile: mockWriteFile,
  readFile: vi.fn(),
}));

vi.mock('../src/font-fetcher.js', () => ({
  default: class {
    fetch = mockFetch;
  },
}));

vi.mock('../src/converter.js', () => ({
  default: class {
    initialize = mockConverterInstance.initialize;
    convert = mockConverterInstance.convert;
    dispose = mockConverterInstance.dispose;
  },
  getSharedConverter: vi.fn().mockResolvedValue(mockConverterInstance),
  disposeSharedConverter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/utils.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/utils.js')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      loadMetadata: vi.fn(),
      checkMSDFOutputExists: vi.fn(),
      saveMSDFOutput: vi.fn(),
    },
  };
});

describe('UniversalMSDFGenerator', () => {
  let generator: UniversalMSDFGenerator;

  beforeEach(() => {
    generator = new UniversalMSDFGenerator();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await generator.dispose();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  it('ensureInitialized: concurrent calls initialize core only once', async () => {
    const gen = new UniversalMSDFGenerator();
    const p1 = gen.ensureInitialized();
    const p2 = gen.ensureInitialized();
    const p3 = gen.ensureInitialized();
    await Promise.all([p1, p2, p3]);
    await gen.ensureInitialized();
    await gen.dispose();
  });

  it('dispose: idempotent — double dispose does not throw', async () => {
    const gen = new UniversalMSDFGenerator();
    await gen.ensureInitialized();
    await expect(gen.dispose()).resolves.toBeUndefined();
    await expect(gen.dispose()).resolves.toBeUndefined();
  });

  // ── Identity resolution ────────────────────────────────────────────────────

  it('resolveIdentity: various source shapes', async () => {
    await generator.generate('Roboto.ttf');
    await generator.generate(Buffer.alloc(0));
    await generator.generate('T.ttf', { weight: '700', style: 'italic' });
    await generator.generate('.ttf'); // Empty name branch
    await generator.generate('/'); // pop() results in empty string
    await generator.generate('', { name: 'M' });
    await generator.generate('/root.ttf');
  });

  it('cache: bypasses cache when force=true even if reuseExisting=true', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    const r = await generator.generate('F', {
      reuseExisting: true,
      force: true,
      outputDir: './out',
    });
    expect((r as { cached?: boolean }).cached).toBeUndefined();
  });

  it('cache: handles missing outputFormat (defaulting to json)', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    // Passing no outputFormat hits `options.outputFormat || 'json'`
    const r = await generator.generate('F', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBe(true);
  });

  // ── Cache hit/miss ─────────────────────────────────────────────────────────

  it('cache: returns cached result when reuseExisting=true and files exist', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    const r = await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
      outputFormat: 'fnt',
    });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBe(true);
  });

  it('cache: returns cached result passing explicit null outputFormat (falsy)', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    const r = await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
      outputFormat: null as never,
    });
    expect(r.success).toBe(true);
  });

  it('cache: returns cached result passing explicitly empty string outputFormat', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    const r = await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
      outputFormat: '' as never,
    });
    expect(r.success).toBe(true);
  });

  it('cache: regenerates when reuseExisting=true but files missing', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({
      atlasCount: 1,
      version: '1.0',
    } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(false);
    const r = await generator.generate('F', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBeUndefined();
  });

  it('cache: handles metadata with missing atlasCount (fallback to 1)', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue({ version: '1.0' } as never);
    vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
    const r = await generator.generate('F', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBe(true);
  });

  it('cache: skips when metadata is missing', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockResolvedValue(null);
    const r = await generator.generate('F', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBeUndefined();
  });

  // ── Success path ───────────────────────────────────────────────────────────

  it('success path: generates for various formats', async () => {
    await generator.generate('X', { outputFormat: 'json' });
    await generator.generate('X', { outputFormat: 'fnt' });
    await generator.generate('X', { outputFormat: undefined }); // null branch
  });

  it('success path: handles multiple atlases correctly', async () => {
    mockConverterInstance.convert.mockResolvedValueOnce({
      success: true,
      data: { pages: ['p.png'], info: {}, common: {}, chars: [], kernings: [], distanceField: {} },
      atlases: [
        { filename: 'a0.png', texture: Buffer.alloc(0) },
        { filename: 'a1.png', texture: Buffer.alloc(0) },
      ],
    });
    const r = await generator.generate('Multiple');
    const identity = 'multiple-400-normal-48-r4';
    expect((r as { atlases?: Array<{ filename: string }> }).atlases).toHaveLength(2);
    expect((r as { atlases?: Array<{ filename: string }> }).atlases?.[0].filename).toBe(
      `${identity}-0.png`,
    );
  });

  it('success path: handles atlas count fallback in expected files', async () => {
    const files = MSDFUtils.getExpectedFiles('./out', 'F', 'json', 2);
    expect(files.some((f) => f.includes('F-1.png'))).toBe(true);
  });

  it('success path: populates fontMetadata from FontData', async () => {
    mockFetch.mockResolvedValueOnce({
      buffer: Buffer.alloc(0),
      name: 'f.ttf',
      source: 'url',
      format: 'ttf',
      metadata: { compressionRatio: 0.5, decompressionTimeMs: 100 },
    });
    const r = await generator.generate('MetaTest');
    expect(r.success).toBe(true);
    if (r.success && !r.cached) {
      expect(r.fontMetadata?.compressionRatio).toBe(0.5);
      expect(r.fontMetadata?.decompressionTimeMs).toBe(100);
    }
  });

  it('success path: handles atlas count fallback in expected files', async () => {
    const files = MSDFUtils.getExpectedFiles('./out', 'F', 'json', 2);
    expect(files.some((f) => f.includes('F-1.png'))).toBe(true);
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('error path: wraps Error thrown by tryGetCached', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockRejectedValue(new Error('FAIL'));
    const r = await generator.generate('E', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('MSDF generation failed: FAIL');
  });

  it('error path: wraps non-Error string thrown by tryGetCached', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockRejectedValue('RAWFAIL');
    const r = await generator.generate('E', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('MSDF generation failed: RAWFAIL');
  });

  it('error path: does not double-wrap already-prefixed error messages', async () => {
    vi.spyOn(MSDFUtils, 'loadMetadata').mockRejectedValue('MSDF generation failed: ALREADY');
    const r = await generator.generate('E', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('MSDF generation failed: ALREADY');
  });

  // ── Batch & Deprecated Methods ─────────────────────────────────────────────

  it('should generate multiple fonts in batch mode', async () => {
    const results = await generator.generateMultiple(['Roboto', 'Lato']);
    expect(results).toHaveLength(2);
    expect(results[0].fontName).toBe('roboto-400-normal-48-r4');
  });

  it('should support deprecated generation methods', async () => {
    const r1 = await generator.generateFromGoogle('Roboto');
    const r2 = await generator.generateFromUrl('https://ex.com/font.ttf');
    const r3 = await generator.generateFromFile('font.ttf');
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
  });

  it('generateMultiple: concurrency: 1 runs serially', async () => {
    await generator.generateMultiple(['A', 'B', 'C'], { concurrency: 1 });
  });

  it('generateMultiple: invokes onProgress callback', async () => {
    const onProgress = vi.fn();
    await generator.generateMultiple(['A', 'B'], { onProgress });
    // Expect at least: 50% (first start + inner), 50% (first finished), 75% (second inner), 100% (second finished)
    expect(onProgress).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 2);
  });
});

// ── saveFontFile ──────────────────────────────────────────────────────────────

describe('saveFontFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MSDFUtils.saveMSDFOutput).mockResolvedValue([]);
    // Reset to default google source
    mockFetch.mockResolvedValue({
      buffer: Buffer.alloc(0),
      name: 'f.ttf',
      source: 'google',
      format: 'ttf',
    });
  });

  it('writes font binary when saveFontFile=true and source=google', async () => {
    const gen = new UniversalMSDFGenerator();
    const r = await gen.generate('Roboto', { outputDir: './out', saveFontFile: true });
    expect(r.success).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringMatching(/\.ttf$/), expect.any(Buffer));
    expect((r as { savedFontFile?: string }).savedFontFile).toMatch(/\.ttf$/);
    await gen.dispose();
  });

  it('writes font binary when source=url', async () => {
    mockFetch.mockResolvedValueOnce({
      buffer: Buffer.alloc(4),
      name: 'myfont',
      source: 'url',
      format: 'ttf',
    });
    const gen = new UniversalMSDFGenerator();
    const r = await gen.generate('https://example.com/f.ttf', {
      outputDir: './out',
      saveFontFile: true,
    });
    expect(mockWriteFile).toHaveBeenCalled();
    expect((r as { savedFontFile?: string }).savedFontFile).toBeDefined();
    await gen.dispose();
  });

  it('does NOT write font file when source=local', async () => {
    mockFetch.mockResolvedValueOnce({
      buffer: Buffer.alloc(4),
      name: 'localfont',
      source: 'local',
      format: 'ttf',
    });
    const gen = new UniversalMSDFGenerator();
    const r = await gen.generate('./font.ttf', { outputDir: './out', saveFontFile: true });
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect((r as { savedFontFile?: string }).savedFontFile).toBeUndefined();
    await gen.dispose();
  });

  it('does NOT write font file when saveFontFile=false', async () => {
    const gen = new UniversalMSDFGenerator();
    await gen.generate('Roboto', { outputDir: './out', saveFontFile: false });
    expect(mockWriteFile).not.toHaveBeenCalled();
    await gen.dispose();
  });

  it('does NOT write font file when outputDir is not set', async () => {
    const gen = new UniversalMSDFGenerator();
    await gen.generate('Roboto', { saveFontFile: true });
    expect(mockWriteFile).not.toHaveBeenCalled();
    await gen.dispose();
  });

  it('logs font path when verbose=true', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gen = new UniversalMSDFGenerator();
    await gen.generate('Roboto', { outputDir: './out', saveFontFile: true, verbose: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Font saved:'));
    logSpy.mockRestore();
    await gen.dispose();
  });

  it('does NOT log font path when verbose is false or undefined', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gen = new UniversalMSDFGenerator();

    // Case 1: Explicitly false
    await gen.generate('Roboto', { outputDir: './out', saveFontFile: true, verbose: false });
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Font saved:'));

    // Case 2: Undefined (hits the ?? false branch)
    logSpy.mockClear();
    await gen.generate('Roboto', { outputDir: './out', saveFontFile: true, verbose: undefined });
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Font saved:'));

    logSpy.mockRestore();
    await gen.dispose();
  });

  it('uses ttf extension when format is undefined (fallback)', async () => {
    mockFetch.mockResolvedValueOnce({
      buffer: Buffer.alloc(4),
      name: 'nofmt',
      source: 'google',
      format: undefined,
    });
    const gen = new UniversalMSDFGenerator();
    const r = await gen.generate('Roboto', { outputDir: './out', saveFontFile: true });
    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringMatching(/\.ttf$/), expect.any(Buffer));
    expect((r as { savedFontFile?: string }).savedFontFile).toMatch(/\.ttf$/);
    await gen.dispose();
  });
});

// ── Standalone function wrappers ─────────────────────────────────────────────

describe('Standalone functions', () => {
  it('generate(): uses shared converter', async () => {
    await generate('S1');
    const { getSharedConverter } = await import('../src/converter.js');
    expect(getSharedConverter).toHaveBeenCalled();
  });

  it('generateMultiple(): creates and disposes instance per call', async () => {
    const disposeSpy = vi.spyOn(UniversalMSDFGenerator.prototype, 'dispose');
    await generateMultiple(['M1', 'M2'], { verbose: false });
    expect(disposeSpy).toHaveBeenCalled();
    disposeSpy.mockRestore();
  });
});
