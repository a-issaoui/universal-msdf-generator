import { beforeEach, describe, expect, it, vi } from 'vitest';
import UniversalMSDFGenerator, { generate, generateMultiple } from '../src/index.js';
import MSDFUtils from '../src/utils.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  statSync: vi.fn(),
}));

vi.mock('../src/utils.js', () => ({
  resolveCharset: (c: string) => c,
  default: {
    getCharsets: vi.fn().mockReturnValue({
      ascii: 'ABC',
      alphanumeric: 'ABC',
      dynamic: (chars: string) => chars.toUpperCase(),
    }),
    createProgressCallback: vi.fn().mockReturnValue(() => {}),
    calculateOptimalTextureSize: vi.fn().mockReturnValue([512, 512]),
    saveMSDFOutput: vi.fn().mockResolvedValue(['./output/Roboto.json', './output/Roboto.png']),
    checkMSDFOutputExists: vi.fn().mockResolvedValue(false),
    getExpectedFiles: vi
      .fn()
      .mockReturnValue(['./output/Roboto.json', './output/Roboto-meta.json']),
  },
}));

describe('UniversalMSDFGenerator', () => {
  let generator: any;

  beforeEach(() => {
    generator = new UniversalMSDFGenerator({ verbose: false });
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize sub-components', async () => {
      await generator.ensureInitialized();
      expect(generator.fetcher).toBeDefined();
      expect(generator.converter).toBeDefined();
    });

    it('should use default options if none provided', () => {
      const genDefault = new UniversalMSDFGenerator();
      expect((genDefault as any).defaultOptions.verbose).not.toBe(false); // defaults to undefined in storage but true in merge
    });
  });

  describe('generate', () => {
    it('should coordinate fetching, converting, and saving', async () => {
      await generator.ensureInitialized();
      const mockFontData = { buffer: Buffer.from('f'), name: 'Test', source: 'buffer' };
      const mockResult = { success: true, fontName: 'Test', data: {}, metadata: {} };

      vi.spyOn(generator.fetcher, 'fetch').mockResolvedValue(mockFontData as any);
      vi.spyOn(generator.converter, 'convert').mockResolvedValue(mockResult as any);

      const result = await generator.generate('TestFont', { outputDir: './out' });

      expect(result.success).toBe(true);
      expect(MSDFUtils.saveMSDFOutput).toHaveBeenCalled();
    });

    it('should pass weight and style to resolver', async () => {
      await generator.ensureInitialized();
      vi.spyOn(generator.fetcher, 'fetch').mockResolvedValue({
        buffer: Buffer.from('f'),
        name: 'T',
      } as any);
      vi.spyOn(generator.converter, 'convert').mockResolvedValue({ success: true } as any);

      const result = await generator.generate('Font', { weight: '700', style: 'italic' });
      expect(result.success).toBe(true);
    });

    it('should log detailed progress in verbose mode', async () => {
      await generator.ensureInitialized();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockFontData = { buffer: Buffer.from('f'), name: 'Test', source: 'buffer' };
      vi.spyOn(generator.fetcher, 'fetch').mockResolvedValue(mockFontData as any);
      vi.spyOn(generator.converter, 'convert').mockResolvedValue({ success: true } as any);

      await generator.generate('Font', { verbose: true, outputDir: './out' });

      expect(spy).toHaveBeenCalled(); // Fetching log
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Saving outputs to'));

      spy.mockRestore();
    });

    it('should handle failures gracefully', async () => {
      await generator.ensureInitialized();
      vi.spyOn(generator.fetcher, 'fetch').mockRejectedValue(new Error('Fetch failed'));
      const result = await generator.generate('FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('MSDF generation failed: Fetch failed');
      }
    });

    it('should not double-prefix error messages', async () => {
      await generator.ensureInitialized();
      vi.spyOn(generator.fetcher, 'fetch').mockRejectedValue(
        new Error('MSDF generation failed: Already prefixed'),
      );
      const result = await generator.generate('FailFont');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('MSDF generation failed: Already prefixed');
      }
    });

    it('should handle non-Error catch in generate', async () => {
      await generator.ensureInitialized();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(generator.fetcher, 'fetch').mockRejectedValue('raw-string-fail');
      const result = await generator.generate('FailFont', { verbose: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('MSDF generation failed: raw-string-fail');
      }
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('Utility wrappers', () => {
    it('should wrap generateFromGoogle', async () => {
      const spy = vi.spyOn(generator, 'generate').mockResolvedValue({ success: true } as any);
      await generator.generateFromGoogle('Roboto');
      expect(spy).toHaveBeenCalledWith('Roboto', expect.any(Object));
    });

    it('should wrap generateFromUrl', async () => {
      const spy = vi.spyOn(generator, 'generate').mockResolvedValue({ success: true } as any);
      await generator.generateFromUrl('http://test.com/font.ttf');
      expect(spy).toHaveBeenCalledWith('http://test.com/font.ttf', expect.any(Object));
    });

    it('should wrap generateFromFile', async () => {
      const spy = vi.spyOn(generator, 'generate').mockResolvedValue({ success: true } as any);
      await generator.generateFromFile('./font.ttf');
      expect(spy).toHaveBeenCalledWith('./font.ttf', expect.any(Object));
    });
  });

  describe('generateMultiple', () => {
    it('should process multiple fonts sequentially', async () => {
      await generator.ensureInitialized();
      const mockFontData = { buffer: Buffer.from('f'), name: 'Test', source: 'buffer' };
      const mockResult = { success: true, fontName: 'Test', data: {}, metadata: {} };

      vi.spyOn(generator.fetcher, 'fetch').mockResolvedValue(mockFontData as any);
      vi.spyOn(generator.converter, 'convert').mockResolvedValue(mockResult as any);

      const results = await generator.generateMultiple(['Font1'], { outputDir: './out' });
      expect(results).toHaveLength(1);
    });

    it('should log errors in verbose mode for batch processing', async () => {
      await generator.ensureInitialized();
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(generator.fetcher, 'fetch').mockRejectedValue(new Error('Batch fail'));

      const generatorVerbose = new UniversalMSDFGenerator({ verbose: true });
      await generatorVerbose.generateMultiple(['Font1']);

      expect(spyError).toHaveBeenCalled();
      expect(spyLog).toHaveBeenCalledWith(expect.stringContaining('Batch processing'));

      spyError.mockRestore();
      spyLog.mockRestore();
    });

    it('should handle non-Error failures quietly in batch mode when verbose is false', async () => {
      await generator.ensureInitialized();
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(generator.fetcher, 'fetch').mockRejectedValue('raw-fail');

      const generatorSilent = new UniversalMSDFGenerator({ verbose: false });
      await generatorSilent.generateMultiple(['Font1']);

      expect(spyError).not.toHaveBeenCalled();
      spyError.mockRestore();
    });

    it('should handle non-Error failures with verbose logging in batch mode', async () => {
      await generator.ensureInitialized();
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const generatorVerbose = new UniversalMSDFGenerator({ verbose: true });

      // Inject an error by mocking the internal generate call to REJECT
      vi.spyOn(generatorVerbose, 'generate').mockRejectedValue('verbose-raw-fail');

      await generatorVerbose.generateMultiple(['Font1']);

      expect(spyError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to process font 1: verbose-raw-fail'),
      );

      spyError.mockRestore();
    });

    it('should use "buffer" as label for non-string sources in verbose mode', async () => {
      await generator.ensureInitialized();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(generator.fetcher, 'fetch').mockResolvedValue({
        buffer: Buffer.from('f'),
        name: 'T',
      } as any);
      vi.spyOn(generator.converter, 'convert').mockResolvedValue({ success: true } as any);

      const generatorVerbose = new UniversalMSDFGenerator({ verbose: true });
      await generatorVerbose.generateMultiple([Buffer.from('f')]);

      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Processing font 1/1: buffer'));
      spy.mockRestore();
    });
  });

  describe('dispose', () => {
    it('should dispose sub-components', async () => {
      await generator.ensureInitialized();
      const spy = vi.spyOn(generator.converter, 'dispose').mockResolvedValue(undefined);
      await generator.dispose();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Functional Exports', () => {
    it('should generate MSDF using the standalone generate function', async () => {
      const result = await generate('Roboto', { charset: 'ascii' });
      expect(result.success).toBe(true);
    });

    it('should generate multiple MSDFs using the standalone generateMultiple function', async () => {
      const results = await generateMultiple(['Roboto', 'Open Sans'], { charset: 'ascii' });
      expect(results).toHaveLength(2);
    });
  });

  describe('Smart Re-use', () => {
    it('should skip generation if files exist and reuseExisting is true', async () => {
      vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await generator.ensureInitialized();
      const convertSpy = vi.spyOn((generator as any).converter, 'convert');

      const result = await generator.generate('Roboto', {
        reuseExisting: true,
        outputDir: './output',
        verbose: true,
      });

      expect(result.success).toBe(true);
      expect(convertSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Re-using existing MSDF'));
      expect(result.fontName).toBe('roboto-400-normal-48-r4');

      logSpy.mockRestore();
    });

    it('should NOT skip generation if force is true even if files exist', async () => {
      vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
      await generator.ensureInitialized();
      const convertSpy = vi
        .spyOn((generator as any).converter, 'convert')
        .mockResolvedValue({ success: true } as any);

      await generator.generate('Roboto', {
        reuseExisting: true,
        force: true,
        outputDir: './output',
      });

      expect(convertSpy).toHaveBeenCalled();
    });

    it('should NOT skip generation if checkMSDFOutputExists returns false', async () => {
      vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(false);
      await generator.ensureInitialized();
      const convertSpy = vi
        .spyOn((generator as any).converter, 'convert')
        .mockResolvedValue({ success: true } as any);

      await generator.generate('Roboto', {
        reuseExisting: true,
        outputDir: './output',
      });

      expect(convertSpy).toHaveBeenCalled();
    });

    it('should use "font" as label for non-string sources in checkCache', async () => {
      vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
      const result = await generator.generate(Buffer.from('f'), {
        reuseExisting: true,
        outputDir: './output',
      });
      expect(result.fontName).toBe('font-400-normal-48-r4');
    });

    it('should not log re-use message if verbose is false', async () => {
      vi.spyOn(MSDFUtils, 'checkMSDFOutputExists').mockResolvedValue(true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await generator.generate('Roboto', {
        reuseExisting: true,
        outputDir: './output',
        verbose: false,
      });
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });
});
