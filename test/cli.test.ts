import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, run } from '../src/cli.js';

// ── Mock generate / generateMultiple ──────────────────────────────────────

vi.mock('../src/index.js', () => ({
  generate: vi.fn(),
  generateMultiple: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSuccess(fontName = 'TestFont', savedFiles = ['/out/test.png', '/out/test.json']) {
  return { success: true as const, cached: false as const, fontName, savedFiles };
}

function makeFailure(fontName = 'TestFont', error = 'generation failed') {
  return { success: false as const, fontName, error };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CLI', () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy types vary across Node versions
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── parseArgs ──────────────────────────────────────────────────────────

  describe('parseArgs: option parsing', () => {
    it('returns default options when only source given', () => {
      const { sources, options } = parseArgs(['Roboto']);
      expect(sources).toEqual(['Roboto']);
      expect(options.charset).toBe('alphanumeric');
      expect(options.fontSize).toBe(48);
      expect(options.fieldRange).toBe(4);
      expect(options.outputFormat).toBe('json');
      expect(options.weight).toBe('400');
      expect(options.style).toBe('normal');
      expect(options.name).toBeUndefined();
      expect(options.edgeColoring).toBe('simple');
      expect(options.padding).toBe(2);
      expect(options.concurrency).toBeUndefined();
      expect(options.reuseExisting).toBe(true);
      expect(options.force).toBe(false);
      expect(options.verbose).toBe(true);
    });

    it('-o / --out sets outputDir', () => {
      expect(parseArgs(['Roboto', '-o', './assets']).options.outputDir).toBe('./assets');
      expect(parseArgs(['Roboto', '--out', './dist']).options.outputDir).toBe('./dist');
    });

    it('-c / --charset sets charset', () => {
      expect(parseArgs(['Roboto', '-c', 'latin']).options.charset).toBe('latin');
      expect(parseArgs(['Roboto', '--charset', 'ascii']).options.charset).toBe('ascii');
    });

    it('-s sets fontSize', () => {
      const { options } = parseArgs(['Roboto', '-s', '64']);
      expect(options.fontSize).toBe(64);
    });

    it('-r sets fieldRange', () => {
      const { options } = parseArgs(['Roboto', '-r', '8']);
      expect(options.fieldRange).toBe(8);
    });

    it('--format sets outputFormat', () => {
      const { options } = parseArgs(['Roboto', '--format', 'fnt']);
      expect(options.outputFormat).toBe('fnt');
    });

    it('-w / --weight sets weight', () => {
      expect(parseArgs(['Roboto', '-w', '700']).options.weight).toBe('700');
      expect(parseArgs(['Roboto', '--weight', 'bold']).options.weight).toBe('bold');
    });

    it('--style sets style', () => {
      const { options } = parseArgs(['Roboto', '--style', 'italic']);
      expect(options.style).toBe('italic');
    });

    it('-n / --name sets name', () => {
      expect(parseArgs(['Roboto', '-n', 'my-font']).options.name).toBe('my-font');
      expect(parseArgs(['Roboto', '--name', 'other']).options.name).toBe('other');
    });

    it('--edge-coloring sets edgeColoring', () => {
      const { options } = parseArgs(['Roboto', '--edge-coloring', 'inktrap']);
      expect(options.edgeColoring).toBe('inktrap');
    });

    it('--padding sets padding', () => {
      const { options } = parseArgs(['Roboto', '--padding', '4']);
      expect(options.padding).toBe(4);
    });

    it('--concurrency sets concurrency', () => {
      const { options } = parseArgs(['Roboto', '--concurrency', '3']);
      expect(options.concurrency).toBe(3);
    });

    it('--force sets force: true and reuseExisting: false', () => {
      const { options } = parseArgs(['Roboto', '-f']);
      expect(options.force).toBe(true);
      expect(options.reuseExisting).toBe(false);
    });

    it('--no-reuse sets reuseExisting: false', () => {
      const { options } = parseArgs(['Roboto', '--no-reuse']);
      expect(options.reuseExisting).toBe(false);
    });

    it('--reuse sets reuseExisting: true and force: false', () => {
      const { options } = parseArgs(['Roboto', '-f', '--reuse']);
      expect(options.reuseExisting).toBe(true);
      expect(options.force).toBe(false);
    });

    it('-q sets verbose: false', () => {
      const { options } = parseArgs(['Roboto', '-q']);
      expect(options.verbose).toBe(false);
    });

    it('-v sets verbose: true', () => {
      const { options } = parseArgs(['Roboto', '-q', '-v']);
      expect(options.verbose).toBe(true);
    });

    it('--verbose (long form) sets verbose: true', () => {
      const { options } = parseArgs(['Roboto', '-q', '--verbose']);
      expect(options.verbose).toBe(true);
    });

    it('--quiet (long form) sets verbose: false', () => {
      const { options } = parseArgs(['Roboto', '--quiet']);
      expect(options.verbose).toBe(false);
    });

    it('--force (long form) sets force: true', () => {
      const { options } = parseArgs(['Roboto', '--force']);
      expect(options.force).toBe(true);
      expect(options.reuseExisting).toBe(false);
    });

    it('collects multiple sources', () => {
      const { sources } = parseArgs(['Roboto', 'Lato', '"Open Sans"']);
      expect(sources).toEqual(['Roboto', 'Lato', '"Open Sans"']);
    });
  });

  // ── parseArgs: validation errors ──────────────────────────────────────

  describe('parseArgs: validation errors', () => {
    it('exits 1 for non-numeric --size', () => {
      expect(() => parseArgs(['Roboto', '--size', 'big'])).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Font size must be a number'));
    });

    it('exits 1 for non-numeric --range', () => {
      expect(() => parseArgs(['Roboto', '--range', 'far'])).toThrow('process.exit(1)');
    });

    it('exits 1 for invalid --format', () => {
      expect(() => parseArgs(['Roboto', '--format', 'xml'])).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--format must be one of'));
    });

    it('exits 1 for invalid --edge-coloring', () => {
      expect(() => parseArgs(['Roboto', '--edge-coloring', 'fancy'])).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--edge-coloring must be one of'),
      );
    });

    it('exits 1 for non-numeric --padding', () => {
      expect(() => parseArgs(['Roboto', '--padding', 'x'])).toThrow('process.exit(1)');
    });

    it('exits 1 for non-positive --concurrency', () => {
      expect(() => parseArgs(['Roboto', '--concurrency', '0'])).toThrow('process.exit(1)');
    });

    it('exits 1 for unknown flag', () => {
      expect(() => parseArgs(['Roboto', '--unknown'])).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --unknown'));
    });
  });

  // ── run: help / no args ────────────────────────────────────────────────

  describe('run: help and no-args', () => {
    it('shows help and exits 0 when no args', async () => {
      process.argv = ['node', 'cli.js'];
      await expect(run()).rejects.toThrow('process.exit(0)');
      expect(logSpy).toHaveBeenCalled();
    });

    it('shows help for --help', async () => {
      process.argv = ['node', 'cli.js', '--help'];
      await expect(run()).rejects.toThrow('process.exit(0)');
    });

    it('exits 1 when flags given but no source', async () => {
      process.argv = ['node', 'cli.js', '--size', '64'];
      await expect(run()).rejects.toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No font source provided'));
    });
  });

  // ── run: single font ───────────────────────────────────────────────────

  describe('run: single font', () => {
    it('calls generate with source and logs success', async () => {
      const { generate } = await import('../src/index.js');
      (generate as ReturnType<typeof vi.fn>).mockResolvedValue(makeSuccess());
      process.argv = ['node', 'cli.js', 'Roboto', '-c', 'ascii'];
      await run();
      expect(generate).toHaveBeenCalledWith(
        'Roboto',
        expect.objectContaining({ charset: 'ascii' }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('successful'));
    });

    it('exits 1 when generate returns failure', async () => {
      const { generate } = await import('../src/index.js');
      (generate as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailure());
      process.argv = ['node', 'cli.js', 'Roboto'];
      await expect(run()).rejects.toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('generation failed'));
    });

    it('exits 1 on unexpected thrown error', async () => {
      const { generate } = await import('../src/index.js');
      (generate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('crash'));
      process.argv = ['node', 'cli.js', 'Roboto'];
      await expect(run()).rejects.toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('crash'));
    });

    it('stringifies non-Error thrown values', async () => {
      const { generate } = await import('../src/index.js');
      (generate as ReturnType<typeof vi.fn>).mockRejectedValue('raw string error');
      process.argv = ['node', 'cli.js', 'Roboto'];
      await expect(run()).rejects.toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('raw string error'));
    });
  });

  // ── run: batch mode ────────────────────────────────────────────────────

  describe('run: batch mode', () => {
    it('calls generateMultiple for multiple sources', async () => {
      const { generateMultiple } = await import('../src/index.js');
      (generateMultiple as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSuccess('Roboto'),
        makeSuccess('Lato'),
      ]);
      process.argv = ['node', 'cli.js', 'Roboto', 'Lato'];
      await run();
      expect(generateMultiple).toHaveBeenCalledWith(['Roboto', 'Lato'], expect.any(Object));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Roboto'));
    });

    it('passes --concurrency to generateMultiple', async () => {
      const { generateMultiple } = await import('../src/index.js');
      (generateMultiple as ReturnType<typeof vi.fn>).mockResolvedValue([makeSuccess('Roboto')]);
      process.argv = ['node', 'cli.js', 'Roboto', 'Lato', '--concurrency', '2'];
      await run();
      expect(generateMultiple).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ concurrency: 2 }),
      );
    });

    it('exits 1 when any font in batch fails', async () => {
      const { generateMultiple } = await import('../src/index.js');
      (generateMultiple as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSuccess('Roboto'),
        makeFailure('Lato', 'network error'),
      ]);
      process.argv = ['node', 'cli.js', 'Roboto', 'Lato'];
      await expect(run()).rejects.toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('network error'));
    });
  });
});
