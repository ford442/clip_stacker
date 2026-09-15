import { type SyntheticEvent } from 'react';
import type { Clip, ClipAnimatableProp, ClipKeyframes } from '../../types';
import { clipHasKeyframes } from '../../utils/animatedLayout';
import {
  layoutNormToPixelValue,
  layoutPixelToNormValue,
  type CanvasSize,
} from '../../utils/overlayCoords';
import { getClipDuration } from '../../utils/project';
import type { PipCorner } from '../../utils/pipPreset';
import { KeyframeMiniEditor } from '../KeyframeMiniEditor';
import { DEFAULT_LAYOUT_VALUES, KEN_BURNS_PROPS, parseNumber, PIP_KEYFRAME_PROPS } from './helpers';
import type { ClipValues } from './types';

interface InspectorClipVideoToolsSectionProps {
  clip: Clip;
  values: ClipValues;
  clipLocalTime: number;
  layoutCanvas: CanvasSize;
  isOverlay: boolean;
  overlayOffCanvas: boolean;
  hasAdvancedLayout: boolean;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  pipCorner: PipCorner;
  setPipCorner: (corner: PipCorner) => void;
  activeKeyframeProp: ClipAnimatableProp;
  setActiveKeyframeProp: (prop: ClipAnimatableProp) => void;
  rifeMultiplier: 2 | 4;
  setRifeMultiplier: (value: 2 | 4) => void;
  rifeProcessing: boolean;
  stabilizeStatus: string | null;
  update: (field: keyof ClipValues, value: string) => void;
  applyPipPreset: (corner: PipCorner) => void;
  applyLogoPreset: (corner: PipCorner) => void;
  useAsBaseLayer: () => void;
  onStabilizeChange?: (enabled: boolean) => void;
  onRife?: (mode: 'interpolation' | 'boomerang', multiplier: 2 | 4) => void;
  onKeyframesChange?: (keyframes: ClipKeyframes | undefined) => void;
  onApplyKenBurns?: () => void;
}

export function InspectorClipVideoToolsSection({
  clip,
  values,
  clipLocalTime,
  layoutCanvas,
  isOverlay,
  overlayOffCanvas,
  hasAdvancedLayout,
  advancedOpen,
  setAdvancedOpen,
  pipCorner,
  setPipCorner,
  activeKeyframeProp,
  setActiveKeyframeProp,
  rifeMultiplier,
  setRifeMultiplier,
  rifeProcessing,
  stabilizeStatus,
  update,
  applyPipPreset,
  applyLogoPreset,
  useAsBaseLayer,
  onStabilizeChange,
  onRife,
  onKeyframesChange,
  onApplyKenBurns,
}: InspectorClipVideoToolsSectionProps) {
  if (clip.kind !== 'video') return null;

  return (
    <>
      {onStabilizeChange && (
        <div className="inspector-stabilize">
          <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>
            Stabilization
          </div>
          <label
            className="inspector-checkbox-label"
            title="Remove camera shake by tracking features between frames and smoothing the camera path. Analysis runs once per clip in the background."
          >
            <input
              type="checkbox"
              checked={Boolean(clip.stabilize)}
              onChange={(e) => onStabilizeChange(e.target.checked)}
            />
            Stabilize this clip
          </label>
          {clip.stabilize && stabilizeStatus && (
            <p className={`inspector-hint${clip.stabilizeError ? ' is-error' : ''}`}>
              {stabilizeStatus}
            </p>
          )}
        </div>
      )}
      {onRife && (
        <>
          <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Frame interpolation (RIFE)</div>
          {clip.rifeProcessed && (
            <div className="rife-badge" style={{ marginBottom: '0.5rem' }}>
              {clip.rifeMode === 'boomerang' ? '🔁 Boomerang' : `✨ RIFE ${clip.rifeMultiplier ?? 2}×`}
              {clip.processedFps ? ` · ${clip.processedFps.toFixed(1)} fps` : ''}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <label style={{ margin: 0 }}>
              Multiplier
              <select
                value={rifeMultiplier}
                onChange={(e) => setRifeMultiplier(Number(e.target.value) as 2 | 4)}
                style={{ marginLeft: '0.4rem' }}
                disabled={rifeProcessing}
              >
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onRife('interpolation', rifeMultiplier)}
              disabled={rifeProcessing}
              title={`Apply RIFE ${rifeMultiplier}× frame interpolation to this clip (per-clip, before merging)`}
            >
              {rifeProcessing ? '⏳ Processing…' : `✨ Smoother (${rifeMultiplier}×)`}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onRife('boomerang', rifeMultiplier)}
              disabled={rifeProcessing}
              title="Apply Boomerang (loop forward+reverse) with RIFE frame interpolation"
            >
              {rifeProcessing ? '⏳ Processing…' : '🔁 Boomerang'}
            </button>
          </div>
          <p className="inspector-hint">
            RIFE processes this clip individually (after trim, before merge) to avoid
            artifacts across scene cuts. The clip in the library will be replaced with
            the processed version.
          </p>
        </>
      )}
      <div className="inspector-pip-actions">
        <div className="inspector-pip-header">
          <strong>Picture-in-Picture</strong>
          <span className={isOverlay ? 'inspector-pip-badge is-overlay' : 'inspector-pip-badge'}>
            {isOverlay ? `Overlay • layer ${parseNumber(values.layerIndex, 1)}` : 'Base layer'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => applyPipPreset(pipCorner)}
            title="Composite this clip on top of the base video as a Picture-in-Picture overlay, sized and positioned in the chosen corner."
          >
            🖼 {isOverlay ? 'Reposition overlay' : 'Use as overlay (PiP)'}
          </button>
          <label
            className="inspector-inline-label"
            title="Corner of the canvas the overlay snaps to."
          >
            Corner
            <select
              value={pipCorner}
              onChange={(e) => {
                const corner = e.target.value as PipCorner;
                setPipCorner(corner);
                if (isOverlay) applyPipPreset(corner);
              }}
            >
              <option value="top-left">Top left</option>
              <option value="top-right">Top right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="bottom-right">Bottom right</option>
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => applyLogoPreset(pipCorner)}
            title="Channel bug: snap this clip to the chosen corner at ~10% of the canvas width, locked to its own aspect ratio, keyed on its alpha channel and muted."
          >
            ◹ Use as channel logo
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={useAsBaseLayer}
            disabled={!isOverlay}
            title="Return this clip to the base layer so it plays full-frame in sequence."
          >
            ⤢ Use as base layer
          </button>
        </div>
        <p className="inspector-hint">
          {isOverlay
            ? 'This clip is composited on top of the base video. Fine-tune the size, position and opacity below.'
            : 'Overlay this clip as a small window on top of the base video. You can fine-tune the size, position and opacity afterwards.'}
          {' '}
          Channel logo keeps the source transparency, so a PNG / WebP / WebM+alpha mark
          composites without a black box.
        </p>
      </div>
      <details
        className="inspector-disclosure"
        open={hasAdvancedLayout || advancedOpen}
        onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => {
          if (hasAdvancedLayout) return;
          setAdvancedOpen(e.currentTarget.open);
        }}
      >
        <summary>
          Picture-in-Picture layout (advanced){hasAdvancedLayout ? ' • active' : ''}
        </summary>
        <div className="inspector-disclosure-content">
          <label title="0 = base layer (sequential concatenation). 1 or higher = Picture-in-Picture overlay on top of the base video.">
            Layer index (0 = base, 1+ = overlay)
            <input
              type="number"
              min="0"
              step="1"
              value={values.layerIndex}
              onChange={(e) => update('layerIndex', e.target.value)}
            />
          </label>
          <label title="Horizontal position of the overlay in pixels from the left edge of the canvas.">
            X offset (px)
            <input
              type="number"
              step="1"
              value={values.x}
              onChange={(e) => update('x', e.target.value)}
            />
          </label>
          <label title="Vertical position of the overlay in pixels from the top edge of the canvas.">
            Y offset (px)
            <input
              type="number"
              step="1"
              value={values.y}
              onChange={(e) => update('y', e.target.value)}
            />
          </label>
          <label title="Width of the overlay in pixels. Enter 0 to keep the clip's original width.">
            Width (px, 0=auto)
            <input
              type="number"
              min="0"
              step="1"
              value={values.width}
              onChange={(e) => update('width', e.target.value)}
            />
          </label>
          <label title="Height of the overlay in pixels. Enter 0 to keep the clip's original height.">
            Height (px, 0=auto)
            <input
              type="number"
              min="0"
              step="1"
              value={values.height}
              onChange={(e) => update('height', e.target.value)}
            />
          </label>
          {overlayOffCanvas && (
            <p className="inspector-warning">
              ⚠ This overlay is positioned fully off-canvas and won't be visible in the
              render. Adjust the X/Y offsets so it overlaps the canvas.
            </p>
          )}
          {isOverlay && (
            <label title="Opacity of the overlay from 0.0 (transparent) to 1.0 (fully opaque).">
              Opacity (0–1)
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={values.opacity}
                onChange={(e) => update('opacity', e.target.value)}
              />
            </label>
          )}
          {isOverlay && (
            <label title="How this overlay is keyed against the layers below it. Source alpha uses the transparency already in the file (PNG / WebP / WebM+alpha); chroma and luma derive it from the picture.">
              Transparency
              <select
                value={values.overlayBlend || 'source-alpha'}
                onChange={(e) => update('overlayBlend', e.target.value)}
              >
                <option value="source-alpha">Source alpha (PNG / WebM+alpha)</option>
                <option value="premultiplied">Source alpha (premultiplied)</option>
                <option value="chroma">Chroma key</option>
                <option value="luma">Luma key (black is transparent)</option>
                <option value="opaque">Opaque rectangle</option>
              </select>
            </label>
          )}
          {isOverlay &&
            (values.overlayBlend === 'chroma' || values.overlayBlend === 'luma') && (
              <>
                {values.overlayBlend === 'chroma' && (
                  <label title="Colour keyed out of the overlay.">
                    Key colour
                    <input
                      type="color"
                      value={values.chromaColor}
                      onChange={(e) => update('chromaColor', e.target.value)}
                    />
                  </label>
                )}
                <label title="How close a pixel must be to the key before it becomes transparent.">
                  Key similarity (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={values.chromaSimilarity}
                    onChange={(e) => update('chromaSimilarity', e.target.value)}
                  />
                </label>
                <label title="Softness of the edge between kept and keyed pixels.">
                  Key blend (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={values.chromaBlend}
                    onChange={(e) => update('chromaBlend', e.target.value)}
                  />
                </label>
              </>
            )}
          {parseNumber(values.layerIndex, 0) === 0 &&
            parseNumber(values.opacity, 1) !== DEFAULT_LAYOUT_VALUES.opacity && (
              <p className="inspector-hint">
                Opacity only applies to overlay layers (layer index 1+) and is ignored for the
                base layer.
              </p>
            )}
        </div>
      </details>
      {onKeyframesChange && (
        <details
          className="inspector-disclosure"
          open={clip.stillImage || clipHasKeyframes(clip) || parseNumber(values.layerIndex, 0) > 0}
        >
          <summary>
            Keyframe animation
            {clipHasKeyframes(clip) ? ' • active' : ''}
          </summary>
          <div className="inspector-disclosure-content">
            {clip.stillImage && (
              <>
                <p className="inspector-hint">
                  Still image clip — use Ken Burns for pan/zoom, or animate layout on overlay
                  layers.
                </p>
                {onApplyKenBurns && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={onApplyKenBurns}
                  >
                    Apply Ken Burns preset
                  </button>
                )}
              </>
            )}
            <label className="kf-prop-picker">
              Property
              <select
                value={activeKeyframeProp}
                onChange={(e) =>
                  setActiveKeyframeProp(e.target.value as ClipAnimatableProp)
                }
              >
                {(clip.stillImage
                  ? [...PIP_KEYFRAME_PROPS, ...KEN_BURNS_PROPS]
                  : PIP_KEYFRAME_PROPS
                ).map((item) => (
                  <option key={item.prop} value={item.prop}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            {(() => {
              const meta =
                [...PIP_KEYFRAME_PROPS, ...KEN_BURNS_PROPS].find(
                  (item) => item.prop === activeKeyframeProp,
                ) ?? PIP_KEYFRAME_PROPS[0];
              const isLayoutProp =
                activeKeyframeProp === 'x' ||
                activeKeyframeProp === 'y' ||
                activeKeyframeProp === 'width' ||
                activeKeyframeProp === 'height';
              const baseDefault =
                typeof meta.defaultValue === 'function'
                  ? meta.defaultValue(clip)
                  : meta.defaultValue;
              const defaultValue = isLayoutProp
                ? layoutNormToPixelValue(
                    activeKeyframeProp,
                    baseDefault,
                    layoutCanvas,
                  )
                : baseDefault;
              const displayKeyframes = isLayoutProp
                ? clip.keyframes?.[activeKeyframeProp]?.map((key) => ({
                    ...key,
                    value: layoutNormToPixelValue(
                      activeKeyframeProp,
                      key.value,
                      layoutCanvas,
                    ),
                  }))
                : clip.keyframes?.[activeKeyframeProp];
              return (
                <KeyframeMiniEditor
                  label={meta.label}
                  duration={getClipDuration(clip)}
                  currentTime={clipLocalTime}
                  keyframes={displayKeyframes}
                  defaultValue={defaultValue}
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  onChange={(track) => {
                    const next: ClipKeyframes = { ...(clip.keyframes ?? {}) };
                    const storedTrack = isLayoutProp
                      ? track?.map((key) => ({
                          ...key,
                          value: layoutPixelToNormValue(
                            activeKeyframeProp,
                            key.value,
                            layoutCanvas,
                          ),
                        }))
                      : track;
                    if (storedTrack?.length) next[activeKeyframeProp] = storedTrack;
                    else delete next[activeKeyframeProp];
                    onKeyframesChange(
                      Object.keys(next).length > 0 ? next : undefined,
                    );
                  }}
                />
              );
            })()}
          </div>
        </details>
      )}
    </>
  );
}
