import { useState, type ReactNode } from 'react';
import { isSectionOpen, loadSectionState, saveSectionOpen } from '../../utils/sectionState';

interface InspectorSectionProps {
  /** Stable storage key for the remembered open state. */
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** A collapsible group of Inspector fields whose open state survives reloads. */
export function InspectorSection({ id, title, defaultOpen = true, children }: InspectorSectionProps) {
  const [open, setOpen] = useState(() => isSectionOpen(id, defaultOpen, loadSectionState()));

  return (
    <details
      className="inspector-section"
      open={open}
      data-section-id={id}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        saveSectionOpen(id, next);
      }}
    >
      <summary className="inspector-group-label">{title}</summary>
      <div className="inspector-section-body">{children}</div>
    </details>
  );
}
