import { useCallback, useState } from "react";
import { ContaboStorageManagerClient, type MediaLibraryItem } from "../utils/project";
import { formatBytes } from "../utils/memory";

interface Props {
  endpoint: string;
  authToken: string;
  onAddClip: (item: MediaLibraryItem) => Promise<void>;
}

export function MediaLibraryPanel({ endpoint, authToken, onAddClip }: Props) {
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [addingName, setAddingName] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    if (!endpoint) {
      setError("Enter an endpoint URL first.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const client = new ContaboStorageManagerClient(endpoint, authToken);
      const list = await client.listMedia();
      setItems(list);
    } catch (err) {
      setError((err as Error).message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint, authToken]);

  const handleAdd = useCallback(
    async (item: MediaLibraryItem) => {
      setAddingName(item.name);
      try {
        await onAddClip(item);
      } finally {
        setAddingName(null);
      }
    },
    [onAddClip],
  );

  const fmtDate = (ts?: number) => {
    if (!ts) return "";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch {
      return "";
    }
  };

  return (
    <div className="media-library">
      <div className="media-library-header">
        <h3>Media library</h3>
        <button type="button" onClick={fetchItems} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh list"}
        </button>
      </div>

      {error && <p className="storage-error">{error}</p>}

      {items.length === 0 && !loading && !error && (
        <p className="storage-hint">
          No remote media found yet. Clips uploaded via "Save remote" will
          appear here for reuse in other projects.
        </p>
      )}

      {items.length > 0 && (
        <ul className="media-library-list">
          {items.map((item) => (
            <li key={item.url}>
              <span className="media-library-name">{item.name}</span>
              <span className="media-library-meta">
                {item.size != null ? formatBytes(item.size) : ""}
                {item.size != null && item.modified ? " · " : ""}
                {fmtDate(item.modified)}
              </span>
              <button
                type="button"
                onClick={() => handleAdd(item)}
                disabled={addingName !== null}
              >
                {addingName === item.name ? "Adding…" : "Add to timeline"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
