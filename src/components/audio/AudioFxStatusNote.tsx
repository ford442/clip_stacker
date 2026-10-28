import { useAudioFxPreview } from '../../store/audioFxStore';
import { useEditorMasterBus, useEditorTracks } from '../../store';
import { busGraphNeededForPreview } from '../../audio/fxGraph';

/**
 * Says when the preview is not playing the bus FX the export will apply:
 * `?no_audio_fx`, or the AudioWorklet / its module failed to load. Renders
 * nothing while the preview runs them (or there is nothing to run).
 */
export function AudioFxStatusNote({ compact = false }: { compact?: boolean }) {
  const preview = useAudioFxPreview();
  const tracks = useEditorTracks();
  const masterBus = useEditorMasterBus();
  if (preview.state !== 'disabled' && preview.state !== 'failed') return null;
  if (!busGraphNeededForPreview(tracks, masterBus)) return null;
  const why = preview.state === 'disabled' ? 'disabled with ?no_audio_fx' : preview.reason;
  if (compact) {
    return (
      <span className="bus-fx-badge" role="status" title={`Lane / master FX are not previewed (${why}); export still applies them.`}>
        FX not previewed
      </span>
    );
  }
  return (
    <p className="inspector-warning" role="status">
      FX not previewed ({why}): the preview plays these buses dry. Export still applies them.
    </p>
  );
}
