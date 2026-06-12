import { useEffect, useRef, useState } from "react";
import type { ClipTransition, TransitionType } from "../types";
import {
  MIN_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
} from "../utils/transitions";

interface Props {
  transition: ClipTransition;
  clipATitle: string;
  clipBTitle: string;
  onUpdate: (updated: ClipTransition) => void;
  onClose: () => void;
}

const TRANSITION_OPTIONS: {
  value: TransitionType;
  label: string;
  description: string;
}[] = [
  { value: "none", label: "Cut", description: "Hard cut — no overlap" },
  {
    value: "dissolve",
    label: "Dissolve",
    description: "Crossfade between clips",
  },
  {
    value: "motion",
    label: "Motion blend",
    description: "Smooth blend for motion-matched clips",
  },
];

export function TransitionEditor({
  transition,
  clipATitle,
  clipBTitle,
  onUpdate,
  onClose,
}: Props) {
  const [type, setType] = useState<TransitionType>(transition.type);
  const [duration, setDuration] = useState(transition.duration);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setType(transition.type);
    setDuration(transition.duration);
  }, [transition]);

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

  const handleTypeChange = (newType: TransitionType) => {
    setType(newType);
    onUpdate({ ...transition, type: newType, duration });
  };

  const handleDurationChange = (rawValue: string) => {
    const v = parseFloat(rawValue);
    if (isNaN(v)) return;
    const clamped = Math.max(
      MIN_TRANSITION_DURATION,
      Math.min(MAX_TRANSITION_DURATION, v),
    );
    setDuration(clamped);
    onUpdate({ ...transition, type, duration: clamped });
  };

  const adjust = (delta: number) => {
    handleDurationChange(String(Math.round((duration + delta) * 10) / 10));
  };

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
          <div className="te-type-options">
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

        <p className="te-hint">
          {TRANSITION_OPTIONS.find((o) => o.value === type)?.description}
        </p>
      </div>
    </div>
  );
}
