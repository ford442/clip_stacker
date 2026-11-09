import {
  AUDIO_SYNC_OFFSET_MAX_MS,
  AUDIO_SYNC_OFFSET_MIN_MS,
  AUDIO_SYNC_OFFSET_STEP_MS,
  useAudioSyncStore,
} from '../store/audioSyncStore';

/**
 * Per-browser A/V offset (ms) for the preview playhead. View state: it
 * describes this listener's output device, so it is never saved in a project.
 */
export function AudioSyncOffsetControl() {
  const offsetMs = useAudioSyncStore((s) => s.offsetMs);
  const setOffsetMs = useAudioSyncStore((s) => s.setOffsetMs);
  return (
    <label
      className="preview-audio-offset"
      title="Audio offset for this browser: raise it when sound arrives after the picture (e.g. Bluetooth headphones). The reported output latency is already compensated."
    >
      A/V
      <input
        type="number"
        min={AUDIO_SYNC_OFFSET_MIN_MS}
        max={AUDIO_SYNC_OFFSET_MAX_MS}
        step={AUDIO_SYNC_OFFSET_STEP_MS}
        value={offsetMs}
        aria-label="Audio offset in milliseconds"
        onChange={(e) => {
          if (e.target.value !== '') setOffsetMs(Number(e.target.value));
        }}
        onDoubleClick={() => setOffsetMs(0)}
      />
      ms
    </label>
  );
}
