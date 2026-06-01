import { useState, useCallback } from 'react';
import { ContaboStorageManagerClient } from '../utils/project';
import { ProgressBar } from './ProgressBar';

interface Props {
  endpoint: string;
  authToken: string;
  onAuthTokenChange: (value: string) => void;
  onSaveRemote: (endpoint: string, authToken: string, projectName: string) => void;
  onLoadRemote: (endpoint: string, authToken: string, projectName: string) => void;
  isRemoteSaving: boolean;
  isRemoteLoading: boolean;
  remoteLoadStage: string;
  remoteLoadProgress: number | null;
  remoteLoadIndeterminate: boolean;
  remoteUploadItems: {
    clipId: string;
    fileName: string;
    index: number;
    total: number;
    progress: number;
    status: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'skipped';
    error?: string;
  }[];
  pendingRemoteUploadError: {
    fileName: string;
    index: number;
    total: number;
    error: string;
  } | null;
  onResolveRemoteUploadError: (action: 'retry' | 'skip' | 'abort') => void;
}

export function StorageRow({
  endpoint,
  authToken,
  onAuthTokenChange,
  onSaveRemote,
  onLoadRemote,
  isRemoteSaving,
  isRemoteLoading,
  remoteLoadStage,
  remoteLoadProgress,
  remoteLoadIndeterminate,
  remoteUploadItems,
  pendingRemoteUploadError,
  onResolveRemoteUploadError,
}: Props) {
  const [projectName, setProjectName] = useState('default-project');
  const [projects, setProjects] = useState<{ name: string; modified: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');

  const fetchProjects = useCallback(async () => {
    if (!endpoint) {
      setListError('Enter an endpoint URL first.');
      return;
    }
    setLoading(true);
    setListError('');
    try {
      const client = new ContaboStorageManagerClient(endpoint, authToken);
      const list = await client.list();
      setProjects(list);
    } catch (error) {
      setListError((error as Error).message);
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint, authToken]);

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Delete project "${name}"?`)) return;
    try {
      const client = new ContaboStorageManagerClient(endpoint, authToken);
      await client.delete(name);
      setProjects((prev) => prev.filter((p) => p.name !== name));
    } catch (error) {
      setListError((error as Error).message);
    }
  }, [endpoint, authToken]);

  const fmtDate = (ts: number) => {
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return '';
    }
  };

  return (
    <div className="storage-row">
      <div className="storage-config">
        <label>
          Auth token (optional)
          <input
            type="password"
            placeholder="Bearer token or API key"
            value={authToken}
            onChange={(e) => onAuthTokenChange(e.target.value)}
          />
        </label>
      </div>

      <div className="storage-actions">
        <label>
          Project name
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => onSaveRemote(endpoint, authToken, projectName)}
          disabled={isRemoteSaving || isRemoteLoading}
        >
          {isRemoteSaving ? 'Saving…' : 'Save remote'}
        </button>
        <button
          type="button"
          onClick={() => onLoadRemote(endpoint, authToken, projectName)}
          disabled={isRemoteLoading || isRemoteSaving}
        >
          {isRemoteLoading ? 'Loading…' : 'Load remote'}
        </button>
        <button type="button" onClick={fetchProjects} disabled={loading || isRemoteLoading || isRemoteSaving}>
          {loading ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>

      {isRemoteLoading && (
        <div className="storage-load-progress">
          <ProgressBar
            stage={remoteLoadStage}
            progress={remoteLoadProgress}
            indeterminate={remoteLoadIndeterminate}
          />
        </div>
      )}

      {listError && <p className="storage-error">{listError}</p>}

      {remoteUploadItems.length > 0 && (
        <div className="storage-upload-list">
          <h3>{isRemoteSaving ? 'Uploading source media' : 'Last upload summary'}</h3>
          <ul>
            {remoteUploadItems.map((item) => {
              const percent = Math.round(item.progress * 100);
              return (
                <li key={item.clipId} className={`upload-state-${item.status}`}>
                  <span className="upload-item-name">
                    Clip {item.index}/{item.total}: {item.fileName}
                  </span>
                  <span className="upload-item-status">
                    {item.status === 'uploading'
                      ? `Uploading (${percent}%)`
                      : item.status === 'uploaded'
                      ? 'Uploaded (100%)'
                      : item.status === 'failed'
                      ? 'Failed'
                      : item.status === 'skipped'
                      ? 'Skipped'
                      : 'Pending'}
                  </span>
                  {item.error && (item.status === 'failed' || item.status === 'skipped') && (
                    <span className="upload-item-error">{item.error}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pendingRemoteUploadError && (
        <div className="storage-upload-error-actions" role="alert">
          <p>
            Upload failed for clip {pendingRemoteUploadError.index}/{pendingRemoteUploadError.total}:{' '}
            {pendingRemoteUploadError.fileName}
          </p>
          <p className="storage-upload-error-detail">{pendingRemoteUploadError.error}</p>
          <div className="storage-upload-error-buttons">
            <button type="button" onClick={() => onResolveRemoteUploadError('retry')}>Retry this file</button>
            <button type="button" onClick={() => onResolveRemoteUploadError('skip')}>Skip and continue</button>
            <button type="button" onClick={() => onResolveRemoteUploadError('abort')}>Cancel save</button>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div className="storage-project-list">
          <h3>Saved projects</h3>
          <ul>
            {projects.map((p) => (
              <li
                key={p.name}
                className={p.name === projectName ? 'selected' : ''}
                onClick={() => setProjectName(p.name)}
                title="Click to select"
              >
                <span className="project-name">{p.name}</span>
                <span className="project-date">{fmtDate(p.modified)}</span>
                <button
                  type="button"
                  className="project-delete-btn"
                  disabled={isRemoteLoading || isRemoteSaving}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.name);
                  }}
                  title="Delete project"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {projects.length === 0 && !loading && !listError && endpoint && (
        <p className="storage-hint">No saved projects found. Click "Refresh list" after saving.</p>
      )}
    </div>
  );
}
