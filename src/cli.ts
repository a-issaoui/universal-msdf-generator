#!/usr/bin/env node
import { generate } from './index.js';

function showHelp() {
  console.log(`
  🎯 Universal MSDF Generator CLI

  Usage:
    $ universal-msdf <source> [options]

  Sources:
    - Google Font name (e.g. "Roboto")
    - URL to font file  (e.g. "https://example.com/font.ttf")
    - Local file path   (e.g. "./fonts/myfont.otf")

  Options:
    --out, -o      Output directory (default: ./output)
    --charset, -c  Charset preset or custom string (default: alphanumeric)
                   Presets: ascii, alphanumeric, latin, cyrillic
    --size, -s     Font size (default: 48)
    --range, -r    Distance field range (default: 4)
    --format       Output format: json | fnt | both | all (default: json)
    --reuse        Skip if output already exists (default: true)
    --no-reuse     Always re-generate, do not skip existing files
    --force, -f    Force re-generation even if output exists (overrides --reuse)
    --verbose, -v  Enable verbose logging (default: true)
    --quiet, -q    Suppress all non-error output

  Examples:
    $ universal-msdf Roboto -c ascii -o ./assets
    $ universal-msdf https://example.com/font.ttf --size 64
    $ universal-msdf ./my-font.otf --force
    $ universal-msdf "Open Sans" -c latin --format both
  `);
}

interface CliOptions {
  outputDir: string;
  charset: string;
  fontSize: number;
  fieldRange: number;
  outputFormat: 'json' | 'fnt' | 'both' | 'all';
  reuseExisting: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    outputDir: './output',
    charset: 'alphanumeric',
    fontSize: 48,
    fieldRange: 4,
    outputFormat: 'json',
    // reuseExisting and force are separate flags with clear semantics:
    //   reuseExisting=true  → skip if files exist (default)
    //   force=true          → always regenerate, overrides reuseExisting
    reuseExisting: true,
    force: false,
    verbose: true,
  };

  for (let i = 1; i < args.length; i++) {
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
        // force=true makes the generator ignore existing files entirely.
        // We also set reuseExisting=false so checkCache returns null immediately.
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
    }
  }

  return options;
}

async function run() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const source = args[0];
  const options = parseArgs(args);

  try {
    if (options.verbose) {
      console.log('🚀 Initializing Universal MSDF Generator...');
    }

    const result = await generate(source, options);

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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}

run();
