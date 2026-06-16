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
const PANEL_MIN_WIDTH = 49;

function decideLayoutMode(cols: number, panelWidth: number): LayoutMode {
  return cols >= panelWidth + CHAT_MIN_WIDTH ? 'wide' : 'narrow';
}
```

### Wide

```
─ ► chat ─────────────── ─   Context ──────
 [streamed output]      │  Model
                        │   anthropic/…
                        │  Context
                        │   21.8k/200k
                        │  ▓▓▓░░░░░
 > _____________        │  System  2.8k
```

- `<Box flexDirection="row">` with the chat column (flexGrow=1) and `ContextPanel` (width=`panelWidth`, `mode='full'`).
- Each column has a **top horizontal rule with an inline title** (`─ ► chat ─` / `─ ► Context ─`). No full borders — no right or bottom borders anywhere.
- The vertical divider between the columns is the context panel's `borderLeft`.
- `Ctrl+W` swaps focus.
- The focused pane is marked by a **`►` glyph** prefix and a **bold** title; the unfocused title is dimmed. The rule character itself does not change on focus, so swapping focus never redraws the chrome — the signal is purely textual (legible on monochrome / NO_COLOR terminals).

### Narrow

```
─ ► chat ─────────────────────────
 [streamed output]

 > _____________
   Context · 21.8k / 200k (10.9%)
```

- Vertical stack. Focused pane fills available height; the other shows as a one-line strip below the prompt. The focused pane's top rule carries its `► <name>` title; the strip has no rule (it is itself the summary line).
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

- `'responsive'` (default): `clamp(PANEL_MIN_WIDTH, floor(0.40 * cols), 72)`.
- `number` (49–80): fixed columns, clamped down at runtime if the terminal cannot fit `value + CHAT_MIN_WIDTH` chat columns. The 49-col floor is sized so the per-layer row (14 label + 7 tokens + 24 bar = 45 cols) fits on a single line inside the bordered box.

Validated by Zod (`z.union([z.literal('responsive'), z.number().int().min(49).max(80)])`). Surfaced in the `/config` editor.

## Update strategy

| Surface | Source | Cadence |
|---|---|---|
| Per-layer rows + bars + percentages | `lastLayerUsageRef` (turn boundary) | Turn end |
| Header `21.8k / 200k tokens (10.9%)` | `lastLayerUsageRef.totalUsedTokens` | Turn end |

The header total and the per-layer bars share a single authoritative source — `LastLayerUsage`, committed at turn boundaries by the stream consumer. There is no mid-turn ticking: a streamed delta does not update the header.

This is a deliberate trim of an earlier design that ran a throttled 10Hz subscription against a `liveTokensRef`. In practice the ref is only ever written at turn-settle (not on each streamed delta), so the throttled hook fired uselessly between turns and would have shown numbers that disagreed with the bars beneath them — input+output only, with no system prompt, tool, or memory-layer overhead. Pinning both surfaces to the same source keeps them consistent at the cost of a per-turn refresh cadence on the header. If mid-turn ticking becomes user-visibly important later, it should plumb the delta into `LastLayerUsage` itself (so header and bars still agree) rather than reintroduce a second source of truth.

## Input handling and precedence

`ChatLayout` owns a single `useInput` that handles `Ctrl+W` (focus swap, gated on `panelOpen`), `Ctrl+O` (transcript overlay toggle), `Ctrl+T` (request-items overlay toggle), and `Esc` (overlay close → dock close, in that precedence order). The listener is gated on `isActive: !modalActive` so it stays live regardless of which pane has focus — the overlay shortcuts therefore work the same way whether the user is in chat or context. `Ctrl+R` is reserved for the prompt's reverse-incremental history search (readline / bash convention) and is handled inside `prompt-input.tsx`.

`ResponsesChat` is purely controlled with respect to overlays: `ChatLayout` passes down `overlay`, `requestItems`, and `requestItemsLoading` via the children render-prop, and the request-items fetch effect lives in `ChatLayout`. ResponsesChat keeps a single `useInput` for the modal Esc only — it has higher precedence than ChatLayout's chord handler because ChatLayout's listener is disabled when a modal is up.

`prompt-input.tsx` accepts an `isActive` prop; its internal `useInput` is gated on `focusedPane === 'chat'` so the prompt continues to render but stops consuming keystrokes when the context pane has focus.

| State | `Ctrl+W` | `Ctrl+O` | `Ctrl+T` | `Ctrl+R` | `Esc` | `AskUserModal` |
|---|---|---|---|---|---|---|
| No modal/overlay, dock open | swap focus | open transcript | open request | enter history search | close dock | n/a |
| Transcript or request overlay open | no-op | close overlay | close overlay | (overlay-owned) | close overlay | n/a |
| Dock closed, no overlay | no-op | open transcript | open request | enter history search | no-op | n/a |
| History search active | (prompt-owned) | (prompt-owned) | (prompt-owned) | cycle next match | cancel search | n/a |
| `AskUserModal` pending | inactive | inactive | inactive | inactive | close modal | active |

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
