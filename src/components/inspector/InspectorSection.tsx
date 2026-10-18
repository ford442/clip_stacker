import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  consumePendingReveal,
  isSectionOpen,
  loadSectionState,
  saveSectionOpen,
  subscribeSectionReveal,
} from '../../utils/sectionState';

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
  const ref = useRef<HTMLDetailsElement>(null);

  // A reveal request (e.g. the preview's Effects Stack "Edit") opens the
  // section and brings it into view, whether it was mounted already or not.
  useEffect(() => {
    const reveal = () => {
      setOpen(true);
      requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
    };
    if (consumePendingReveal(id)) reveal();
    return subscribeSectionReveal((target) => {
      if (target === id && consumePendingReveal(id)) reveal();
    });
  }, [id]);

  return (
    <details
      ref={ref}
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
