import { Component, type ErrorInfo, type ReactNode } from 'react';
import { readAutoSaveOffer } from '../project/autoSave';
import { editorStore } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { renderJobStore } from '../store/renderJobStore';

interface RootErrorBoundaryState {
  error: Error | null;
  componentStack: string;
  copyStatus: string;
}

/**
 * The editor's last line of defence: a render error anywhere below would
 * otherwise unmount the whole tree and leave a blank page. Unmounting App
 * also stops autosave, so the last autosave (from before the crash) is what
 * a reload offers to recover.
 *
 * Lazy panels keep their own boundaries (`LazyBoundary`) so a failed chunk
 * only takes down its panel.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { error: null, componentStack: '', copyStatus: '' };

  static getDerivedStateFromError(error: unknown): Partial<RootErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[clip_stacker] the editor crashed', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  private handleCopyDebug = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    const crash = new Error(error?.message ?? 'unknown error');
    crash.stack = `${error?.stack ?? ''}\n\nComponent stack:${componentStack}`;
    let text: string;
    try {
      const { generateDebugReport } = await import('../actions/debugReport');
      const settings = settingsStore.getState();
      const job = renderJobStore.getState();
      const editor = editorStore.getState();
      text = generateDebugReport({
        status: job.status,
        renderPlan: job.renderPlan,
        encoderPath: job.encoderPath,
        clips: editor.clips,
        clipGroups: editor.clipGroups,
        transitions: editor.transitions,
        textOverlays: editor.textOverlays,
        exportSettings: settings.exportSettings,
        colorManagement: settings.colorManagement,
        error: crash,
      });
    } catch (reportError) {
      // The crash may have left state the full report cannot read.
      text = [
        '# clip_stacker crash report (minimal)',
        `- User Agent: ${navigator.userAgent}`,
        `- Report failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
        '',
        crash.stack ?? crash.message,
      ].join('\n');
    }
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copyStatus: 'Debug report copied to the clipboard.' });
    } catch {
      console.log(text);
      this.setState({ copyStatus: 'Clipboard blocked — the debug report is in the console.' });
    }
  };

  override render(): ReactNode {
    const { error, copyStatus } = this.state;
    if (!error) return this.props.children;
    const offer = readAutoSaveOffer();
    return (
      <div className="root-error" role="alert" style={{ padding: '2rem', maxWidth: '40rem' }}>
        <h1>The editor hit an error and stopped</h1>
        <p>
          <code>{error.message}</code>
        </p>
        <p>
          {offer
            ? `An autosave from ${offer.savedAt.toLocaleString()} (${offer.clipCount} clip${offer.clipCount === 1 ? '' : 's'}) is kept. Reload to recover it.`
            : 'No autosave is available to recover.'}
        </p>
        <p style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => window.location.reload()}>
            {offer ? 'Reload and recover autosave' : 'Reload'}
          </button>
          <button type="button" onClick={() => void this.handleCopyDebug()}>
            Copy Debug
          </button>
          <button
            type="button"
            onClick={() => this.setState({ error: null, componentStack: '', copyStatus: '' })}
          >
            Try again
          </button>
        </p>
        {copyStatus && <p aria-live="polite">{copyStatus}</p>}
      </div>
    );
  }
}
