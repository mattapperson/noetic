import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePromptAttachments } from '../src/tui/utils/prompt-attachments.js';

describe('prompt attachment resolution', () => {
  test('resolves pasted text file paths as input_file attachments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noetic-prompt-attachments-'));
    try {
      const file = path.join(dir, 'notes.txt');
      await writeFile(file, 'hello from file', 'utf-8');

      const result = await resolvePromptAttachments({
        text: `please inspect ${file}`,
        cwd: dir,
      });

      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.kind).toBe('file');
      expect(result.attachments[0]?.filename).toBe('notes.txt');
      expect(result.contentParts.some((part) => part.type === 'input_file')).toBe(true);
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      });
    }
  });

  test('resolves pasted image paths as input_image attachments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noetic-prompt-images-'));
    try {
      const file = path.join(dir, 'shot.png');
      await writeFile(
        file,
        Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
        ]),
      );

      const result = await resolvePromptAttachments({
        text: `"${file}"`,
        cwd: dir,
      });

      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.kind).toBe('image');
      expect(result.contentParts.some((part) => part.type === 'input_image')).toBe(true);
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
      });
    }
  });

  test('leaves missing path-like text as text and reports no attachment', async () => {
    const result = await resolvePromptAttachments({
      text: '/definitely/missing/noetic-file.txt',
      cwd: tmpdir(),
    });

    expect(result.errors).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.contentParts).toEqual([
      {
        type: 'input_text',
        text: '/definitely/missing/noetic-file.txt',
      },
    ]);
  });
});
