import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DEFAULT_CURVES, type CurvesPass } from '../utils/finishing';
import {
  CURVE_CHANNELS,
  CURVE_MAX_POINTS,
  CURVE_PRESETS,
  DEFAULT_LEVELS,
  LEVELS_GAMMA_MAX,
  LEVELS_GAMMA_MIN,
  identityCurves,
  insertCurvePoint,
  isIdentityCurve,
  moveCurvePoint,
  normalizeCurvePoints,
  removeCurvePoint,
  sampleCurve,
  type CurveChannel,
  type CurvePoint,
  type LevelsSettings,
} from '../utils/curves';

interface Props {
  settings: CurvesPass;
  onChange: (settings: CurvesPass) => void;
}

const CHANNEL_LABEL: Record<CurveChannel, string> = {
  master: 'Master',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

const CHANNEL_STROKE: Record<CurveChannel, string> = {
  master: 'var(--text)',
  red: '#f87171',
  green: '#34d399',
  blue: '#60a5fa',
};

/** Editor box in SVG units; the curve lives in [0, 1]² mapped onto it. */
const SIZE = 200;
const PAD = 6;

const toSvgX = (x: number) => PAD + x * SIZE;
const toSvgY = (y: number) => PAD + (1 - y) * SIZE;

function SliderRow({
  label,
  title,
  min,
  max,
  step,
  value,
  display,
  onValue,
}: {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onValue: (v: number) => void;
}) {
  return (
    <label title={title}>
      {label} ({display})
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
    </label>
  );
}

function CurveEditor({
  channel,
  points,
  others,
  onPoints,
}: {
  channel: CurveChannel;
  points: CurvePoint[];
  /** Other channels' curves, drawn faintly for reference. */
  others: { channel: CurveChannel; points: CurvePoint[] }[];
  onPoints: (points: CurvePoint[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ index: number; points: CurvePoint[] } | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const toCurve = (e: PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = (SIZE + 2 * PAD) / rect.width;
    const sx = (e.clientX - rect.left) * scale;
    const sy = (e.clientY - rect.top) * scale;
    return { x: (sx - PAD) / SIZE, y: 1 - (sy - PAD) / SIZE };
  };

  const startDrag = (e: PointerEvent, index: number, pts: CurvePoint[]) => {
    dragRef.current = { index, points: pts };
    setActive(index);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (e.g. a synthetic event): drag without capture.
    }
  };

  const onBackgroundDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const { x, y } = toCurve(e);
    const inserted = insertCurvePoint(points, x, y);
    if (inserted.index < 0) return;
    onPoints(inserted.points);
    startDrag(e, inserted.index, inserted.points);
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = toCurve(e);
    const next = moveCurvePoint(drag.points, drag.index, x, y);
    drag.points = next;
    onPoints(next);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onKnotKey = (e: KeyboardEvent<SVGCircleElement>, index: number) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const p = points[index];
    let next: CurvePoint[] | null = null;
    if (e.key === 'ArrowUp') next = moveCurvePoint(points, index, p.x, p.y + step);
    else if (e.key === 'ArrowDown') next = moveCurvePoint(points, index, p.x, p.y - step);
    else if (e.key === 'ArrowRight') next = moveCurvePoint(points, index, p.x + step, p.y);
    else if (e.key === 'ArrowLeft') next = moveCurvePoint(points, index, p.x - step, p.y);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      next = removeCurvePoint(points, index);
      setActive(null);
    }
    if (next) {
      e.preventDefault();
      onPoints(next);
    }
  };

  const path = (pts: CurvePoint[]) =>
    sampleCurve(pts, 96)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${toSvgX(p.x).toFixed(2)},${toSvgY(p.y).toFixed(2)}`)
      .join(' ');

  return (
    <svg
      ref={svgRef}
      className="curves-editor"
      viewBox={`0 0 ${SIZE + 2 * PAD} ${SIZE + 2 * PAD}`}
      role="group"
      aria-label={`${CHANNEL_LABEL[channel]} curve: click to add a point, drag to move, double-click or Delete to remove`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <rect x={PAD} y={PAD} width={SIZE} height={SIZE} className="curves-editor-bg" />
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g} className="curves-editor-grid">
          <line x1={toSvgX(g)} y1={PAD} x2={toSvgX(g)} y2={PAD + SIZE} />
          <line x1={PAD} y1={toSvgY(g)} x2={PAD + SIZE} y2={toSvgY(g)} />
        </g>
      ))}
      <line
        className="curves-editor-diagonal"
        x1={toSvgX(0)}
        y1={toSvgY(0)}
        x2={toSvgX(1)}
        y2={toSvgY(1)}
      />
      {others
        .filter((o) => !isIdentityCurve(o.points))
        .map((o) => (
          <path
            key={o.channel}
            d={path(o.points)}
            className="curves-editor-other"
            stroke={CHANNEL_STROKE[o.channel]}
          />
        ))}
      <path d={path(points)} className="curves-editor-curve" stroke={CHANNEL_STROKE[channel]} />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={toSvgX(p.x)}
          cy={toSvgY(p.y)}
          r={active === i ? 5.5 : 4.5}
          className={`curves-editor-knot${active === i ? ' is-active' : ''}`}
          tabIndex={0}
          role="slider"
          aria-label={`Point ${i + 1}: input ${Math.round(p.x * 255)}, output ${Math.round(p.y * 255)}`}
          aria-valuemin={0}
          aria-valuemax={255}
          aria-valuenow={Math.round(p.y * 255)}
          onFocus={() => setActive(i)}
          onKeyDown={(e) => onKnotKey(e, i)}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            startDrag(e, i, points);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onPoints(removeCurvePoint(points, i));
            setActive(null);
          }}
        />
      ))}
    </svg>
  );
}

export function CurvesPanel({ settings, onChange }: Props) {
  const [channel, setChannel] = useState<CurveChannel>('master');
  const prevAmountRef = useRef(settings.amount ?? 1);
  const patch = (partial: Partial<CurvesPass>) => onChange({ ...settings, ...partial });
  const patchLevels = (partial: Partial<LevelsSettings>) =>
    patch({ levels: { ...settings.levels, ...partial } });
  const setPoints = (ch: CurveChannel, points: CurvePoint[]) =>
    patch({ curves: { ...settings.curves, [ch]: points } });

  const amount = settings.amount ?? 1;
  const showingBefore = settings.enabled && amount <= 0;
  const points = normalizeCurvePoints(settings.curves?.[channel]);
  const levels = settings.levels ?? DEFAULT_LEVELS;

  return (
    <div className="curves-panel">
      <div className="inspector-group-label">Curves &amp; levels</div>
      <p className="inspector-hint">
        After primary color, before secondary. Levels, then the master curve,
        then the red / green / blue curves. Click the curve to add a point,
        drag to move, double-click (or Delete) to remove. WebGPU preview/export
        only — FFmpeg and Canvas2D skip it (the render plan says so).
      </p>

      <div className="curves-toolbar">
        <label className="finishing-pass-toggle" title="Enable curves & levels">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
        {settings.enabled && (
          <label className="finishing-pass-toggle" title="Bypass curves & levels for before/after compare">
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current = amount > 0 ? amount : prevAmountRef.current;
                  patch({ amount: 0 });
                } else {
                  patch({ amount: prevAmountRef.current > 0 ? prevAmountRef.current : 1 });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            onChange({
              ...DEFAULT_CURVES,
              enabled: settings.enabled,
              amount,
              levels: { ...DEFAULT_LEVELS },
              curves: identityCurves(),
            })
          }
        >
          Reset all
        </button>
      </div>

      {settings.enabled && !showingBefore && (
        <>
          <SliderRow
            label="Amount"
            title="Blend between the original and the curves / levels result"
            min={0}
            max={1}
            step={0.01}
            value={amount}
            display={`${Math.round(amount * 100)}%`}
            onValue={(v) => {
              if (v > 0) prevAmountRef.current = v;
              patch({ amount: v });
            }}
          />

          <div className="curves-group-label">Curves</div>
          <div className="curves-channel-tabs" role="tablist" aria-label="Curve channel">
            {CURVE_CHANNELS.map((ch) => (
              <button
                key={ch}
                type="button"
                role="tab"
                aria-selected={channel === ch}
                className={`btn-secondary curves-channel-tab${channel === ch ? ' is-active' : ''}${
                  isIdentityCurve(settings.curves?.[ch]) ? '' : ' is-edited'
                }`}
                onClick={() => setChannel(ch)}
              >
                {CHANNEL_LABEL[ch]}
              </button>
            ))}
          </div>
          <CurveEditor
            channel={channel}
            points={points}
            others={CURVE_CHANNELS.filter((c) => c !== channel).map((c) => ({
              channel: c,
              points: normalizeCurvePoints(settings.curves?.[c]),
            }))}
            onPoints={(next) => setPoints(channel, next)}
          />
          <div className="curves-presets">
            {CURVE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="btn-secondary curves-preset-chip"
                onClick={() => setPoints(channel, preset.points.map((p) => ({ ...p })))}
              >
                {preset.label}
              </button>
            ))}
            <span className="curves-point-count">
              {points.length} / {CURVE_MAX_POINTS} points
            </span>
          </div>

          <div className="curves-group-label">Levels</div>
          <SliderRow
            label="Input black"
            title="Input values at or below this become output black"
            min={0}
            max={1}
            step={0.005}
            value={levels.inBlack}
            display={String(Math.round(levels.inBlack * 255))}
            onValue={(v) => patchLevels({ inBlack: Math.min(v, levels.inWhite - 0.01) })}
          />
          <SliderRow
            label="Input white"
            title="Input values at or above this become output white"
            min={0}
            max={1}
            step={0.005}
            value={levels.inWhite}
            display={String(Math.round(levels.inWhite * 255))}
            onValue={(v) => patchLevels({ inWhite: Math.max(v, levels.inBlack + 0.01) })}
          />
          <SliderRow
            label="Gamma"
            title="Midtones: above 1 brightens, below 1 darkens"
            min={LEVELS_GAMMA_MIN}
            max={3}
            step={0.01}
            value={Math.min(levels.gamma, 3)}
            display={levels.gamma.toFixed(2)}
            onValue={(v) =>
              patchLevels({ gamma: Math.min(Math.max(v, LEVELS_GAMMA_MIN), LEVELS_GAMMA_MAX) })
            }
          />
          <SliderRow
            label="Output black"
            title="Lift the darkest output value (a matte black)"
            min={0}
            max={1}
            step={0.005}
            value={levels.outBlack}
            display={String(Math.round(levels.outBlack * 255))}
            onValue={(v) => patchLevels({ outBlack: v })}
          />
          <SliderRow
            label="Output white"
            title="Lower the brightest output value"
            min={0}
            max={1}
            step={0.005}
            value={levels.outWhite}
            display={String(Math.round(levels.outWhite * 255))}
            onValue={(v) => patchLevels({ outWhite: v })}
          />
          <button
            type="button"
            className="btn-secondary curves-reset-levels"
            onClick={() => patch({ levels: { ...DEFAULT_LEVELS } })}
          >
            Reset levels
          </button>
        </>
      )}
    </div>
  );
}
