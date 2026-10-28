import { useRef, useState, type DragEvent } from 'react';
import { useStore } from 'zustand';
import {
  applyFinishingPresetDocument,
  applyFinishingPresetInput,
  deleteFinishingPreset,
  finishingPresetStore,
  listFinishingPresets,
  renameFinishingPreset,
  saveCurrentFinishingAsPreset,
} from '../store/finishingPresetStore';
import {
  FINISHING_PRESET_NAME_MAX,
  finishingPresetAgentBrief,
  parseFinishingPreset,
  presetDocumentToJson,
  summarizePreset,
  type FinishingPresetDocument,
} from '../utils/finishingPresets';

/** Download text as a file (preset export). */
function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileNameFor = (name: string) =>
  `${name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'preset'}.finishing.json`;

/**
 * Named finishing presets: built-ins, the user's own (per browser, across
 * projects), "Save current as…", rename / export / delete, and an import box
 * for JSON pasted or dropped from an AI agent. Applying is one undo step.
 */
export function FinishingPresetsPanel() {
  const userPresets = useStore(finishingPresetStore, (s) => s.presets);
  const listed = listFinishingPresets(userPresets);

  const [saveName, setSaveName] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const say = (kind: 'ok' | 'error', text: string) => setMessage({ kind, text });

  const apply = (doc: FinishingPresetDocument) => {
    applyFinishingPresetDocument(doc);
    say('ok', `Applied "${doc.name}". Undo (Ctrl+Z) restores the previous stack.`);
  };

  const save = (overwrite: boolean) => {
    const result = saveCurrentFinishingAsPreset(saveName, { overwrite });
    if (result.ok) {
      say('ok', `Saved the current stack as "${result.preset.name}".`);
      setSaveName('');
      setSaveConflict(false);
    } else if (result.conflictId) {
      setSaveConflict(true);
      say('error', `${result.error} Replace it?`);
    } else {
      say('error', result.error);
    }
  };

  const commitRename = () => {
    if (!renaming) return;
    const result = renameFinishingPreset(renaming.id, renaming.name);
    if (result.ok) {
      setRenaming(null);
      say('ok', `Renamed to "${result.preset.name}".`);
    } else {
      say('error', result.error);
    }
  };

  const validateImport = (text = importText) => {
    const parsed = parseFinishingPreset(text);
    if (parsed.ok) {
      setImportErrors([]);
      setImportInfo(
        `Valid: "${parsed.preset.name}" — ${summarizePreset(parsed.preset)}.${
          parsed.warnings.length ? ` ${parsed.warnings.join(' ')}` : ''
        }`,
      );
    } else {
      setImportInfo(null);
      setImportErrors(parsed.errors);
    }
    return parsed.ok;
  };

  const applyImport = (saveToo: boolean) => {
    const result = applyFinishingPresetInput(importText, { save: saveToo });
    if (!result.ok) {
      setImportInfo(null);
      setImportErrors(result.errors);
      return;
    }
    setImportErrors([]);
    setImportInfo(null);
    say(
      'ok',
      `Applied "${result.name}"${result.saved ? ' and saved it' : ''}. Undo (Ctrl+Z) restores the previous stack.`,
    );
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    validateImport(text);
  };

  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    e.preventDefault();
    setDragOver(false);
    void loadFile(file);
  };

  const copyAgentBrief = async () => {
    try {
      await navigator.clipboard.writeText(finishingPresetAgentBrief());
      say('ok', 'Copied the preset format (instructions, example and JSON Schema) for an AI agent.');
    } catch {
      downloadText('finishing-preset.schema.txt', finishingPresetAgentBrief());
      say('ok', 'Clipboard unavailable — downloaded the preset format instead.');
    }
  };

  return (
    <div className="finishing-presets-panel">
      <div className="inspector-group-label">Finishing presets</div>
      <p className="inspector-hint">
        Save the whole stack under a name and reuse it in any project (stored in this
        browser). Applying a preset replaces the stack and is one undo step.
      </p>

      <ul className="finishing-preset-list" aria-label="Finishing presets">
        {listed.map((p) => {
          const user = p.user;
          const isRenaming = user && renaming?.id === user.id;
          return (
            <li key={p.key} className="finishing-preset-row">
              {isRenaming ? (
                <input
                  className="finishing-preset-rename"
                  aria-label={`Rename ${user.name}`}
                  value={renaming.name}
                  maxLength={FINISHING_PRESET_NAME_MAX}
                  autoFocus
                  onChange={(e) => setRenaming({ id: user.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="finishing-preset-name" title={p.doc.description ?? summarizePreset(p.doc)}>
                  {p.doc.name}
                  {p.builtIn ? <span className="finishing-preset-badge">Built-in</span> : null}
                  {p.doc.apply === 'merge' ? <span className="finishing-preset-badge">Merge</span> : null}
                </span>
              )}
              <span className="finishing-preset-actions">
                {isRenaming ? (
                  <>
                    <button type="button" className="btn-secondary" onClick={commitRename}>
                      Save name
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn-secondary" onClick={() => apply(p.doc)}>
                      Apply
                    </button>
                    {user && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setRenaming({ id: user.id, name: user.name })}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary"
                      title="Download as a .json preset file"
                      onClick={() => downloadText(fileNameFor(p.doc.name), presetDocumentToJson(p.doc))}
                    >
                      Export
                    </button>
                    {user &&
                      (confirmDelete === user.id ? (
                        <button
                          type="button"
                          className="btn-secondary finishing-preset-danger"
                          onClick={() => {
                            deleteFinishingPreset(user.id);
                            setConfirmDelete(null);
                            say('ok', `Deleted "${user.name}".`);
                          }}
                          onBlur={() => setConfirmDelete(null)}
                        >
                          Confirm delete
                        </button>
                      ) : (
                        <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(user.id)}>
                          Delete
                        </button>
                      ))}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="finishing-preset-save">
        <input
          aria-label="New preset name"
          placeholder="Preset name"
          value={saveName}
          maxLength={FINISHING_PRESET_NAME_MAX}
          onChange={(e) => {
            setSaveName(e.target.value);
            setSaveConflict(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && saveName.trim()) save(false);
          }}
        />
        {saveConflict ? (
          <button type="button" className="btn-secondary finishing-preset-danger" onClick={() => save(true)}>
            Replace
          </button>
        ) : (
          <button type="button" className="btn-secondary" disabled={!saveName.trim()} onClick={() => save(false)}>
            Save current as preset
          </button>
        )}
      </div>

      {message && (
        <p className={`finishing-preset-message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      <details className="finishing-preset-import">
        <summary>Import JSON (paste or drop — e.g. from an AI agent)</summary>
        <textarea
          aria-label="Finishing preset JSON"
          className={`finishing-preset-json${dragOver ? ' is-drag-over' : ''}`}
          placeholder='{"schema": "clip_stacker.finishing-preset", "version": 1, "name": "…", "finishing": { … }}'
          rows={8}
          spellCheck={false}
          value={importText}
          onChange={(e) => {
            setImportText(e.target.value);
            setImportErrors([]);
            setImportInfo(null);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        />
        <div className="finishing-preset-import-actions">
          <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
            Open .json…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button type="button" className="btn-secondary" disabled={!importText.trim()} onClick={() => validateImport()}>
            Validate
          </button>
          <button type="button" className="btn-secondary" disabled={!importText.trim()} onClick={() => applyImport(false)}>
            Apply
          </button>
          <button type="button" className="btn-secondary" disabled={!importText.trim()} onClick={() => applyImport(true)}>
            Apply &amp; save
          </button>
          <button
            type="button"
            className="btn-secondary"
            title="Copy instructions, an example and the JSON Schema to give an AI agent"
            onClick={() => void copyAgentBrief()}
          >
            Copy format for agents
          </button>
        </div>
        {importInfo && (
          <p className="finishing-preset-message is-ok" role="status">
            {importInfo}
          </p>
        )}
        {importErrors.length > 0 && (
          <div className="finishing-preset-message is-error" role="alert">
            Nothing was applied:
            <ul>
              {importErrors.slice(0, 12).map((err) => (
                <li key={err}>{err}</li>
              ))}
              {importErrors.length > 12 && <li>…and {importErrors.length - 12} more.</li>}
            </ul>
          </div>
        )}
      </details>
    </div>
  );
}
