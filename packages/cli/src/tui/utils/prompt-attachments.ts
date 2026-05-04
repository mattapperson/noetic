import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { InputFilePart, InputImagePart, InputTextPart } from '@noetic/core';

//#region Types

export type PromptAttachment =
  | {
      readonly kind: 'image';
      readonly path: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly imageUrl: string;
    }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly filename: string;
      readonly mediaType: string;
      readonly fileData: string;
    };

export type PromptAttachmentContentPart = InputTextPart | InputImagePart | InputFilePart;

export interface ResolvePromptAttachmentsOptions {
  readonly text: string;
  readonly cwd: string;
}

export interface ResolvePromptAttachmentsResult {
  readonly text: string;
  readonly attachments: ReadonlyArray<PromptAttachment>;
  readonly contentParts: ReadonlyArray<PromptAttachmentContentPart>;
  readonly errors: ReadonlyArray<string>;
}

interface Token {
  readonly raw: string;
  readonly value: string;
}

//#endregion

//#region Constants

const IMAGE_MIME_TYPES: Record<string, string | undefined> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const TEXT_MIME_TYPES: Record<string, string | undefined> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsx': 'text/javascript',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

//#endregion

//#region Tokenization

function parseTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let raw = '';
  let value = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) {
      raw += char;
      value += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      raw += char;
      escaping = true;
      continue;
    }
    if (quote !== null) {
      raw += char;
      if (char === quote) {
        quote = null;
        continue;
      }
      value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      raw += char;
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (raw.length > 0) {
        tokens.push({
          raw,
          value,
        });
        raw = '';
        value = '';
      }
      continue;
    }
    raw += char;
    value += char;
  }

  if (raw.length === 0) {
    return tokens;
  }
  tokens.push({
    raw,
    value,
  });
  return tokens;
}

//#endregion

//#region File Helpers

function resolveCandidatePath(value: string, cwd: string): string {
  if (value.startsWith('~/')) {
    const home = process.env.HOME;
    if (home) {
      return path.join(home, value.slice(2));
    }
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(cwd, value);
}

function mediaTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_TYPES[ext] ?? TEXT_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function isImageFile(filePath: string): boolean {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] !== undefined;
}

async function tryResolveFile(value: string, cwd: string): Promise<string | null> {
  const candidate = resolveCandidatePath(value, cwd);
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

async function buildAttachment(filePath: string): Promise<PromptAttachment> {
  const bytes = await readFile(filePath);
  const filename = path.basename(filePath);
  const mediaType = mediaTypeForFile(filePath);
  const base64 = Buffer.from(bytes).toString('base64');
  if (isImageFile(filePath)) {
    return {
      kind: 'image',
      path: filePath,
      filename,
      mediaType,
      imageUrl: `data:${mediaType};base64,${base64}`,
    };
  }
  return {
    kind: 'file',
    path: filePath,
    filename,
    mediaType,
    fileData: `data:${mediaType};base64,${base64}`,
  };
}

function attachmentToPart(attachment: PromptAttachment): InputImagePart | InputFilePart {
  if (attachment.kind === 'image') {
    return {
      type: 'input_image',
      imageUrl: attachment.imageUrl,
      detail: 'auto',
    };
  }
  return {
    type: 'input_file',
    filename: attachment.filename,
    fileData: attachment.fileData,
  };
}

//#endregion

//#region Public API

export async function resolvePromptAttachments(
  options: ResolvePromptAttachmentsOptions,
): Promise<ResolvePromptAttachmentsResult> {
  const attachments: PromptAttachment[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const token of parseTokens(options.text)) {
    const filePath = await tryResolveFile(token.value, options.cwd);
    if (filePath === null || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    try {
      attachments.push(await buildAttachment(filePath));
    } catch (error) {
      errors.push(
        `Failed to attach ${token.value}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    text: options.text,
    attachments,
    contentParts: [
      {
        type: 'input_text',
        text: options.text,
      },
      ...attachments.map(attachmentToPart),
    ],
    errors,
  };
}

//#endregion
