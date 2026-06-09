/**
 * PreviewBox — renders markdown or HTML preview for a focused option.
 *
 * Ported from ~/Desktop/claude-code-main/src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx.
 * HTML fragments are validated + converted via `renderHtmlPreview`; markdown
 * goes through `applyMarkdown` with syntax highlighting. Long content is
 * truncated with a "… (scrolled)" indicator.
 */

import { Box, Text } from 'ink';
import { useMemo } from 'react';
import stripAnsi from 'strip-ansi';
import { createCliHighlight } from '../../utils/cli-highlight.js';
import {
  HtmlPreviewRejectedError,
  looksLikeHtml,
  renderHtmlPreview,
} from '../../utils/html-preview.js';
import { applyMarkdown } from '../../utils/markdown.js';
import { useTheme } from '../theme.js';

//#region Props

export interface PreviewBoxProps {
  readonly content: string;
  readonly maxLines: number;
  readonly width?: number;
}

//#endregion

//#region Component

const highlight = createCliHighlight();

function renderPreview(content: string): {
  body: string;
  error: string | null;
} {
  if (looksLikeHtml(content)) {
    try {
      return {
        body: renderHtmlPreview(content),
        error: null,
      };
    } catch (err) {
      if (err instanceof HtmlPreviewRejectedError) {
        return {
          body: '',
          error: err.message,
        };
      }
      return {
        body: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  try {
    // Strip ANSI from the raw input first so a hostile preview cannot smuggle
    // escape bytes through the markdown text-token path. `applyMarkdown`
    // will re-introduce the chalk styling we actually want.
    return {
      body: applyMarkdown(stripAnsi(content), highlight),
      error: null,
    };
  } catch (err) {
    return {
      body: stripAnsi(content),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truncateLines(
  text: string,
  maxLines: number,
): {
  body: string;
  truncated: boolean;
} {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return {
      body: text,
      truncated: false,
    };
  }
  return {
    body: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

export function PreviewBox({ content, maxLines, width }: PreviewBoxProps) {
  const theme = useTheme();
  const { body, error, truncated } = useMemo(() => {
    const rendered = renderPreview(content);
    if (rendered.error !== null) {
      return {
        body: rendered.body,
        error: rendered.error,
        truncated: false,
      };
    }
    const { body: truncatedBody, truncated: didTruncate } = truncateLines(rendered.body, maxLines);
    return {
      body: truncatedBody,
      error: null,
      truncated: didTruncate,
    };
  }, [
    content,
    maxLines,
  ]);

  if (error) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.error}
        paddingX={1}
        width={width}
      >
        <Text color={theme.error}>Preview unavailable: {error}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      width={width}
    >
      <Text>{body}</Text>
      {truncated ? <Text color={theme.muted}>… (scrolled)</Text> : null}
    </Box>
  );
}

//#endregion
