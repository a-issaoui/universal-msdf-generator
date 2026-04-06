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

describe('UniversalMSDFGenerator Hardened', () => {
  let generator: UniversalMSDFGenerator;

  beforeEach(() => {
    generator = new UniversalMSDFGenerator();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await generator.dispose();
  });

  it('should cover all lifecycle paths and named init', async () => {
    const gen = new UniversalMSDFGenerator();
    // Concurrent
    const p1 = gen.ensureInitialized();
    const p2 = gen.ensureInitialized();
    await Promise.all([p1, p2]);
    // Sequential
    await gen.ensureInitialized();
    await gen.dispose();
    await gen.dispose();
  });

  it('should cover identity and naming bifurcations', async () => {
    await generator.generate('Roboto.ttf');
    await generator.generate(Buffer.alloc(0));
    await generator.generate('', { name: 'M' });
    await generator.generate('/');
    await generator.generate('T.ttf', { weight: '700', style: 'italic' });
  });

  it('should cover cache hits and misses', async () => {
    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockResolvedValueOnce(true);
    await generator.generate('F', { reuseExisting: true, outputDir: './out', verbose: true });

    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockResolvedValueOnce(false);
    await generator.generate('F', { reuseExisting: true, outputDir: './out' });

    await generator.generate('F', { reuseExisting: true, outputDir: './out', force: true });
  });

  it('should cover success path logic (XML, OutputDir)', async () => {
    await generator.generate('X', { outputFormat: 'fnt' });
    await generator.generate('X', { outputFormat: 'both' });
    await generator.generate('X', { outputFormat: 'all' });
    await generator.generate('X', { outputFormat: 'json' });

    await generator.generate('S', { outputDir: './out', verbose: true });
  });

  it('should cover error fallbacks and logging', async () => {
    const gen = new UniversalMSDFGenerator({ verbose: true });
    await gen.ensureInitialized();

    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce(new Error('FAIL'));
    const r1 = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
    });
    expect(r1.success).toBe(false);

    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce('RAWFAIL');
    const r2 = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: false,
    });
    expect(r2.success).toBe(false);

    vi.mocked(MSDFUtils.checkMSDFOutputExists).mockRejectedValueOnce(
      'MSDF generation failed: ALREADY',
    );
    const r3 = await generator.generate('E', {
      reuseExisting: true,
      outputDir: './out',
      verbose: true,
    });
    expect(r3.success).toBe(false);
  });

  it('should cover specialized methods and standalone wrappers', async () => {
    await generate('S1');
    await generateMultiple(['M1', 'M2'], { verbose: true });

    const gen = new UniversalMSDFGenerator();
    await gen.generateFromGoogle('G');
    await gen.generateFromUrl('U');
    await gen.generateFromFile('F');
  });
});
