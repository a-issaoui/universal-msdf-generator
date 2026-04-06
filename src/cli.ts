#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { generate, generateMultiple } from './index.js';

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
    --charset, -c      Charset preset or custom string (default: alphanumeric)
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
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI arg parser — switch-per-flag is intentional
export function parseArgs(args: string[]): { sources: string[]; options: CliOptions } {
  const options: CliOptions = {
    outputDir: './output',
    charset: 'alphanumeric',
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
  };

  const sources: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--out':
      case '-o':
        options.outputDir = args[++i];
        break;

      case '--charset':
      case '-c':
        options.charset = args[++i];
        break;

      case '--size':
      case '-s': {
        const val = parseInt(args[++i], 10);
        if (Number.isNaN(val)) {
          console.error(`💥 Error: Font size must be a number (got "${args[i]}")`);
          process.exit(1);
        }
        options.fontSize = val;
        break;
      }

      case '--range':
      case '-r': {
        const val = parseInt(args[++i], 10);
        if (Number.isNaN(val)) {
          console.error(`💥 Error: Field range must be a number (got "${args[i]}")`);
          process.exit(1);
        }
        options.fieldRange = val;
        break;
      }

      case '--format': {
        const val = args[++i];
        const validFormats = ['json', 'fnt', 'both', 'all'] as const;
        if (!validFormats.includes(val as (typeof validFormats)[number])) {
          console.error(
            `💥 Error: --format must be one of: ${validFormats.join(', ')} (got "${val}")`,
          );
          process.exit(1);
        }
        options.outputFormat = val as CliOptions['outputFormat'];
        break;
      }

      case '--weight':
      case '-w':
        options.weight = args[++i];
        break;

      case '--style':
        options.style = args[++i];
        break;

      case '--name':
      case '-n':
        options.name = args[++i];
        break;

      case '--edge-coloring': {
        const val = args[++i];
        const valid = ['simple', 'inktrap', 'distance'] as const;
        if (!valid.includes(val as (typeof valid)[number])) {
          console.error(
            `💥 Error: --edge-coloring must be one of: ${valid.join(', ')} (got "${val}")`,
          );
          process.exit(1);
        }
        options.edgeColoring = val as CliOptions['edgeColoring'];
        break;
      }

      case '--padding': {
        const val = parseInt(args[++i], 10);
        if (Number.isNaN(val) || val < 0) {
          console.error(`💥 Error: --padding must be a non-negative number (got "${args[i]}")`);
          process.exit(1);
        }
        options.padding = val;
        break;
      }

      case '--fix-overlaps':
        options.fixOverlaps = true;
        break;

      case '--no-fix-overlaps':
        options.fixOverlaps = false;
        break;

      case '--timeout': {
        const val = parseInt(args[++i], 10);
        if (Number.isNaN(val) || val < 1) {
          console.error(`💥 Error: --timeout must be a positive number (got "${args[i]}")`);
          process.exit(1);
        }
        options.generationTimeout = val;
        break;
      }

      case '--concurrency': {
        const val = parseInt(args[++i], 10);
        if (Number.isNaN(val) || val < 1) {
          console.error(`💥 Error: --concurrency must be a positive number (got "${args[i]}")`);
          process.exit(1);
        }
        options.concurrency = val;
        break;
      }

      case '--verbose':
      case '-v':
        options.verbose = true;
        break;

      case '--quiet':
      case '-q':
        options.verbose = false;
        break;

      case '--force':
      case '-f':
        options.force = true;
        options.reuseExisting = false;
        break;

      case '--reuse':
        options.reuseExisting = true;
        options.force = false;
        break;

      case '--no-reuse':
        options.reuseExisting = false;
        break;

      default:
        if (arg.startsWith('-')) {
          console.error(`💥 Unknown option: ${arg}. Run with --help to see available options.`);
          process.exit(1);
        }
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
    process.exit(0);
  }

  const { sources, options } = parseArgs(args);

  if (sources.length === 0) {
    console.error('💥 Error: No font source provided. Run with --help to see usage.');
    process.exit(1);
  }

  try {
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
      } else {
        console.error(`\n💥 MSDF generation failed: ${result.error}`);
        process.exit(1);
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
      if (failed > 0) process.exit(1);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}

/* v8 ignore next 3 — entry-point guard, not reachable when imported for testing */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
