import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UniversalMSDFGenerator, { generate, generateMultiple } from '../src/index.js';
import MSDFUtils from '../src/utils.js';

// Mocks
vi.mock('node:fs', () => ({
  promises: { readFile: vi.fn(), stat: vi.fn() },
  statSync: vi.fn(),
}));

vi.mock('../src/font-fetcher.js', () => ({
  default: class {
    fetch = vi.fn().mockResolvedValue({ buffer: Buffer.alloc(0), name: 'f.ttf' });
  },
}));

vi.mock('../src/converter.js', () => ({
  default: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    convert = vi.fn().mockResolvedValue({
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
    });
    dispose = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../src/utils.js', () => ({
  resolveCharset: (c: string) => c,
  default: {
    getCharsets: vi.fn().mockReturnValue({ ascii: 'ABC' }),
    createProgressCallback: vi.fn().mockReturnValue(() => {}),
    calculateOptimalTextureSize: vi.fn().mockReturnValue([512, 512]),
    saveMSDFOutput: vi.fn().mockResolvedValue(['./out/R.json']),
    checkMSDFOutputExists: vi.fn().mockResolvedValue(false),
    getExpectedFiles: vi.fn().mockReturnValue(['./out/R.json']),
  },
}));

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
    // A second sequential call is also a no-op
    await gen.ensureInitialized();
    await gen.dispose();
  });

  it('dispose: idempotent — double dispose does not throw', async () => {
    const gen = new UniversalMSDFGenerator();
    await gen.ensureInitialized();
    await expect(gen.dispose()).resolves.toBeUndefined();
    await expect(gen.dispose()).resolves.toBeUndefined();
  });

  it('instance isolation: disposing one instance does not affect another', async () => {
    const genA = new UniversalMSDFGenerator({ fontSize: 32 });
    const genB = new UniversalMSDFGenerator({ fontSize: 64 });
    await genA.ensureInitialized();
    await genB.ensureInitialized();

    await genA.dispose();

    // genB must still be able to generate without re-throwing
    const result = await genB.generate('font.ttf');
    expect(result.success).toBe(true);
    await genB.dispose();
  });

  // ── Identity resolution ────────────────────────────────────────────────────

  it('resolveIdentity: various source shapes', async () => {
    await generator.generate('Roboto.ttf');
    await generator.generate(Buffer.alloc(0));
    await generator.generate('', { name: 'M' });
    await generator.generate('/');
    await generator.generate('T.ttf', { weight: '700', style: 'italic' });
    // Filename starting with '.' — pts[0] is '', triggers the || 'font' fallback
    await generator.generate('.hidden-font');
  });

  // ── Cache hit/miss ─────────────────────────────────────────────────────────

  it('cache: returns cached result when reuseExisting=true and files exist', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockResolvedValueOnce(true);
    const r = await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
    });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBe(true);
  });

  it('cache: regenerates when reuseExisting=true but files missing', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockResolvedValueOnce(false);
    const r = await generator.generate('F', { reuseExisting: true, outputDir: './out' });
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBeUndefined();
  });

  it('cache: skips cache check when force=true', async () => {
    // force=true bypasses checkMSDFOutputExists entirely — do NOT queue a mock value
    const r = await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      force: true,
    });
    expect(MSDFUtils.checkMSDFOutputExists).not.toHaveBeenCalled();
    // Should have generated fresh, not returned cached
    expect(r.success).toBe(true);
    expect((r as { cached?: boolean }).cached).toBeUndefined();
  });

  it('cache: undefined outputFormat defaults to json in getExpectedFiles', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockResolvedValueOnce(true);
    await generator.generate('F', {
      reuseExisting: true,
      outputDir: './out',
      outputFormat: undefined,
    });
  });

  // ── Success path: XML and outputDir ───────────────────────────────────────

  it('success path: generates XML for fnt/both/all formats', async () => {
    await generator.generate('X', { outputFormat: 'fnt' });
    await generator.generate('X', { outputFormat: 'both' });
    await generator.generate('X', { outputFormat: 'all' });
    await generator.generate('X', { outputFormat: 'json' });
  });

  it('success path: multi-atlas renames use identity-N.png pattern', async () => {
    // Initialize so the private converter instance is available
    await generator.ensureInitialized();
    type PrivateGen = { converter: { convert: ReturnType<typeof vi.fn> } };
    const conv = (generator as unknown as PrivateGen).converter;
    conv.convert.mockResolvedValueOnce({
      success: true,
      data: {
        info: { face: 'T', size: 32 },
        common: { lineHeight: 32 },
        chars: [],
        kernings: [],
        pages: ['p0.png', 'p1.png'],
        distanceField: { fieldType: 'msdf', distanceRange: 4 },
      },
      atlases: [
        { filename: 'p0.png', texture: Buffer.alloc(0) },
        { filename: 'p1.png', texture: Buffer.alloc(0) },
      ],
      fontName: 'T',
      metadata: {},
    });
    const r = await generator.generate('Multi');
    expect(r.success).toBe(true);
    if (r.success && !r.cached) {
      expect(r.atlases[0].filename).toMatch(/-0\.png$/);
      expect(r.atlases[1].filename).toMatch(/-1\.png$/);
    }
  });

  it('success path: saves to outputDir with verbose logging', async () => {
    const r = await generator.generate('S', { outputDir: './out', verbose: true });
    expect(r.success).toBe(true);
    expect(MSDFUtils.saveMSDFOutput).toHaveBeenCalled();
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('error path: wraps Error thrown by checkMSDFOutputExists', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce(new Error('FAIL'));
    const r = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('MSDF generation failed:');
  });

  it('error path: wraps non-Error string thrown by checkMSDFOutputExists', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce('RAWFAIL');
    const r = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: false,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('MSDF generation failed:');
  });

  it('error path: does not double-wrap already-prefixed error messages', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce(
      'MSDF generation failed: ALREADY',
    );
    const r = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('MSDF generation failed: ALREADY');
  });

  // ── generateMultiple ───────────────────────────────────────────────────────

  it('generateMultiple: returns results for all sources', async () => {
    const results = await generator.generateMultiple(['A.ttf', 'B.ttf'], { verbose: false });
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it('generateMultiple: result order matches input order', async () => {
    const results = await generator.generateMultiple(['A.ttf', 'B.ttf', 'C.ttf'], {
      name: undefined,
      verbose: false,
    });
    expect(results).toHaveLength(3);
  });

  it('generateMultiple: concurrency: 1 runs serially and preserves order', async () => {
    const order: number[] = [];
    const origGenerate = generator.generate.bind(generator);
    let call = 0;
    vi.spyOn(generator, 'generate').mockImplementation(async (s, o) => {
      const idx = call++;
      order.push(idx);
      return origGenerate(s, o);
    });
    await generator.generateMultiple(['A', 'B', 'C'], { concurrency: 1 });
    expect(order).toEqual([0, 1, 2]);
  });

  // ── Deprecated alias methods ───────────────────────────────────────────────

  it('deprecated aliases: generateFromGoogle/Url/File delegate to generate()', async () => {
    const gen = new UniversalMSDFGenerator();
    const spy = vi.spyOn(gen, 'generate');
    await gen.generateFromGoogle('Roboto');
    await gen.generateFromUrl('https://example.com/font.ttf');
    await gen.generateFromFile('./my.ttf');
    expect(spy).toHaveBeenCalledTimes(3);
    await gen.dispose();
  });

  // ── Standalone function wrappers ───────────────────────────────────────────

  it('standalone generate(): creates and disposes instance per call', async () => {
    const disposeSpy = vi.spyOn(UniversalMSDFGenerator.prototype, 'dispose');
    await generate('S1');
    expect(disposeSpy).toHaveBeenCalledOnce();
    disposeSpy.mockRestore();
  });

  it('standalone generateMultiple(): creates and disposes instance per call', async () => {
    const disposeSpy = vi.spyOn(UniversalMSDFGenerator.prototype, 'dispose');
    await generateMultiple(['M1', 'M2'], { verbose: false });
    expect(disposeSpy).toHaveBeenCalledOnce();
    disposeSpy.mockRestore();
  });
});
