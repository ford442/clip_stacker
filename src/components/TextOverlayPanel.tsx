import { useState } from "react";
import type { TextOverlay } from "../types";

interface Props {
  overlays: TextOverlay[];
  onAdd: () => void;
  onUpdate: (overlay: TextOverlay) => void;
  onDelete: (id: string) => void;
}

export function TextOverlayPanel({
  overlays,
  onAdd,
  onUpdate,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleToggleEdit = (id: string) => {
    setEditingId((prev) => (prev === id ? null : id));
  };

  const set = (
    overlay: TextOverlay,
    field: keyof TextOverlay,
    value: string | number | boolean,
  ) => {
    onUpdate({ ...overlay, [field]: value });
  };

  return (
    <section className="panel tol-panel">
      <div className="tol-header">
        <h2>Text Overlays</h2>
        <button
          type="button"
          className="btn-secondary tol-add-btn"
          onClick={onAdd}
        >
          + Add Text
        </button>
      </div>

      {overlays.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
          No text overlays yet. Click <strong>+ Add Text</strong> to create a
          news ticker or caption that will be burned into the exported video.
        </p>
      ) : (
        <div className="tol-list">
          {overlays.map((overlay) => (
            <div key={overlay.id} className="tol-item">
              <div className="tol-item-row">
                <span className="tol-item-icon" aria-hidden="true">
                  T
                </span>
                <span className="tol-item-text" title={overlay.text}>
                  {overlay.text || <em>(empty)</em>}
                </span>
                <span className="tol-item-meta">
                  {overlay.scrolling ? "↔ ticker" : "📍 static"} ·{" "}
                  {overlay.fontsize}px
                </span>
                <button
                  type="button"
                  className={`tol-edit-btn${editingId === overlay.id ? " active" : ""}`}
                  onClick={() => handleToggleEdit(overlay.id)}
                >
                  {editingId === overlay.id ? "Close" : "Edit"}
                </button>
                <button
                  type="button"
                  className="tol-delete-btn"
                  title="Remove this text overlay"
                  onClick={() => {
                    onDelete(overlay.id);
                    if (editingId === overlay.id) setEditingId(null);
                  }}
                >
                  ✕
                </button>
              </div>

              {editingId === overlay.id && (
                <div className="tol-edit-form">
                  <label>
                    Text
                    <textarea
                      className="tol-textarea"
                      rows={2}
                      value={overlay.text}
                      onChange={(e) => set(overlay, "text", e.target.value)}
                      placeholder="Enter your caption or ticker text"
                    />
                  </label>

                  <div className="tol-row-2">
                    <label>
                      Font size (px)
                      <input
                        type="number"
                        min="8"
                        max="200"
                        step="1"
                        value={overlay.fontsize}
                        onChange={(e) =>
                          set(overlay, "fontsize", Number(e.target.value))
                        }
                      />
                    </label>
                    <label title="Any FFmpeg color: 'white', 'yellow', '#ffcc00'">
                      Font color
                      <div className="tol-color-row">
                        <input
                          type="color"
                          className="tol-color-swatch"
                          value={
                            overlay.fontcolor.startsWith("#")
                              ? overlay.fontcolor
                              : "#ffffff"
                          }
                          onChange={(e) =>
                            set(overlay, "fontcolor", e.target.value)
                          }
                        />
                        <input
                          type="text"
                          value={overlay.fontcolor}
                          onChange={(e) =>
                            set(overlay, "fontcolor", e.target.value)
                          }
                          placeholder="white"
                        />
                      </div>
                    </label>
                  </div>

                  <div
                    className="inspector-group-label"
                    style={{ marginTop: "0.5rem" }}
                  >
                    Mode
                  </div>
                  <div className="tol-mode-row">
                    <label className="tol-radio-label">
                      <input
                        type="radio"
                        name={`mode-${overlay.id}`}
                        checked={!overlay.scrolling}
                        onChange={() => set(overlay, "scrolling", false)}
                      />
                      Static
                    </label>
                    <label className="tol-radio-label">
                      <input
                        type="radio"
                        name={`mode-${overlay.id}`}
                        checked={overlay.scrolling}
                        onChange={() => set(overlay, "scrolling", true)}
                      />
                      Scrolling ticker
                    </label>
                  </div>

                  <div className="tol-row-2">
                    {!overlay.scrolling && (
                      <label title="X position in pixels from left edge">
                        X offset (px)
                        <input
                          type="number"
                          step="1"
                          value={overlay.x}
                          onChange={(e) =>
                            set(overlay, "x", Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                    <label title="Y position in pixels from top (e.g. 670 for near-bottom in 720p)">
                      Y offset (px)
                      <input
                        type="number"
                        step="1"
                        value={overlay.y}
                        onChange={(e) =>
                          set(overlay, "y", Number(e.target.value))
                        }
                      />
                    </label>
                    {overlay.scrolling && (
                      <label title="Scroll speed in pixels per second">
                        Speed (px/s)
                        <input
                          type="number"
                          min="10"
                          max="1000"
                          step="10"
                          value={overlay.scrollSpeed}
                          onChange={(e) =>
                            set(overlay, "scrollSpeed", Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                  </div>

                  <div
                    className="inspector-group-label"
                    style={{ marginTop: "0.5rem" }}
                  >
                    Background Box
                  </div>
                  <label className="tol-checkbox-label">
                    <input
                      type="checkbox"
                      checked={overlay.box}
                      onChange={(e) => set(overlay, "box", e.target.checked)}
                    />
                    Show background box
                  </label>
                  {overlay.box && (
                    <label title="Box color with optional alpha, e.g. 'black@0.5' or '0x000000@0.8'">
                      Box color
                      <input
                        type="text"
                        value={overlay.boxColor}
                        onChange={(e) =>
                          set(overlay, "boxColor", e.target.value)
                        }
                        placeholder="black@0.5"
                      />
                    </label>
                  )}

                  <p className="inspector-hint" style={{ marginTop: "0.5rem" }}>
                    Font: Roboto Regular (loaded automatically from CDN). For
                    1280×720 output, Y=670 places text near the bottom.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
