import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { parseArgs, run } from '../src/cli.js';
import { disposeSharedConverter } from '../src/converter.js';
import { generate, generateMultiple } from '../src/index.js';

// ── Mock generate / generateMultiple ──────────────────────────────────────

vi.mock('../src/index.js', () => ({
  generate: vi.fn(),
  generateMultiple: vi.fn(),
}));

vi.mock('../src/converter.js', () => ({
  disposeSharedConverter: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSuccess(fontName = 'TestFont', savedFiles = ['/out/test.png', '/out/test.json']) {
  return {
    success: true as const,
    cached: false as const,
    fontName,
    savedFiles,
    data: { pages: [], chars: [], kernings: [], info: {}, common: {}, distanceField: {} } as never,
    atlases: [],
    metadata: {} as never,
  };
}

function makeFailure(fontName = 'TestFont', error = 'generation failed') {
  return { success: false as const, fontName, error };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CLI', () => {
  let exitSpy: MockInstance;
  let errorSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => null as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.mocked(generate).mockResolvedValue(makeSuccess());
    vi.mocked(generateMultiple).mockResolvedValue([makeSuccess()]);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── parseArgs ──────────────────────────────────────────────────────────

  describe('parseArgs: comprehensive option parsing', () => {
    it('handles all standard flags', () => {
      const { options } = parseArgs([
        'R',
        '--out',
        './o',
        '--charset',
        'ascii',
        '--size',
        '32',
        '--range',
        '2',
        '--format',
        'fnt',
        '--weight',
        '700',
        '--style',
        'italic',
        '--name',
        'MyFont',
        '--edge-coloring',
        'inktrap',
        '--padding',
        '5',
        '--fix-overlaps',
        '--timeout',
        '5000',
        '--concurrency',
        '4',
        '--verbose',
        '--force',
      ]);
      expect(options.outputDir).toBe('./o');
      expect(options.charset).toBe('ascii');
      expect(options.fontSize).toBe(32);
      expect(options.fieldRange).toBe(2);
      expect(options.outputFormat).toBe('fnt');
      expect(options.weight).toBe('700');
      expect(options.style).toBe('italic');
      expect(options.name).toBe('MyFont');
      expect(options.edgeColoring).toBe('inktrap');
      expect(options.padding).toBe(5);
      expect(options.fixOverlaps).toBe(true);
      expect(options.generationTimeout).toBe(5000);
      expect(options.concurrency).toBe(4);
      expect(options.verbose).toBe(true);
      expect(options.force).toBe(true);
    });

    it('handles aliases and short flags', () => {
      const { options } = parseArgs([
        'R',
        '-o',
        './o',
        '-c',
        'ascii',
        '-s',
        '12',
        '-r',
        '1',
        '-w',
        '100',
        '-n',
        'F',
        '-v',
        '-f',
      ]);
      expect(options.outputDir).toBe('./o');
      expect(options.charset).toBe('ascii');
      expect(options.fontSize).toBe(12);
      expect(options.fieldRange).toBe(1);
      expect(options.weight).toBe('100');
      expect(options.name).toBe('F');
      expect(options.verbose).toBe(true);
      expect(options.force).toBe(true);
    });

    it('handles negative flags and quiet mode', () => {
      const { options } = parseArgs(['R', '--no-fix-overlaps', '--quiet', '--no-reuse']);
      expect(options.fixOverlaps).toBe(false);
      expect(options.verbose).toBe(false);
      expect(options.reuseExisting).toBe(false);
    });

    it('throws for invalid padding', () => {
      expect(() => parseArgs(['R', '--padding', 'abc'])).toThrow(
        '--padding must be a non-negative number',
      );
    });

    it('throws for invalid timeout', () => {
      expect(() => parseArgs(['R', '--timeout', '0'])).toThrow(
        '--timeout must be a positive number',
      );
    });

    it('throws for invalid concurrency', () => {
      expect(() => parseArgs(['R', '--concurrency', '-1'])).toThrow(
        '--concurrency must be a positive number',
      );
    });

    it('throws for unknown options (hits handler catch block)', () => {
      // In the loop, unknown options trigger an error in the handler lookup or inside run
      // Actually parser throws if not in FLAG_HANDLERS
      expect(() => parseArgs(['R', '--unknown'])).toThrow('Unknown option: --unknown');
    });
  });

  // ── run: execution ──────────────────────────────────────────────────

  describe('run: execution paths', () => {
    it('shows help and exits 0 when no args', async () => {
      process.argv = ['node', 'cli.js'];
      await run();
      expect(logSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('handles unhandledRejection listener directly', async () => {
      const listener = process
        .listeners('unhandledRejection')
        .find((l) => l.toString().includes('gracefulShutdown'));
      if (listener) {
        await (listener as (...args: unknown[]) => Promise<void>)(
          new Error('rejection-fail'),
          Promise.resolve(),
        );
        await (listener as (...args: unknown[]) => Promise<void>)('Str', Promise.resolve());
      }
      expect(exitSpy).toHaveBeenCalled();
    });

    it('handles unexpected thrown error in run', async () => {
      vi.mocked(generate).mockRejectedValueOnce(new Error('crash'));
      process.argv = ['node', 'cli.js', 'Roboto'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('crash'));
    });

    it('throws error when no source is provided', async () => {
      process.argv = ['node', 'cli.js', '--size', '32'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No font source provided'));
    });

    it('executes single font generation successfully', async () => {
      process.argv = ['node', 'cli.js', 'Roboto'];
      await run();
      expect(generate).toHaveBeenCalledWith('Roboto', expect.any(Object));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MSDF generation successful'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('handles single font generation failure', async () => {
      vi.mocked(generate).mockResolvedValueOnce(makeFailure('Roboto', 'failed-msg'));
      process.argv = ['node', 'cli.js', 'Roboto'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed-msg'));
    });

    it('executes batch font generation successfully', async () => {
      vi.mocked(generateMultiple).mockResolvedValueOnce([
        makeSuccess('Roboto'),
        makeSuccess('Open Sans'),
      ]);
      process.argv = ['node', 'cli.js', 'Roboto', 'Open Sans'];
      await run();
      expect(generateMultiple).toHaveBeenCalledWith(['Roboto', 'Open Sans'], expect.any(Object));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Roboto'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Open Sans'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('handles mixed results in batch mode', async () => {
      vi.mocked(generateMultiple).mockResolvedValueOnce([
        makeSuccess('Roboto'),
        makeFailure('Open Sans', 'batch-fail'),
      ]);
      process.argv = ['node', 'cli.js', 'Roboto', 'Open Sans'];
      await run();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('batch-fail'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('respects quiet mode', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--quiet'];
      await run();
      // "Initializing..." log should be suppressed
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Initializing'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('throws error for invalid --range', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--range', 'invalid'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Field range must be a number'),
      );
    });

    it('throws error for invalid --format', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--format', 'invalid'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--format must be one of'));
    });

    it('throws error for invalid --edge-coloring', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--edge-coloring', 'invalid'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--edge-coloring must be one of'),
      );
    });

    it('handles unexpected non-Error thrown in run', async () => {
      vi.mocked(generate).mockRejectedValueOnce('string-crash');
      process.argv = ['node', 'cli.js', 'Roboto'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('string-crash'));
    });

    it('throws error for invalid --size', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--size', 'NotANumber'];
      await run();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Font size must be a number'));
    });

    it('handles shorthand aliases', async () => {
      process.argv = [
        'node',
        'cli.js',
        'Roboto',
        '-o',
        './out',
        '-c',
        'latin',
        '-s',
        '42',
        '-r',
        '10',
        '-w',
        '700',
        '-n',
        'MyFont',
        '-v',
        '-q',
        '--reuse',
        '-f',
      ];
      await run();
      expect(generate).toHaveBeenCalledWith(
        'Roboto',
        expect.objectContaining({
          outputDir: './out',
          charset: 'latin',
          fontSize: 42,
          fieldRange: 10,
          weight: '700',
          name: 'MyFont',
          verbose: false, // overridden by later -q
          force: true, // overrides the earlier --reuse
        }),
      );
    });

    it('--save-font sets saveFontFile: true', async () => {
      process.argv = ['node', 'cli.js', 'Roboto', '--save-font'];
      await run();
      expect(generate).toHaveBeenCalledWith(
        'Roboto',
        expect.objectContaining({ saveFontFile: true }),
      );
    });

    it('reports savedFontFile path in console output', async () => {
      vi.mocked(generate).mockResolvedValueOnce({
        success: true,
        fontName: 'Roboto',
        savedFiles: ['/out/Roboto.json'],
        savedFontFile: '/out/Roboto.ttf',
      } as never);
      process.argv = ['node', 'cli.js', 'Roboto', '--save-font'];
      await run();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('/out/Roboto.ttf'));
    });
  });

  describe('Signals', () => {
    it('handles SIGINT', async () => {
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 10));
      expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('handles SIGTERM', async () => {
      process.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 10));
      expect(exitSpy).toHaveBeenCalledWith(143);
    });

    it('gracefulShutdown: exits immediately on second signal', async () => {
      vi.mocked(disposeSharedConverter).mockImplementationOnce(async () => {
        // Slow down to ensure second signal hits during shutdown
        await new Promise((r) => setTimeout(r, 100));
      });
      process.emit('SIGINT');
      process.emit('SIGINT');
      expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('gracefulShutdown: ignores errors during cleanup', async () => {
      vi.mocked(disposeSharedConverter).mockRejectedValueOnce(new Error('fail-cleanup'));
      process.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 10)); // wait for async shutdown
      expect(exitSpy).toHaveBeenCalledWith(143);
    });
  });
});
