#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { disposeSharedConverter } from './converter.js';
import { generate, generateMultiple } from './index.js';

let isShuttingDown = false;

/**
 * Performs graceful shutdown with proper cleanup.
 */
async function gracefulShutdown(code: number, error?: Error): Promise<never> {
  if (isShuttingDown) process.exit(code);
  isShuttingDown = true;

  if (error) console.error(`\n💥 Error: ${error.message}`);

  // Dispose shared WASM instance
  try {
    await disposeSharedConverter();
  } catch {
    // Ignore cleanup errors
  }

  process.exit(code);
  // Never reached
  return null as never;
}

// Signal handlers
process.on('SIGINT', () => gracefulShutdown(130));
process.on('SIGTERM', () => gracefulShutdown(143));
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  gracefulShutdown(1, err);
});

function showHelp() {
  console.log(`
  🎯 Universal MSDF Generator CLI

  Usage:
    $ universal-msdf <source> [options]
    $ universal-msdf <source1> <source2> ... [options]   (batch)

  Sources:
    - Google Font name (e.g. "Roboto")
    - URL to font file  (e.g. "https://example.com/font.ttf")
    - Local file path   (e.g. "./fonts/myfont.otf")

  Options:
    --out, -o          Output directory (default: ./output)
    --charset, -c      Charset preset or custom string (default: latin)
                       Presets: ascii, alphanumeric, latin, cyrillic
    --size, -s         Font size (default: 48)
    --range, -r        Distance field range in px (default: 4)
    --format           Output format: json | fnt | both | all (default: json)
    --weight, -w       Font weight, e.g. 400, 700, bold (default: 400)
    --style            Font style, e.g. normal, italic (default: normal)
    --name, -n         Override output filename stem
    --edge-coloring    Edge coloring algorithm: simple | inktrap | distance (default: simple)
    --padding          Glyph padding in atlas in px (default: 2)
    --fix-overlaps     Pre-process glyph paths to fix overlapping contours (default: true)
    --no-fix-overlaps  Disable overlap fixing
    --timeout          Max ms to wait for generation before failing (default: 60000)
    --concurrency      Max parallel fonts in batch mode (default: unlimited)
    --reuse            Skip if output already exists (default: true)
    --no-reuse         Always re-generate, do not skip existing files
    --force, -f        Force re-generation even if output exists (overrides --reuse)
    --save-font        Save the downloaded font binary (.ttf) to the output directory
    --verbose, -v      Enable verbose logging (default: true)
    --quiet, -q        Suppress all non-error output

  Examples:
    $ universal-msdf Roboto -c ascii -o ./assets
    $ universal-msdf https://example.com/font.ttf --size 64
    $ universal-msdf ./my-font.otf --force
    $ universal-msdf "Open Sans" -c latin --format both --weight 400
    $ universal-msdf Roboto "Open Sans" Lato --concurrency 2
    $ universal-msdf Roboto --edge-coloring inktrap --padding 4
  `);
}

interface CliOptions {
  outputDir: string;
  charset: string;
  fontSize: number;
  fieldRange: number;
  outputFormat: 'json' | 'fnt' | 'both' | 'all';
  weight: string;
  style: string;
  name: string | undefined;
  edgeColoring: 'simple' | 'inktrap' | 'distance';
  padding: number;
  fixOverlaps: boolean;
  generationTimeout: number | undefined;
  concurrency: number | undefined;
  reuseExisting: boolean;
  force: boolean;
  verbose: boolean;
  saveFontFile: boolean;
}

type OptionHandler = (args: string[], index: number, options: CliOptions) => number;

const FLAG_HANDLERS: Record<string, OptionHandler> = {
  '--out': (args, i, opts) => {
    opts.outputDir = args[i + 1];
    return i + 1;
  },
  '-o': (args, i, opts) => FLAG_HANDLERS['--out'](args, i, opts),
  '--charset': (args, i, opts) => {
    opts.charset = args[i + 1];
    return i + 1;
  },
  '-c': (args, i, opts) => {
    opts.charset = args[i + 1];
    return i + 1;
  },
  '--size': (args, i, opts) => {
    const val = parseInt(args[i + 1], 10);
    if (Number.isNaN(val)) throw new Error(`Font size must be a number (got "${args[i + 1]}")`);
    opts.fontSize = val;
    return i + 1;
  },
  '-s': (args, i, opts) => FLAG_HANDLERS['--size'](args, i, opts),
  '--range': (args, i, opts) => {
    const val = parseInt(args[i + 1], 10);
    if (Number.isNaN(val)) throw new Error(`Field range must be a number (got "${args[i + 1]}")`);
    opts.fieldRange = val;
    return i + 1;
  },
  '-r': (args, i, opts) => FLAG_HANDLERS['--range'](args, i, opts),
  '--format': (args, i, opts) => {
    const val = args[i + 1];
    const valid = ['json', 'fnt', 'both', 'all'];
    if (!valid.includes(val))
      throw new Error(`--format must be one of: ${valid.join(', ')} (got "${val}")`);
    opts.outputFormat = val as CliOptions['outputFormat'];
    return i + 1;
  },
  '--weight': (args, i, opts) => {
    opts.weight = args[i + 1];
    return i + 1;
  },
  '-w': (args, i, opts) => {
    opts.weight = args[i + 1];
    return i + 1;
  },
  '--style': (args, i, opts) => {
    opts.style = args[i + 1];
    return i + 1;
  },
  '--name': (args, i, opts) => {
    opts.name = args[i + 1];
    return i + 1;
  },
  '-n': (args, i, opts) => {
    opts.name = args[i + 1];
    return i + 1;
  },
  '--edge-coloring': (args, i, opts) => {
    const val = args[i + 1];
    const valid = ['simple', 'inktrap', 'distance'];
    if (!valid.includes(val))
      throw new Error(`--edge-coloring must be one of: ${valid.join(', ')} (got "${val}")`);
    opts.edgeColoring = val as CliOptions['edgeColoring'];
    return i + 1;
  },
  '--padding': (args, i, opts) => {
    const val = parseInt(args[i + 1], 10);
    if (Number.isNaN(val) || val < 0)
      throw new Error(`--padding must be a non-negative number (got "${args[i + 1]}")`);
    opts.padding = val;
    return i + 1;
  },
  '--fix-overlaps': (_, i, opts) => {
    opts.fixOverlaps = true;
    return i;
  },
  '--no-fix-overlaps': (_, i, opts) => {
    opts.fixOverlaps = false;
    return i;
  },
  '--timeout': (args, i, opts) => {
    const val = parseInt(args[i + 1], 10);
    if (Number.isNaN(val) || val < 1)
      throw new Error(`--timeout must be a positive number (got "${args[i + 1]}")`);
    opts.generationTimeout = val;
    return i + 1;
  },
  '--concurrency': (args, i, opts) => {
    const val = parseInt(args[i + 1], 10);
    if (Number.isNaN(val) || val < 1)
      throw new Error(`--concurrency must be a positive number (got "${args[i + 1]}")`);
    opts.concurrency = val;
    return i + 1;
  },
  '--verbose': (_, i, opts) => {
    opts.verbose = true;
    return i;
  },
  '-v': (_, i, opts) => {
    opts.verbose = true;
    return i;
  },
  '--quiet': (_, i, opts) => {
    opts.verbose = false;
    return i;
  },
  '-q': (_, i, opts) => {
    opts.verbose = false;
    return i;
  },
  '--force': (_, i, opts) => {
    opts.force = true;
    opts.reuseExisting = false;
    return i;
  },
  '-f': (_, i, opts) => {
    opts.force = true;
    opts.reuseExisting = false;
    return i;
  },
  '--reuse': (_, i, opts) => {
    opts.reuseExisting = true;
    opts.force = false;
    return i;
  },
  '--no-reuse': (_, i, opts) => {
    opts.reuseExisting = false;
    return i;
  },
  '--save-font': (_, i, opts) => {
    opts.saveFontFile = true;
    return i;
  },
};

export function parseArgs(args: string[]): { sources: string[]; options: CliOptions } {
  const options: CliOptions = {
    outputDir: './output',
    charset: 'latin',
    fontSize: 48,
    fieldRange: 4,
    outputFormat: 'json',
    weight: '400',
    style: 'normal',
    name: undefined,
    edgeColoring: 'simple',
    padding: 2,
    fixOverlaps: true,
    generationTimeout: undefined,
    concurrency: undefined,
    reuseExisting: true,
    force: false,
    verbose: true,
    saveFontFile: false,
  };

  const sources: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const handler = FLAG_HANDLERS[arg];

    if (handler) {
      i = handler(args, i, options);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
    } else {
      sources.push(arg);
    }
  }

  return { sources, options };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI run — branching on result types is intentional
export async function run() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    return await gracefulShutdown(0);
  }

  try {
    const { sources, options } = parseArgs(args);

    if (sources.length === 0) {
      throw new Error('No font source provided. Run with --help for usage.');
    }

    if (options.verbose) {
      console.log('🚀 Initializing Universal MSDF Generator...');
    }

    if (sources.length === 1) {
      const result = await generate(sources[0], options);
      if (result.success) {
        console.log('\n🛡️  MSDF generation successful!');
        if (result.savedFiles && result.savedFiles.length > 0) {
          for (const file of result.savedFiles) {
            console.log(`  - ${file}`);
          }
        }
        if ('savedFontFile' in result && result.savedFontFile) {
          console.log(`  📦 Font: ${result.savedFontFile}`);
        }
      } else {
        await gracefulShutdown(1, new Error(result.error));
      }
    } else {
      // Batch mode: multiple sources
      const results = await generateMultiple(sources, options);
      let failed = 0;
      for (const result of results) {
        if (result.success) {
          console.log(`\n✅ ${result.fontName}`);
          if (result.savedFiles && result.savedFiles.length > 0) {
            for (const file of result.savedFiles) {
              console.log(`  - ${file}`);
            }
          }
        } else {
          console.error(`\n💥 ${result.fontName}: ${result.error}`);
          failed++;
        }
      }
      if (failed > 0) return await gracefulShutdown(1, new Error(`${failed} font(s) failed`));
    }
    return await gracefulShutdown(0);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return await gracefulShutdown(1, err);
  }
}

/* v8 ignore next 3 — entry-point guard, not reachable when imported for testing */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
