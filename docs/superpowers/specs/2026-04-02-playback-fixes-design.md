# Playback & Timeline Fixes Design

**Goal:** Fix timeline showing events from other runs, broken step count, wrong transport icons, and sluggish scrubbing.

---

## 1. Nodes accumulate across runs

**Root cause:** `execution.ts:setTrace()` merges new trace nodes into the existing `nodes` map via `new Map(state.nodes)`. Old run nodes persist.

**Fix:** Replace `new Map(state.nodes)` with `new Map()` in `setTrace()` so switching runs starts clean.

## 2. Playback state carries over between runs

**Root cause:** `PlaybackBar.tsx` calls `setTotalSteps(nodes.size)` and `setMarkers(nodeArray)` when nodes change, but never resets the playback store's `currentStepIndex` or `state`. Stale indices from a previous run remain.

**Fix:** When the trace changes in PlaybackBar's `useEffect`, also reset playback: call `jumpToFirst()` and set state to `idle` so the playhead starts at 0.

## 3. Transport control icons wrong

**Root cause:** SVG paths in `TransportControls.tsx` are incorrect — FirstIcon renders a skip-forward shape, LastIcon renders a skip-back shape, StepBack/StepForward have duplicate bar elements.

**Fix:** Replace all icon SVG paths:

| Button | Shape |
|--------|-------|
| First | Left-pointing triangle + right bar (`◀\|`) |
| StepBack | Single left-pointing triangle (`◀`) |
| Play | Right-pointing triangle (`▶`) — keep |
| Pause | Two vertical bars (`\|\|`) — keep |
| StepForward | Single right-pointing triangle (`▶`) |
| Last | Left bar + right-pointing triangle (`\|▶`) |

## 4. Responsive scrubbing

**Root cause:** Playhead and progress bar have `transition-all duration-75` CSS transitions during drag, adding 75ms delay per frame. `onPositionChange` triggers heavy marker-lookup + `jumpToStep` on every mouse move.

**Fix:**
- `Timeline.tsx`: Conditionally remove transitions when `isDragging` is true
- `PlaybackBar.tsx`: `onPositionChange` (during drag) only updates visual playhead. `onDragEnd` does the full marker-snap + `jumpToStep` + callback.
