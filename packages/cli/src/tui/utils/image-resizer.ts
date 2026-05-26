/**
 * Image resizing for pasted attachments.
 *
 * Simplified port of ~/Desktop/claude-code-main/src/utils/imageResizer.ts.
 * The reference is 880+ lines with analytics and Anthropic-specific branching;
 * this trims to the shape the ask-user modal actually needs: take a base64
 * (or Buffer) input, down-scale if oversized, re-encode as base64, and return
 * the MIME type + dimensions.
 *
 * `sharp` is a runtime dependency. If it fails to load (platform mismatch),
 * images are returned as-is with unknown dimensions — downstream code can
 * still attach the base64.
 */

import { Buffer } from 'node:buffer';

//#region Types

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ResizedImage {
  readonly base64: string;
  readonly mediaType: string;
  readonly dimensions: ImageDimensions | null;
}

export interface ResizeOptions {
  /** Max pixel dimension (width or height). Default 1600. */
  maxDimension?: number;
  /** Max output size in bytes (base64-decoded). Default 1.5 MB. */
  maxBytes?: number;
  /**
   * Reject inputs whose `width * height` exceeds this product (pixel-count
   * cap). Default 1.5e8 ≈ ~12000 × 12000, well above any reasonable
   * screenshot. The cap is the first defence against decompression bombs:
   * we read the metadata header before allocating decode buffers.
   */
  maxPixels?: number;
}

//#endregion

//#region Sharp loader (lazy, tolerant)

// We use `typeof sharp` so any feature on the sharp namespace is available
// without juggling narrow interfaces; the actual runtime shape is the same
// object that `import('sharp')` yields.
type SharpNamespace = typeof import('sharp');

let sharpCache: SharpNamespace | null | undefined;

async function loadSharp(): Promise<SharpNamespace | null> {
  if (sharpCache !== undefined) {
    return sharpCache;
  }
  try {
    // sharp ships `export = sharp`, so the dynamic-import result *is* the
    // namespace and is also callable at runtime. No cast needed.
    const mod = await import('sharp');
    sharpCache = mod.default ?? mod;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

//#endregion

//#region Public API

function detectMediaType(buffer: Buffer): string {
  // Magic-number sniffing for common image formats.
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

export async function resizeImageBuffer(
  buffer: Buffer,
  opts: ResizeOptions = {},
): Promise<ResizedImage> {
  const mediaType = detectMediaType(buffer);
  const sharp = await loadSharp();
  if (sharp === null) {
    return {
      base64: buffer.toString('base64'),
      mediaType,
      dimensions: null,
    };
  }
  const maxDim = opts.maxDimension ?? 1600;
  const maxBytes = opts.maxBytes ?? 1.5e6;
  const maxPixels = opts.maxPixels ?? 1.5e8;

  // `failOn: 'truncated'` lets sharp tolerate recoverable warnings (e.g.
  // colour-profile quirks) but still surfaces genuine truncated/corrupt
  // images instead of swallowing them under `'none'`.
  const image = sharp(buffer, {
    failOn: 'truncated',
  });
  const metadata = await image.metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;

  // Pixel-count cap: refuse to decode obviously oversized inputs (e.g.
  // decompression bombs). Return the original bytes so the caller still gets
  // *something*; emit a stderr line so dev catches it.
  if (originalWidth * originalHeight > maxPixels) {
    try {
      process.stderr.write(
        `[image-resizer] input rejected: ${originalWidth}x${originalHeight} exceeds ${maxPixels} pixel cap\n`,
      );
    } catch {
      // ignore
    }
    return {
      base64: buffer.toString('base64'),
      mediaType,
      dimensions: null,
    };
  }

  let pipeline = image.resize({
    width: originalWidth > maxDim ? maxDim : undefined,
    height: originalHeight > maxDim ? maxDim : undefined,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (mediaType === 'image/png') {
    pipeline = pipeline.png({
      compressionLevel: 9,
    });
  } else {
    pipeline = pipeline.jpeg({
      quality: 80,
      mozjpeg: true,
    });
  }

  let out = await pipeline.toBuffer();
  if (out.byteLength > maxBytes && mediaType !== 'image/png') {
    // Degrade quality once if still too large.
    out = await sharp(out)
      .jpeg({
        quality: 60,
        mozjpeg: true,
      })
      .toBuffer();
  }

  const resizedMeta = await sharp(out).metadata();
  return {
    base64: out.toString('base64'),
    mediaType: mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
    dimensions:
      resizedMeta.width && resizedMeta.height
        ? {
            width: resizedMeta.width,
            height: resizedMeta.height,
          }
        : null,
  };
}

export async function resizeBase64Image(
  base64: string,
  opts: ResizeOptions = {},
): Promise<ResizedImage> {
  return resizeImageBuffer(Buffer.from(base64, 'base64'), opts);
}

//#endregion
