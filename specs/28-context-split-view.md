# Context Split View

> **Depends On:** `22-cli-architecture` (CLI presentation layer)
> **Exports:** (none — feature spec)
> **Source of truth:** `packages/cli/src/tui/components/chat-layout.tsx`, `packages/cli/src/tui/components/context-panel.tsx`, `packages/cli/src/tui/layout/`
> **Docs:** `packages/web/content/docs/code-agent-cli/configuration.mdx`

---

## Purpose

The Context Split View renders the Context Status panel (memory-layer usage, token totals) alongside the chat so users can watch token consumption while a turn is in progress. A single keystroke — `Ctrl+W` — moves focus between chat and context. The panel adapts to terminal width: wide terminals get a side-by-side dock; narrow terminals stack vertically with the unfocused pane collapsed to a one-line strip.

`/context` is a toggle command — it opens and closes the dock — not a modal.

## Component graph

```
app.tsx
  └ ChatLayout                         (cli-presentation)
      ├ ResponsesChat                  (cli-presentation, owns chat + prompt + Ctrl+O/R overlays)
      └ ContextPanel                   (cli-presentation)
          └ ContextDisplay             (cli-presentation, shared with /help-style consumers)
```

`ChatLayout` is a pure renderer. State (`panelOpen`, `focusedPane`) lives in `app.tsx` because the `/context` slash command runs in the dispatch path constructed there and needs a closure over the toggle.

`ChatLayout` wraps only the `responsesChat` branch of `app.tsx`'s view selector. `TaskBoard`, `TaskChatView`, and `TaskChatSpawningView` are unaffected.

## Layout modes

```ts
type LayoutMode = 'wide' | 'narrow';
type Pane = 'chat' | 'context';

const CHAT_MIN_WIDTH = 60;
const PANEL_MIN_WIDTH = 32;

function decideLayoutMode(cols: number, panelWidth: number): LayoutMode {
  return cols >= panelWidth + CHAT_MIN_WIDTH ? 'wide' : 'narrow';
}
```

### Wide

```
┌─ chat ───────────────┬─ ► ctx ─────┐
│ [streamed output]    │ Model       │
│                      │  anthropic/…│
│                      │ Context     │
│                      │  21.8k/200k │
│                      │ ▓▓▓░░░░░    │
│                      │             │
│ > _____________      │ System  2.8k│
└──────────────────────┴─────────────┘
```

- `<Box flexDirection="row">` with `ResponsesChat` (flexGrow=1) and `ContextPanel` (width=`panelWidth`, `mode='full'`).
- `Ctrl+W` swaps focus.
- The focused pane is marked by **border style** (`round`) plus a **`►` glyph** prefixing the pane title. The unfocused pane has `borderStyle="single"` with a dimmed border color. Both signals are present so focus state remains legible without color.

### Narrow

```
┌─ chat (focused) ────────────────┐
│ [streamed output]               │
│                                 │
│ > _____________                 │
├─────────────────────────────────┤
│ ctx · 21.8k / 200k (10.9%)      │
└─────────────────────────────────┘
```

- Vertical stack. Focused pane fills available height; the other shows as a one-line strip below the prompt.
- `Ctrl+W` swaps focus, which also swaps which pane is full-height.
- When `focusedPane === 'context'` and a turn is streaming, the minimized chat strip live-previews the last 1–3 lines of the streaming delta in place of the idle-state `chat · N msgs · waiting…`. This preserves the always-visible chat invariant when the user has chosen to focus on context.

## Configuration

```ts
// packages/cli/src/types/config.ts
ui: {
  doublePressWindowMs: number;
  contextPanelWidth?: 'responsive' | number;
}
```

- `'responsive'` (default): `clamp(PANEL_MIN_WIDTH, floor(0.40 * cols), 56)`.
- `number` (28–80): fixed columns, clamped down at runtime if the terminal cannot fit `value + CHAT_MIN_WIDTH` chat columns.

Validated by Zod (`z.union([z.literal('responsive'), z.number().int().min(28).max(80)])`). Surfaced in the `/config` editor.

## Live update strategy

| Surface | Source | Cadence |
|---|---|---|
| Per-layer rows + bars + percentages | `lastLayerUsageRef` (turn boundary) | Turn end |
| Header `21.8k / 200k tokens (10.9%)` | `liveTokensRef`, throttled | 10 Hz |

A `useThrottledLiveTokens(intervalMs)` hook subscribes to the existing `liveTokensRef` (a ref, not state) and produces a `useState`-backed snapshot every `intervalMs`. At 10 Hz the numeric counter refresh is below the human-perceivable threshold for value tracking and avoids 30–80 re-renders per second during streaming. `ResponsesChat`'s `<Static>` boundary continues to protect scrollback; only the panel (or its strip variant) re-renders.

```ts
function useThrottledLiveTokens(intervalMs = 100): LiveTokens | null {
  const [snapshot, setSnapshot] = useState<LiveTokens | null>(null);
  const { liveTokens } = useContext(StreamMetricsContext);
  useEffect(() => {
    const id = setInterval(() => setSnapshot(liveTokens.current), intervalMs);
    return () => clearInterval(id);
  }, [liveTokens, intervalMs]);
  return snapshot;
}
```

## Input handling and precedence

`Ctrl+W` is mounted in a single `useInput` at `ChatLayout`, gated by `isActive: !modalContent && panelOpen`.

`prompt-input.tsx` accepts an `isActive` prop; its internal `useInput` is gated on `focusedPane === 'chat'`. The prompt continues to render (history and cursor visible) but does not consume keystrokes when the context pane has focus.

| State | `Ctrl+W` | `Ctrl+O` | `Ctrl+R` | `AskUserModal` |
|---|---|---|---|---|
| No modal/overlay | swap focus | open transcript overlay | open request overlay | n/a |
| Transcript or request overlay open | no-op | close overlay | close overlay | n/a |
| `AskUserModal` pending | no-op | no-op | no-op | active |
| Dock closed | no-op | open transcript | open request | n/a |

When `AskUserModal` opens while the dock is open, `focusedPane` snaps back to `chat` so the user can answer. The dock stays mounted and continues to refresh its header.

`Ctrl+W` is "delete-word-backward" in readline-bound shells, but Ink takes raw stdin, so there is no conflict.

## State

State lives in `app.tsx`:

```ts
const [panelOpen, setPanelOpen] = useState(false);
const [focusedPane, setFocusedPane] = useState<Pane>('chat');
```

Exposed to slash commands through `CommandContext`:

```ts
interface CommandContext {
  // ...existing
  toggleContextPanel?: () => void;
  contextPanelOpen?: boolean;
}
```

Optional fields so non-TUI `CommandContext` constructors (tasks runner, daemon) do not need to provide them.

## Persistence

The dock state is not persisted across launches. Each session starts with `panelOpen=false`, `focusedPane='chat'`. The feature is session-local by design — "watch context as you work" — and persisting would pollute `SessionSnapshot` (a content schema) without a clear use case.

## Layout primitives

Three pure functions, tested in isolation:

```ts
function decideLayoutMode(cols: number, panelWidth: number): 'wide' | 'narrow';
function resolvePanelWidth(cols: number, config: ContextPanelWidthConfig): number;
function nextFocus(current: Pane): Pane;  // pure toggle; layout effect derived
```

All other state machinery (border style, glyph, prompt gating) is derived from `panelOpen × focusedPane × layoutMode`.

## Out of scope

- Plugin-contributed docked panes.
- Left-side or top-side panel placement.
- Per-pane scroll beyond what `ContextDisplay` already provides.
- Mouse support (Ink TUI is keyboard-only).
- Mid-turn re-render of the bar chart — only the header throttles live.
- Auto-show on first launch / onboarding hints.
