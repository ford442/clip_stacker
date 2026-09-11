import { useEffect, useRef, useState } from "react";
import type { ClipTransition } from "../types";
import {
  MIN_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
} from "../utils/transitions";
import {
  listTransitionOptions,
  getTransitionDef,
  defaultTransitionParams,
} from "../webgpu/transitions/registry";
import {
  CUSTOM_TRANSITION_TYPE,
  DEFAULT_CUSTOM_EXPRESSION,
  MAX_CUSTOM_EXPRESSION_LENGTH,
  compileCustomTransition,
  validateCustomExpression,
} from "../webgpu/transitions/customShader";
import { peekGpuDevice } from "../webgpu/gpuDevice";
import { MORPH_TRANSITION_TYPE } from "../utils/morphTransition";

interface Props {
  transition: ClipTransition;
  clipATitle: string;
  clipBTitle: string;
  onUpdate: (updated: ClipTransition) => void;
  onClose: () => void;
  morphProcessing?: boolean;
}

const MORPH_OPTION = {
  value: MORPH_TRANSITION_TYPE,
  label: "Morph (RIFE)",
  description:
    "RIFE optical-flow in-betweens from clip A's last frame to clip B's first frame",
};

const TRANSITION_OPTIONS = [
  { value: "none", label: "Cut", description: "Hard cut — no overlap" },
  MORPH_OPTION,
  ...listTransitionOptions(),
];

export function TransitionEditor({
  transition,
  clipATitle,
  clipBTitle,
  onUpdate,
  onClose,
  morphProcessing = false,
}: Props) {
  const [type, setType] = useState(transition.type);
  const [duration, setDuration] = useState(transition.duration);
  const [params, setParams] = useState<Record<string, number>>(
    transition.params ?? {},
  );
  const [customShader, setCustomShader] = useState(
    transition.customShader ?? DEFAULT_CUSTOM_EXPRESSION,
  );
  const [shaderError, setShaderError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const activeDef = type !== "none" ? getTransitionDef(type) : undefined;
  const paramDefs = activeDef?.params ?? [];

  useEffect(() => {
    setType(transition.type);
    setDuration(transition.duration);
    setParams(transition.params ?? {});
    setCustomShader(transition.customShader ?? DEFAULT_CUSTOM_EXPRESSION);
  }, [transition]);

  /**
   * Validate the WGSL out of band: the static check runs immediately, then a
   * debounced sandboxed compile on the shared device (when one already exists)
   * surfaces the driver's own diagnostics. The compiled module is discarded —
   * the render path builds its own pipeline.
   */
  useEffect(() => {
    if (type !== CUSTOM_TRANSITION_TYPE) {
      setShaderError(null);
      return;
    }
    const staticCheck = validateCustomExpression(customShader);
    if (!staticCheck.ok) {
      setShaderError(staticCheck.error ?? "Invalid expression.");
      return;
    }
    setShaderError(null);
    const device = peekGpuDevice();
    if (!device) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void compileCustomTransition(device, customShader).then((res) => {
        if (cancelled) return;
        setShaderError(res.ok ? null : (res.error ?? "WGSL compilation failed."));
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type, customShader]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const buildUpdated = (
    nextType: string,
    nextDuration: number,
    nextParams: Record<string, number>,
    nextShader: string = customShader,
  ): ClipTransition => {
    const def = nextType !== "none" ? getTransitionDef(nextType) : undefined;
    const mergedParams = def
      ? { ...defaultTransitionParams(def), ...nextParams }
      : undefined;
    const clearingMorph =
      transition.morphSegment?.objectUrl &&
      nextType !== MORPH_TRANSITION_TYPE;
    if (clearingMorph) {
      URL.revokeObjectURL(transition.morphSegment!.objectUrl);
    }
    return {
      ...transition,
      type: nextType,
      duration: nextDuration,
      ...(nextType === MORPH_TRANSITION_TYPE
        ? {}
        : { morphSegment: undefined }),
      ...(mergedParams && Object.keys(mergedParams).length > 0
        ? { params: mergedParams }
        : { params: undefined }),
      ...(nextType === CUSTOM_TRANSITION_TYPE
        ? { customShader: nextShader }
        : { customShader: undefined }),
    };
  };

  const handleTypeChange = (newType: string) => {
    setType(newType);
    const def = newType !== "none" ? getTransitionDef(newType) : undefined;
    const nextParams = def ? defaultTransitionParams(def) : {};
    setParams(nextParams);
    onUpdate(buildUpdated(newType, duration, nextParams));
  };

  const handleDurationChange = (rawValue: string) => {
    const v = parseFloat(rawValue);
    if (isNaN(v)) return;
    const clamped = Math.max(
      MIN_TRANSITION_DURATION,
      Math.min(MAX_TRANSITION_DURATION, v),
    );
    setDuration(clamped);
    onUpdate(buildUpdated(type, clamped, params));
  };

  const handleCustomShaderChange = (value: string) => {
    setCustomShader(value);
    // Push every keystroke: an invalid expression falls back to a dissolve in
    // the preview rather than throwing, so live editing stays safe.
    onUpdate(buildUpdated(type, duration, params, value));
  };

  const handleParamChange = (key: string, rawValue: string) => {
    const v = parseFloat(rawValue);
    if (isNaN(v)) return;
    const def = paramDefs.find((p) => p.key === key);
    const clamped = def
      ? Math.max(def.min, Math.min(def.max, v))
      : v;
    const nextParams = { ...params, [key]: clamped };
    setParams(nextParams);
    onUpdate(buildUpdated(type, duration, nextParams));
  };

  const adjust = (delta: number) => {
    handleDurationChange(String(Math.round((duration + delta) * 10) / 10));
  };

  const morphStatus = transition.morphSegment?.status;
  const morphHint =
    type === MORPH_TRANSITION_TYPE
      ? morphProcessing || morphStatus === "generating"
        ? "Generating morph frames on RIFE…"
        : morphStatus === "ready"
          ? "Morph segment ready — plays during the overlap window."
          : morphStatus === "failed"
            ? transition.morphSegment?.error ??
              "Morph failed — preview uses a dissolve until you retry."
            : "Morph will generate when you apply this transition."
      : TRANSITION_OPTIONS.find((o) => o.value === type)?.description;

  return (
    <div
      className="transition-editor-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Edit transition"
    >
      <div className="transition-editor-popup">
        <div className="te-header">
          <span className="te-title">Transition</span>
          <button
            type="button"
            className="te-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="te-clips">
          <span className="te-clip-name">{clipATitle}</span>
          <span className="te-arrow">→</span>
          <span className="te-clip-name">{clipBTitle}</span>
        </div>

        <div className="te-field-group">
          <label className="te-label">Type</label>
          <div className="te-type-options te-type-options-scroll">
            {TRANSITION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`te-type-btn${type === opt.value ? " active" : ""}`}
                onClick={() => handleTypeChange(opt.value)}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {type !== "none" && (
          <div className="te-field-group">
            <label className="te-label">Duration (s)</label>
            <div className="te-duration-row">
              <button
                type="button"
                className="te-step-btn"
                onClick={() => adjust(-0.1)}
              >
                −
              </button>
              <input
                type="number"
                className="te-duration-input"
                min={MIN_TRANSITION_DURATION}
                max={MAX_TRANSITION_DURATION}
                step="0.1"
                value={duration}
                onChange={(e) => handleDurationChange(e.target.value)}
              />
              <button
                type="button"
                className="te-step-btn"
                onClick={() => adjust(0.1)}
              >
                +
              </button>
            </div>
          </div>
        )}

        {type === CUSTOM_TRANSITION_TYPE && (
          <div className="te-field-group">
            <label className="te-label" htmlFor="te-custom-shader">
              WGSL expression
            </label>
            <textarea
              id="te-custom-shader"
              className={`te-shader-input${shaderError ? " invalid" : ""}`}
              spellCheck={false}
              rows={4}
              maxLength={MAX_CUSTOM_EXPRESSION_LENGTH}
              value={customShader}
              onChange={(e) => handleCustomShaderChange(e.target.value)}
              aria-label="Custom transition WGSL expression"
              aria-invalid={shaderError ? true : undefined}
              aria-describedby={shaderError ? "te-shader-error" : undefined}
            />
            <p className="te-shader-help">
              One expression returning <code>vec4&lt;f32&gt;</code>. Available:{" "}
              <code>uv</code>, <code>u.progress</code>, <code>u.custom0-3</code>,{" "}
              <code>sampleFrom()</code>, <code>sampleTo()</code>,{" "}
              <code>sampleMaskLuma()</code>.
            </p>
            {shaderError && (
              <p className="te-shader-error" id="te-shader-error" role="alert">
                {shaderError}
              </p>
            )}
          </div>
        )}

        {type !== "none" &&
          paramDefs.map((param) => (
            <div className="te-field-group" key={param.key}>
              <label className="te-label">{param.label}</label>
              <input
                type="number"
                className="te-duration-input"
                min={param.min}
                max={param.max}
                step={param.step ?? 0.1}
                value={params[param.key] ?? param.default}
                onChange={(e) => handleParamChange(param.key, e.target.value)}
              />
            </div>
          ))}

        <p className="te-hint">{morphHint}</p>
      </div>
    </div>
  );
}
