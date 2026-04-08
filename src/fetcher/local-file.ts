/**
 * fetcher/local-file.ts
 * Local filesystem font handler with path traversal protection and size limits.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadFont } from '../font-loader.js';
import type { FontData } from '../types.js';
import { extractMessage, protectBuffer } from './network.js';

export interface LocalFileOptions {
  basePath?: string;
  maxDownloadSize: number;
  verbose: boolean;
}

export class LocalFileHandler {
  constructor(private readonly options: LocalFileOptions) {}

  async fetchLocalFile(
    filePath: string,
    fetchOpts: { name?: string; signal?: AbortSignal } = {},
  ): Promise<FontData> {
    const resolvedPath = this._resolvePath(filePath);

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(resolvedPath);
    } catch {
      throw new Error('Invalid font source or access denied.');
    }

    if (!stats.isFile()) {
      throw new Error('Invalid font source path: expected a file.');
    }

    if (stats.size > this.options.maxDownloadSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${this.options.maxDownloadSize})`);
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolvedPath);
    } catch (err) {
      /* v8 ignore start */
      if (err instanceof Error && err.name === 'AbortError') throw err;
      /* v8 ignore stop */
      throw new Error(`Failed to read local file "${filePath}": ${extractMessage(err)}`);
    }

    const loaded = await loadFont(buffer, {
      verbose: this.options.verbose,
      sourceHint: resolvedPath,
    });

    if (fetchOpts.signal?.aborted) throw fetchOpts.signal.reason ?? new Error('Fetch aborted');

    return {
      buffer: protectBuffer(loaded.buffer),
      name: fetchOpts.name ?? path.basename(resolvedPath, path.extname(resolvedPath)),
      format: loaded.format,
      path: resolvedPath,
      source: 'local',
      originalFormat: loaded.originalFormat,
      wasConverted: loaded.wasConverted,
      metadata: loaded.stats,
    };
  }

  private _resolvePath(filePath: string): string {
    const { basePath } = this.options;
    if (basePath) {
      const resolved = path.resolve(basePath, filePath);
      const rel = path.relative(basePath, resolved);
      if (rel.startsWith('..') || /* v8 ignore next */ path.isAbsolute(rel)) {
        throw new Error('Invalid font source path or directory traversal detected.');
      }
      return resolved;
    }
    return path.resolve(filePath);
  }
}
