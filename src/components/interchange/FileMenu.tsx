import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { editorStore } from '../../store/editorStore';
import { renderJobStore } from '../../store/renderJobStore';
import { allSequenceClips } from '../../timeline/sequenceModel';
import { INTERCHANGE_FILE_TYPES, INTERCHANGE_FORMATS } from '../../interchange/formats';
import type { InterchangeFormat } from '../../interchange/mapping';
import { LazyBoundary, lazyNamed } from '../LazyBoundary';

// The formats, the XML / zip libraries and the dialogs load on first use.
const loadActions = () => import('../../actions/interchangeActions');
const ExportStemsDialog = lazyNamed(() => import('./ExportStemsDialog'), 'ExportStemsDialog');
const RelinkMediaDialog = lazyNamed(() => import('./RelinkMediaDialog'), 'RelinkMediaDialog');

function download(text: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Toolbar **File** menu: import a timeline (OTIO / FCPXML / EDL), export the
 * open one, export stems, relink offline media. It owns its two dialogs.
 */
export function FileMenu() {
  const [dialog, setDialog] = useState<'stems' | 'relink' | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const offlineCount = useStore(editorStore, (s) => allSequenceClips(s).filter((clip) => Boolean(clip.offline)).length);
  const stemsOutput = useStore(renderJobStore, (s) => s.stemsOutput);
  const close = () => menu.current?.removeAttribute('open');

  const onImport = async (file: File) => {
    const { setStatus } = renderJobStore.getState();
    const hasContent = editorStore.getState().clips.length > 0;
    if (hasContent && !window.confirm(`Importing "${file.name}" replaces the open project. Continue?`)) return;
    try {
      const { importTimelineIntoEditor } = await loadActions();
      const report = await importTimelineIntoEditor({ text: await file.text(), fileName: file.name });
      if (report.offline.length > 0) setDialog('relink');
    } catch (err) {
      setStatus(`Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onExport = async (format: InterchangeFormat) => {
    close();
    try {
      const { exportCurrentTimeline } = await loadActions();
      const { text, fileName, mime } = exportCurrentTimeline(format);
      download(text, fileName, mime);
      renderJobStore.getState().setStatus(`Exported ${INTERCHANGE_FILE_TYPES[format].label}: ${fileName}`);
    } catch (err) {
      renderJobStore.getState().setStatus(`Could not export the timeline: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <details ref={menu} className="file-menu">
        <summary title="Timeline interchange (OTIO, FCPXML, EDL), stems and media relinking">File ▾</summary>
        <div className="file-menu-items" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              importInput.current?.click();
            }}
          >
            Import timeline… (.otio / .fcpxml / .edl)
          </button>
          {INTERCHANGE_FORMATS.map((format) => (
            <button key={format} type="button" role="menuitem" onClick={() => void onExport(format)}>
              Export timeline ▸ {INTERCHANGE_FILE_TYPES[format].label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              setDialog('stems');
            }}
          >
            Export stems…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              setDialog('relink');
            }}
          >
            Relink media…{offlineCount > 0 ? ` (${offlineCount} offline)` : ''}
          </button>
          {stemsOutput && (
            <a role="menuitem" href={stemsOutput.url} download={stemsOutput.fileName} onClick={close}>
              Download {stemsOutput.fileName}
            </a>
          )}
        </div>
      </details>
      {offlineCount > 0 && (
        <button type="button" className="btn-secondary offline-badge" onClick={() => setDialog('relink')} title="Some clips have no media: relink them before rendering">
          ⚠ {offlineCount} offline
        </button>
      )}
      <input
        ref={importInput}
        type="file"
        hidden
        accept=".otio,.fcpxml,.edl,.xml,application/json,application/xml,text/plain"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void onImport(file);
        }}
      />
      {dialog && (
        <LazyBoundary label={dialog === 'stems' ? 'Export stems' : 'Relink media'}>
          {dialog === 'stems' ? <ExportStemsDialog onClose={() => setDialog(null)} /> : <RelinkMediaDialog onClose={() => setDialog(null)} />}
        </LazyBoundary>
      )}
    </>
  );
}
