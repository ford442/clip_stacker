import type { RenderPlan } from '../../types';
import { formatLufs } from './LoudnessMeter';

function signedDb(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} dB`;
}

/** The resolved render plan's audio-bus lines: where bus FX ran and what loudness landed. */
export function RenderPlanAudioNotes({ plan }: { plan: RenderPlan }) {
  const loudness = plan.loudness;
  return (
    <>
      {plan.audioFx === 'engine' && (
        <p className="render-plan-info">
          Lane / master FX and ducks mixed by the media engine — the same bus graph the preview plays.
        </p>
      )}
      {loudness && (
        <p className="render-plan-info">
          Loudness: measured {formatLufs(loudness.measuredLufs)} LUFS, {signedDb(loudness.gainDb)} → delivered{' '}
          {formatLufs(loudness.outputLufs)} LUFS (target {loudness.targetLufs}), true peak{' '}
          {formatLufs(loudness.outputTruePeakDb)} dBTP.
        </p>
      )}
      {plan.audioFx === 'offline-fallback' && (
        <p className="render-plan-warning" role="alert">
          ⚠ Lane / master FX, ducks and the loudness target were skipped: the media engine is unavailable
          (<code>?no_media_engine</code> or a failed load), so the audio was mixed dry on OfflineAudioContext.
        </p>
      )}
      {plan.audioFx === 'none' && (
        <p className="render-plan-warning" role="alert">
          ⚠ No audio premix ran for this render, so lane / master FX, ducks and the loudness target did not
          reach the file.
        </p>
      )}
    </>
  );
}
