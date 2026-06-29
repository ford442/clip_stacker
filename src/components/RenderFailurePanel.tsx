import { useState, type ReactNode } from 'react';
import type { RenderPlan } from '../types';
import {
  getLastFfmpegCommand,
  getLastFfmpegFilterComplex,
  getLastFfmpegLogs,
} from '../ffmpeg/ffmpegService';
import '../styles/render-failure.css';

interface Props {
  message: string;
  renderPlan: RenderPlan | null;
  onCopyDebug: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

function highlightFilterComplex(filter: string): ReactNode {
  const tokens = filter.split(/(\[[^\]]+\]|[;=,])/g);
  return tokens.map((token, i) => {
    if (/^\[[^\]]+\]$/.test(token)) {
      return (
        <span key={i} className="rf-filter-label">
          {token}
        </span>
      );
    }
    if (/^(scale|xfade|acrossfade|fade|drawtext|overlay|concat|amix|volume|apad|trim|setsar|format|fps)/.test(token)) {
      return (
        <span key={i} className="rf-filter-func">
          {token}
        </span>
      );
    }
    return <span key={i}>{token}</span>;
  });
}

function classifyLogLine(line: string): string {
  if (/error|failed|invalid|no such|cannot|unable/i.test(line)) return 'rf-log-error';
  if (/warning|deprecated/i.test(line)) return 'rf-log-warn';
  if (/time=/.test(line)) return 'rf-log-progress';
  return 'rf-log-info';
}

export function RenderFailurePanel({
  message,
  renderPlan,
  onCopyDebug,
  onRetry,
  onDismiss,
}: Props) {
  const [showCommand, setShowCommand] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [showLogs, setShowLogs] = useState(true);

  const lastCommand = getLastFfmpegCommand();
  const filterComplex = getLastFfmpegFilterComplex();
  const logs = getLastFfmpegLogs(20);

  const displayMessage =
    message && message !== 'undefined' ? message : 'Render failed (unknown error)';

  return (
    <div className="render-failure-panel" role="alert">
      <div className="rf-header">
        <span className="rf-icon" aria-hidden="true">
          ⚠
        </span>
        <h3 className="rf-title">Render Failed</h3>
        <button
          type="button"
          className="rf-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>

      <p className="rf-message">{displayMessage}</p>

      {renderPlan && (
        <div className="rf-plan-summary">
          <strong>Render plan:</strong> {renderPlan.description} ({renderPlan.reason})
        </div>
      )}

      {lastCommand && (
        <details
          open={showCommand}
          onToggle={(e) => setShowCommand((e.target as HTMLDetailsElement).open)}
        >
          <summary>FFmpeg Command</summary>
          <pre className="rf-command">
            <code>ffmpeg {lastCommand.join(' ')}</code>
          </pre>
        </details>
      )}

      {filterComplex && (
        <details
          open={showFilter}
          onToggle={(e) => setShowFilter((e.target as HTMLDetailsElement).open)}
        >
          <summary>filter_complex</summary>
          <pre className="rf-filter">
            <code>{highlightFilterComplex(filterComplex)}</code>
          </pre>
        </details>
      )}

      <details
        open={showLogs}
        onToggle={(e) => setShowLogs((e.target as HTMLDetailsElement).open)}
      >
        <summary>FFmpeg Logs ({logs.length})</summary>
        <div className="rf-logs">
          {logs.length === 0 ? (
            <p className="rf-log-empty">No FFmpeg logs captured.</p>
          ) : (
            logs.map((line, i) => (
              <div key={i} className={`rf-log-line ${classifyLogLine(line)}`}>
                {line}
              </div>
            ))
          )}
        </div>
      </details>

      <div className="rf-actions">
        <button type="button" className="rf-btn rf-btn-primary" onClick={onCopyDebug}>
          Copy Debug Report
        </button>
        <button type="button" className="rf-btn" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="rf-btn rf-btn-muted" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
