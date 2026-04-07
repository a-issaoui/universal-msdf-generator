declare module 'wawoff2' {
  /**
   * Decompresses a WOFF2 buffer into a TTF Uint8Array.
   * @param buffer The WOFF2 font data.
   * @returns A promise that resolves to the decompressed TTF font data.
   */
  export function decompress(buffer: Uint8Array | Buffer): Promise<Uint8Array>;

  /**
   * Compresses a TTF/OTF buffer into a WOFF2 Uint8Array.
   * @param buffer The font data.
   * @returns A promise that resolves to the compressed WOFF2 font data.
   */
  export function compress(buffer: Uint8Array | Buffer): Promise<Uint8Array>;
}
