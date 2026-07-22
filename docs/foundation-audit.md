# Phase 1 — Foundation Audit

_Verification of the Phase-1 foundation claims against the actual codebase, with
file/line evidence. Audited on the `claude/clip-stacker-foundation-audit-tw7m25`
branch._

The foundation goal is that the app supports **large projects**, **reliable
exports**, and a **responsive UI** before flashy features are layered on. This
document verifies each claim and records the current status of every roadmap gap.

Baseline at audit time: `npm test -- --run` → **425 tests passing**;
`npm run build` succeeds.

---

## ✅ Verified in good shape

| Area | Claim | Evidence |
|------|-------|----------|
| Vite COOP/COEP | Dev + preview servers set isolation headers | `vite.config.ts` — `server.headers` and `preview.headers` both send `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` |
| WebGPU `alphaMode` | `premultiplied` compositing | `src/webgpu/previewEngine.ts:104`, `:122` (`context.configure({ …, alphaMode: "premultiplied" })`) |
| FFmpeg in dedicated worker | FFmpeg runs off the main thread | `src/ffmpeg/workerFfmpegRuntime.ts`, `src/ffmpeg/ffmpeg.worker.ts` |
| WebCodecs export | Encode + decode helpers present | `src/utils/webcodecs.ts`, `src/utils/hybrid-encoder.ts`, `src/utils/webcodecs-decoder.ts` (all with test coverage) |
| Capability detection | SAB / cross-origin isolation probed | `src/utils/feature-detector.ts:27`, `:38-40` |
| CSP / security headers | Central policy, blob/wasm allowances scoped | `src/utils/csp.ts` (`CONTENT_SECURITY_POLICY`, `DEV_CONTENT_SECURITY_POLICY`) |

All six original "good shape" claims hold.

---

## Roadmap gap status (#144–#151)

Most gap-tracking issues have landed since the roadmap was written. Current
verified status:

| # | Gap | Status | Evidence |
|---|-----|--------|----------|
| #144 | Core app state in `App.tsx` | **Advanced (this branch)** | Editing state + undo/redo extracted to Zustand `src/store/editorStore.ts`; `useEditHistory` is now a thin binding. See below. |
| #145 | WebGPU on main thread | **Resolved** | `src/webgpu/preview.worker.ts` + `PreviewWorkerAdapter` off-thread the compositor, with a main-thread fallback (`src/components/Preview.tsx:303-308`) |
| #146 | FFmpeg SAB / core-mt fallback | **Resolved** | `src/ffmpeg/ffmpegCommon.ts` selects single-threaded `@ffmpeg/core` vs multi-threaded `@ffmpeg/core-mt` from `crossOriginIsolated` + `SharedArrayBuffer` (`:113-115`), with CDN fallbacks and remediation logging (`:175`). Remote media serves `Cross-Origin-Resource-Policy: cross-origin` (`contabo_storage_manager/config/storage.noahcohn.com.conf`, `chunked_media_upload.py:136`) |
| #147 | WebCodecs decode in export | **Resolved** | `src/utils/webcodecs-decoder.ts` + `src/utils/hybrid-encoder.ts` |
| #148 | Web Audio playback graph | **Resolved** | `src/audio/playbackManager.ts`, `src/audio/schedule.ts` (+ `useTimelineAudioPlayback` hook) |
| #149 | Chunked resumable uploads | **Resolved** | `src/utils/storageUpload.ts`; server side `contabo_storage_manager/python/chunked_media_upload.py` |
| #150 | Virtualized timeline DOM | **Resolved** | `src/components/VirtualClipBlock.tsx` + `@tanstack/react-virtual` |
| #151 | WASM audio analysis | **Resolved** | `src/wasm/audioAnalysis.ts`, `audioAnalysisWorker.ts`, `audioReactiveUniforms.ts` |

---

## #144 — Core state migration (work done on this branch)

### Finding

Before this branch, the timeline's durable editing state — `clips`,
`clipGroups`, `transitions`, `textOverlays`, `selectedClipId` — plus the entire
undo/redo history lived in React `useState` inside `src/hooks/useEditHistory.ts`.
Those values were destructured in `App.tsx` and prop-drilled into `Timeline`,
`Inspector`, and `Preview`. Every clip mutation (including throttled inspector
slider drags) re-rendered the whole `App` subtree — the "timeline jank at scale"
risk the issue calls out. Only the transient playhead had been moved out of React
(`src/store/playbackStore.ts`).

### Change

- **`src/store/editorStore.ts`** — a Zustand (`zustand/vanilla`) store now owns
  the durable editing state and the undo/redo + debounce-coalescing logic that
  previously lived in the hook. Setters accept `SetStateAction` (value **or**
  functional updater), so existing `setClips((prev) => …)` call sites in
  `App.tsx` are unchanged. Undo/redo stacks and debounce timers are kept in
  non-reactive module state so pushing history never triggers a render; only the
  published `undoDepth`/`redoDepth` counters do (driving `canUndo`/`canRedo`).
- **`src/hooks/useEditHistory.ts`** — reduced to a thin binding over the store
  via `useStore` selectors. Its public `UseEditHistoryResult` API is byte-for-byte
  the same, so `App.tsx` needed no changes.
- **Granular selector hooks** — `useEditorClips`, `useEditorClipGroups`,
  `useEditorTransitions`, `useEditorTextOverlays`, `useSelectedClipId`. Leaf
  components can subscribe to a single slice and stop re-rendering on unrelated
  edits. This is the migration path for follow-up work (see below).
- **`src/store/editorStore.test.ts`** — 7 tests covering direct/functional
  setters, undo/redo, redo-stack clearing, no-op empty stacks, no-history-while-
  restoring, debounce coalescing, and `resetHistory`.

### Why this is the right increment

Moving the state without rewriting every consumer keeps the change reviewable and
low-risk (the hook API is preserved, all 418 prior tests still pass), while
unlocking the actual performance win: components can migrate from props to
granular selectors one at a time.

### Remaining #144 follow-up (not in this branch)

`App.tsx` is still ~1,500 lines and continues to prop-drill these values. The
next steps are mechanical and independently shippable:

1. Switch `Timeline` / `VirtualClipBlock` to `useEditorClips` +
   `useSelectedClipId` instead of props, so playhead scrubbing and selection
   changes don't re-render unrelated clip blocks.
2. Switch `Inspector` to `useSelectedClipId` + a `useEditorClip(id)` selector.
3. Move the derived/UI-only state clusters out of `App.tsx` (render state,
   remote-save state) into their own stores or leave in local hooks.

---

## Success-metric readiness

| Metric | Enabling work | Status |
|--------|---------------|--------|
| 200-clip timeline scroll ≥ 30 fps | #150 virtualization + #144 selective subscriptions | Virtualization landed; selector migration pending |
| 1080p30 export ≤ 1.5× realtime | #147 WebCodecs path | Encoder/decoder present |
| FFmpeg load success > 99% (COEP + non-COEP) | #146 core-mt/core fallback + CORP headers | Landed |
| 2 GB resumable upload | #149 chunked upload | Landed |
