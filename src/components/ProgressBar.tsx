interface Props {
  stage: string;
  progress: number | null;
  indeterminate: boolean;
}

export function ProgressBar({ stage, progress, indeterminate }: Props) {
  const normalized =
    typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : null;
  const pct = normalized === null ? null : Math.round(normalized * 100);
  const showIndeterminate = indeterminate || pct === null;

  return (
    <div className="render-progress" aria-live="polite">
      <div className="render-progress-label">
        <span>{stage}</span>
        <span>{pct === null ? "Working…" : `${pct}%`}</span>
      </div>
      <div
        className={`render-progress-track ${showIndeterminate ? "is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-label={stage}
      >
        {!showIndeterminate && (
          <div
            className="render-progress-fill"
            style={{ width: `${pct ?? 0}%` }}
          />
        )}
      </div>
    </div>
  );
}
