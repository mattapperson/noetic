import { describe, expect, it } from 'bun:test';

import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';

import { createBashTool } from '../src/tools/bash.js';
import { createEditTool } from '../src/tools/edit.js';
import { createReadTool } from '../src/tools/read.js';
import { createWriteTool } from '../src/tools/write.js';

const fs = createLocalFsAdapter();
const shell = createLocalShellAdapter();
const cwd = '/fixture';

describe('bash tool description', () => {
  const desc = createBashTool(cwd, shell).description ?? '';

  it('names the tool hierarchy for dedicated alternatives', () => {
    expect(desc).toContain('Use Read (NOT cat/head/tail)');
    expect(desc).toContain('Use Grep (NOT grep or rg)');
    expect(desc).toContain('Use Edit (NOT sed/awk)');
    expect(desc).toContain('Use Write (NOT echo >/cat <<EOF)');
  });

  it('contains the git safety protocol', () => {
    expect(desc).toContain('Git safety protocol');
    expect(desc).toContain('NEVER skip hooks (--no-verify');
    expect(desc).toContain('NEVER force-push to main/master');
    expect(desc).toContain('CRITICAL: Always create NEW commits rather than amending');
    expect(desc).toContain('NEVER commit changes unless the user explicitly asks');
  });

  it('documents the commit flow (parallel status/diff/log → heredoc → verify)', () => {
    expect(desc).toContain('Committing (only when the user explicitly asks)');
    expect(desc).toContain('`git status` (never with -uall');
    expect(desc).toContain('HEREDOC');
  });

  it('includes parallel / sequential call guidance', () => {
    expect(desc).toContain('Independent commands that can run in parallel');
    expect(desc).toContain('Do NOT use newlines to separate commands');
  });
});

describe('read tool description', () => {
  const desc = createReadTool(cwd, fs).description ?? '';

  it('documents the cat-style line-number prefix', () => {
    expect(desc).toContain('cat-style line-number prefixes');
    expect(desc).toContain('strip the prefix and preserve the exact indentation');
  });

  it('names the sibling tools to use instead for other jobs', () => {
    expect(desc).toContain('To list a directory use Ls');
    expect(desc).toContain('to search within files use Grep');
    expect(desc).toContain('to find files by name use Find');
  });

  it('notes image detection and binary-file caveat', () => {
    expect(desc).toContain('Image files (jpg, png, gif, webp)');
    expect(desc).toContain('Binary / non-UTF-8 files');
  });
});

describe('edit tool description', () => {
  const desc = createEditTool(cwd, fs).description ?? '';

  it('has the CRITICAL read-first warning', () => {
    expect(desc).toContain('CRITICAL: You MUST use the Read tool to view the file before editing');
  });

  it('documents strip-the-line-prefix + preserve-indentation rule', () => {
    expect(desc).toContain('strip the line-number prefix');
    expect(desc).toContain('preserve the exact indentation');
  });

  it('documents uniqueness requirement and LF/CRLF preservation', () => {
    expect(desc).toContain('appears more than once');
    expect(desc).toContain('Line endings (LF / CRLF) and BOM are preserved');
  });
});

describe('write tool description', () => {
  const desc = createWriteTool(cwd, fs).description ?? '';

  it('has the CRITICAL read-first warning', () => {
    expect(desc).toContain('CRITICAL: If the file already exists you MUST use the Read tool first');
  });

  it('forbids proactive documentation creation', () => {
    expect(desc).toContain(
      'NEVER proactively create documentation files (README.md, CHANGES.md, CHANGELOG.md, etc.)',
    );
  });

  it('points to Edit for small changes and appends', () => {
    expect(desc).toContain('Small, targeted changes: use Edit');
    expect(desc).toContain('Appending content: use Edit');
  });
});
