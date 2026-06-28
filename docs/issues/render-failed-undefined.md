# Bug: "Render failed: undefined" — error normalization missing in top-level render handler

## Summary

When FFmpeg encounters an error during render (or when the worker layer rejects with a plain string), the UI shows **"Render failed: undefined"** instead of the actual error message.

## Root Cause

The top-level render handler in `App.tsx` (`performRender`) assumes the caught value is always an `Error` object with a `.message` property:

```typescript
} catch (error) {
  const err = error as Error;
  const message = `Render failed: ${err.message}`; // undefined when error is a string
}
```

However:

1. The FFmpeg worker (`ffmpeg.worker.ts`) sends errors as plain strings via `String(error)`.
2. `@ffmpeg/ffmpeg` internally may reject with `error.toString()` (a string, not an Error).
3. The existing `extractErrorMessage()` / `normalizeError()` helper in `ffmpegCommon.ts` handles all these cases correctly — but the top-level catch block does not use it.

Lower-level wrappers (`safeExec`, `buildDetailedError`, `ensureFfmpeg`) already normalize errors; only the UI boundary was missing the fix.

## Impact

- **P0**: Every FFmpeg failure surfaces as "undefined", making debugging impossible.
- Users cannot copy meaningful debug info from the status bar.
- Multi-clip renders (R002, R003) appear to fail mysteriously even when the real error is recoverable or informative.

## Fix

1. Use `normalizeError(error)` in the `performRender` catch block instead of `(error as Error).message`.
2. Add `RenderFailurePanel` with expandable FFmpeg command, filter_complex, and logs.
3. Replace flat "Copy Debug" output with `generateDebugReport()` markdown.

## Acceptance Criteria

- [ ] Render failure never displays "undefined" in the status bar or RenderFailurePanel.
- [ ] Worker string rejections show the original message text.
- [ ] `safeExec` failures show the full `buildDetailedError` message including embedded FFmpeg logs.
- [ ] Copy Debug Report includes environment, render plan, clips, last FFmpeg command, filter_complex, and last 50 logs.
- [ ] R002 and R003 from the test matrix pass or fail with actionable messages.

## Test Plan

```bash
./scripts/debug-render.sh
npm run preview
```

Manual:
- **R002**: Two clips, no effects → lossless concat or real error message.
- **R003**: Two clips + dissolve transition → filter_complex path, no "undefined".
- Force failure (invalid trim) → verify RenderFailurePanel shows command + logs.

## Related Files

- `src/App.tsx` — `performRender` catch block
- `src/ffmpeg/ffmpegCommon.ts` — `normalizeError()` / `extractErrorMessage()`
- `src/ffmpeg/core.ts` — `safeExec`, `buildDetailedError`, command capture
- `src/utils/debugReport.ts` — `generateDebugReport()`
- `src/components/RenderFailurePanel.tsx` — failure UX

## Labels

`bug`, `P0`, `render-pipeline`, `ffmpeg`
