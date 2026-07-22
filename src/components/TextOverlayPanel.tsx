import { useEffect, useRef, useState } from "react";
import { usePlayheadTime } from "../hooks/usePlayheadTime";
import type { TextAnimatableProp, TextOverlay, TextOverlayKeyframes } from "../types";
import { isValidFfmpegColor } from "../utils/color";
import {
  BUNDLED_FONTS,
  estimateScrollCrossingSeconds,
  getBundledFont,
  MIN_SCROLL_SPEED,
  MAX_SCROLL_SPEED,
} from "../utils/textOverlay";
import { TEXT_SHADERS, getTextShader, resolveShaderParams } from "../webgpu/text/registry";
import { textOverlayHasKeyframes } from "../utils/animatedLayout";
import { KeyframeMiniEditor } from "./KeyframeMiniEditor";

interface Props {
  overlays: TextOverlay[];
  totalDuration?: number;
  onAdd: () => string;
  onUpdate: (overlay: TextOverlay) => void;
  onDelete: (id: string) => void;
}

export function TextOverlayPanel({
  overlays,
  totalDuration = 60,
  onAdd,
  onUpdate,
  onDelete,
}: Props) {
  const previewGlobalTime = usePlayheadTime() ?? 0;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeKeyframeProp, setActiveKeyframeProp] =
    useState<TextAnimatableProp>("x");
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!editingId) return;
    const node = itemRefs.current[editingId];
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editingId, overlays.length]);

  const handleToggleEdit = (id: string) => {
    setEditingId((prev) => (prev === id ? null : id));
  };

  const handleAdd = () => {
    const id = onAdd();
    setEditingId(id);
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
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleAdd}
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
            <div
              key={overlay.id}
              ref={(node) => {
                itemRefs.current[overlay.id] = node;
              }}
              className="tol-item"
            >
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
                      {!isValidFfmpegColor(overlay.fontcolor) && (
                        <p className="inspector-warning">
                          ⚠ "{overlay.fontcolor}" isn't a color FFmpeg recognizes.
                          Use a named color (e.g. "white"), "#RRGGBB", or "0xRRGGBB".
                        </p>
                      )}
                    </label>
                  </div>

                  <label style={{ marginTop: "0.25rem" }}>
                    Font family
                    <select
                      value={overlay.font ?? "roboto"}
                      onChange={(e) => set(overlay, "font", e.target.value)}
                    >
                      {BUNDLED_FONTS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div style={{ marginTop: "0.25rem" }}>
                    <div className="inspector-group-label">Fill</div>
                    <div className="tol-mode-row">
                      <label className="tol-radio-label">
                        <input
                          type="radio"
                          name={`fill-${overlay.id}`}
                          checked={(overlay.fill ?? 'solid') === 'solid'}
                          onChange={() => onUpdate({ ...overlay, fill: 'solid', shaderId: undefined })}
                        />
                        Solid color
                      </label>
                      <label className="tol-radio-label">
                        <input
                          type="radio"
                          name={`fill-${overlay.id}`}
                          checked={overlay.fill === 'shader'}
                          onChange={() => onUpdate({ ...overlay, fill: 'shader', shaderId: overlay.shaderId || TEXT_SHADERS[0]?.id })}
                        />
                        Shader
                      </label>
                    </div>
                    {overlay.fill === 'shader' && (
                      <div style={{ marginTop: '0.25rem' }}>
                        <label>
                          Shader
                          <select
                            value={overlay.shaderId || TEXT_SHADERS[0]?.id || ''}
                            onChange={(e) => {
                              const id = e.target.value;
                              const nextParams = resolveShaderParams(id, overlay.shaderParams);
                              onUpdate({ ...overlay, shaderId: id, shaderParams: nextParams });
                            }}
                          >
                            {TEXT_SHADERS.map((s) => (
                              <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
                          </select>
                        </label>
                        {(() => {
                          const def = getTextShader(overlay.shaderId);
                          const params = def?.params ?? [];
                          if (!params.length) return null;
                          return (
                            <div style={{ marginTop: '0.25rem' }}>
                              {params.map((p) => {
                                const cur = (overlay.shaderParams && overlay.shaderParams[p.key]) ?? p.default;
                                return (
                                  <label key={p.key} style={{ display: 'block', marginBottom: '0.15rem' }}>
                                    {p.label}
                                    <input
                                      type="range"
                                      min={p.min ?? 0}
                                      max={p.max ?? 1}
                                      step={p.step ?? 0.01}
                                      value={cur}
                                      onChange={(e) => {
                                        const val = Number(e.target.value);
                                        const next = { ...(overlay.shaderParams || {}), [p.key]: val };
                                        onUpdate({ ...overlay, shaderParams: next });
                                      }}
                                    />
                                    <span style={{ marginLeft: '0.35rem', fontSize: '0.8em' }}>{cur.toFixed(2)}</span>
                                  </label>
                                );
                              })}
                            </div>
                          );
                        })()}
                        <p className="inspector-hint" style={{ marginTop: '0.2rem' }}>
                          Shader text uses WebGPU (preview + GPU export). FFmpeg path will use solid fallback.
                        </p>
                      </div>
                    )}
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
                      <label title="Scroll speed as a percentage of the screen width crossed per second. Resolution-independent: the same value crosses in the same time at any output size.">
                        Speed (% width/s)
                        <input
                          type="number"
                          min={MIN_SCROLL_SPEED}
                          max={MAX_SCROLL_SPEED}
                          step="1"
                          value={overlay.scrollSpeed}
                          onChange={(e) =>
                            set(overlay, "scrollSpeed", Number(e.target.value))
                          }
                        />
                        <span className="tol-scroll-time-hint">
                          ≈ {estimateScrollCrossingSeconds(overlay.scrollSpeed).toFixed(1)}s to cross
                        </span>
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
                      {!isValidFfmpegColor(overlay.boxColor) && (
                        <p className="inspector-warning">
                          ⚠ "{overlay.boxColor}" isn't a color FFmpeg recognizes.
                          Use a named color (e.g. "black@0.5"), "#RRGGBB", or
                          "0xRRGGBB", optionally with "@alpha".
                        </p>
                      )}
                    </label>
                  )}

                  <details
                    className="inspector-disclosure"
                    open={textOverlayHasKeyframes(overlay)}
                    style={{ marginTop: "0.5rem" }}
                  >
                    <summary>
                      Keyframe animation
                      {textOverlayHasKeyframes(overlay) ? " • active" : ""}
                    </summary>
                    <div className="inspector-disclosure-content">
                      <label className="kf-prop-picker">
                        Property
                        <select
                          value={activeKeyframeProp}
                          onChange={(e) =>
                            setActiveKeyframeProp(
                              e.target.value as TextAnimatableProp,
                            )
                          }
                        >
                          {!overlay.scrolling && (
                            <option value="x">X position</option>
                          )}
                          <option value="y">Y position</option>
                          <option value="opacity">Opacity</option>
                        </select>
                      </label>
                      <KeyframeMiniEditor
                        label={
                          activeKeyframeProp === "x"
                            ? "X position"
                            : activeKeyframeProp === "y"
                              ? "Y position"
                              : "Opacity"
                        }
                        duration={Math.max(totalDuration, 0.1)}
                        currentTime={previewGlobalTime}
                        keyframes={overlay.keyframes?.[activeKeyframeProp]}
                        defaultValue={
                          activeKeyframeProp === "x"
                            ? overlay.x
                            : activeKeyframeProp === "y"
                              ? overlay.y
                              : 1
                        }
                        min={activeKeyframeProp === "opacity" ? 0 : undefined}
                        max={activeKeyframeProp === "opacity" ? 1 : undefined}
                        step={activeKeyframeProp === "opacity" ? 0.05 : 1}
                        onChange={(track) => {
                          const next: TextOverlayKeyframes = {
                            ...(overlay.keyframes ?? {}),
                          };
                          if (track?.length) next[activeKeyframeProp] = track;
                          else delete next[activeKeyframeProp];
                          onUpdate({
                            ...overlay,
                            keyframes:
                              Object.keys(next).length > 0 ? next : undefined,
                          });
                        }}
                      />
                    </div>
                  </details>

                  <p className="inspector-hint" style={{ marginTop: "0.5rem" }}>
                    Font is burned in at export time. For 1280×720 output,
                    Y=670 places text near the bottom.
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
