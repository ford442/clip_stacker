import { useState, useCallback, useRef } from "react";
import { ContaboStorageManagerClient } from "../utils/project";
import { ProgressBar } from "./ProgressBar";

interface Props {
  endpoint: string;
  authToken: string;
  onAuthTokenChange: (value: string) => void;
  onSaveRemote: (
    endpoint: string,
    authToken: string,
    projectName: string,
  ) => void;
  onLoadRemote: (
    endpoint: string,
    authToken: string,
    projectName: string,
  ) => void;
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
    status: "pending" | "uploading" | "uploaded" | "failed" | "skipped";
    error?: string;
    chunkIndex?: number;
    chunkTotal?: number;
  }[];
  pendingRemoteUploadError: {
    fileName: string;
    index: number;
    total: number;
    error: Error;
  } | null;
  onResolveRemoteUploadError: (action: "retry" | "skip" | "abort") => void;
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
  const [projectName, setProjectName] = useState("default-project");
  const [projects, setProjects] = useState<
    { name: string; modified: number }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  const selectProject = useCallback((name: string) => {
    setProjectName(name);
    projectNameInputRef.current?.focus();
  }, []);

  const handleLoadSelected = useCallback(() => {
    onLoadRemote(endpoint, authToken, projectName);
  }, [endpoint, authToken, onLoadRemote, projectName]);

  const fetchProjects = useCallback(async () => {
    if (!endpoint) {
      setListError("Enter an endpoint URL first.");
      return;
    }
    setLoading(true);
    setListError("");
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

  const handleDelete = useCallback(
    async (name: string) => {
      if (!confirm(`Delete project "${name}"?`)) return;
      try {
        const client = new ContaboStorageManagerClient(endpoint, authToken);
        await client.delete(name);
        setProjects((prev) => prev.filter((p) => p.name !== name));
      } catch (error) {
        setListError((error as Error).message);
      }
    },
    [endpoint, authToken],
  );

  const fmtDate = (ts: number) => {
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return "";
    }
  };

  return (
    <div className="storage-row">
      <form
        className="storage-config"
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          Auth token (optional)
          <input
            type="password"
            name="authToken"
            autoComplete="off"
            placeholder="Bearer token or API key"
            value={authToken}
            onChange={(e) => onAuthTokenChange(e.target.value)}
          />
        </label>
        {authToken && (
          <button
            type="button"
            className="storage-token-clear-btn"
            title="Clear the saved auth token"
            onClick={() => onAuthTokenChange("")}
          >
            Clear token
          </button>
        )}
        <p className="storage-hint">
          The auth token is saved for this browser tab session only and is
          cleared when you close the tab.
        </p>
      </form>

      <div className="storage-actions">
        <label>
          Project name
          <input
            ref={projectNameInputRef}
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
          {isRemoteSaving ? "Saving…" : "Save remote"}
        </button>
        <button
          type="button"
          onClick={handleLoadSelected}
          disabled={isRemoteLoading || isRemoteSaving || !projectName.trim()}
        >
          {isRemoteLoading ? "Loading…" : "Load remote"}
        </button>
        <button
          type="button"
          onClick={fetchProjects}
          disabled={loading || isRemoteLoading || isRemoteSaving}
        >
          {loading ? "Refreshing…" : "Refresh list"}
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
          <h3>
            {isRemoteSaving ? "Uploading source media" : "Last upload summary"}
          </h3>
          <ul>
            {remoteUploadItems.map((item) => {
              const percent = Math.round(item.progress * 100);
              const chunkLabel =
                typeof item.chunkIndex === "number" &&
                typeof item.chunkTotal === "number"
                  ? ` · chunk ${item.chunkIndex + 1}/${item.chunkTotal}`
                  : "";
              return (
                <li key={item.clipId} className={`upload-state-${item.status}`}>
                  <span className="upload-item-name">
                    Clip {item.index}/{item.total}: {item.fileName}
                  </span>
                  <span className="upload-item-status">
                    {item.status === "uploading"
                      ? `Uploading (${percent}%${chunkLabel})`
                      : item.status === "uploaded"
                        ? "Uploaded (100%)"
                        : item.status === "failed"
                          ? "Failed"
                          : item.status === "skipped"
                            ? "Skipped"
                            : "Pending"}
                  </span>
                  {item.error &&
                    (item.status === "failed" || item.status === "skipped") && (
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
            Upload failed for clip {pendingRemoteUploadError.index}/
            {pendingRemoteUploadError.total}:{" "}
            {pendingRemoteUploadError.fileName}
          </p>
          <p className="storage-upload-error-detail">
            {typeof pendingRemoteUploadError.error === 'string' ? pendingRemoteUploadError.error : pendingRemoteUploadError.error.message}
          </p>
          <div className="storage-upload-error-buttons">
            <button
              type="button"
              onClick={() => onResolveRemoteUploadError("retry")}
            >
              Retry this file
            </button>
            <button
              type="button"
              onClick={() => onResolveRemoteUploadError("skip")}
            >
              Skip and continue
            </button>
            <button
              type="button"
              onClick={() => onResolveRemoteUploadError("abort")}
            >
              Cancel save
            </button>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <div className="storage-project-list">
          <h3>Saved projects</h3>
          <p className="storage-hint storage-project-hint">
            Click a project to select it for Load remote. Double-click to load immediately.
          </p>
          <ul role="listbox" aria-label="Saved remote projects">
            {projects.map((p) => {
              const isSelected = p.name === projectName;
              return (
              <li
                key={p.name}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                className={isSelected ? "selected" : ""}
                onClick={() => selectProject(p.name)}
                onDoubleClick={() => onLoadRemote(endpoint, authToken, p.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectProject(p.name);
                  }
                }}
                title={isSelected ? "Selected for Load remote" : "Click to select"}
              >
                <span className="project-name">{p.name}</span>
                <span className="project-date">{fmtDate(p.modified)}</span>
                {isSelected && (
                  <span className="project-selected-badge" aria-hidden="true">
                    Selected
                  </span>
                )}
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
            );
            })}
          </ul>
        </div>
      )}

      {projects.length === 0 && !loading && !listError && endpoint && (
        <p className="storage-hint">
          No saved projects found. Click "Refresh list" after saving.
        </p>
      )}
    </div>
  );
}
