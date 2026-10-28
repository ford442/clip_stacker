/** dB of gain reduction a full bar shows. */
const FULL_SCALE_DB = 24;

/**
 * Horizontal gain-reduction bar (compressors, gates, de-essers, limiters and
 * the duck together), fed by the preview's bus-graph meter while it plays.
 */
export function GainReductionMeter({ db, label }: { db: number; label: string }) {
  const clamped = Math.max(0, Math.min(FULL_SCALE_DB, Number.isFinite(db) ? db : 0));
  return (
    <div className="bus-gr-meter">
      <span className="bus-gr-meter-label">GR</span>
      <span
        className="bus-gr-meter-track"
        role="meter"
        aria-label={`${label} gain reduction`}
        aria-valuemin={0}
        aria-valuemax={FULL_SCALE_DB}
        aria-valuenow={Number(clamped.toFixed(1))}
      >
        <span className="bus-gr-meter-fill" style={{ width: `${(clamped / FULL_SCALE_DB) * 100}%` }} />
      </span>
      <span className="bus-gr-meter-value">{clamped > 0.05 ? `−${clamped.toFixed(1)} dB` : '0 dB'}</span>
    </div>
  );
}
