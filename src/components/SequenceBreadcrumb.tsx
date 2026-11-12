import { memo } from 'react';
import { editorActions, useEditorSequences, useSequencePath } from '../store';
import { renderJobStore } from '../store/renderJobStore';

/**
 * Where the timeline is while a nested sequence is open: Main timeline ›
 * Sequence › … with a button per ancestor and an Exit to parent. Renders
 * nothing on the main timeline.
 */
function SequenceBreadcrumbImpl() {
  const path = useSequencePath();
  const sequences = useEditorSequences();
  if (path.length === 0) return null;

  const nameOf = (id: string) => sequences.find((seq) => seq.id === id)?.name ?? 'Sequence';
  const exit = () => {
    const refused = editorActions.exitSequence();
    if (refused) renderJobStore.getState().setStatus(refused);
  };
  /** Exit until `depth` sequences are open (0 = the main timeline). */
  const exitTo = (depth: number) => {
    if (depth === 0) {
      editorActions.exitToRootSequence();
      return;
    }
    for (let open = path.length; open > depth; open--) {
      const refused = editorActions.exitSequence();
      if (refused) {
        renderJobStore.getState().setStatus(refused);
        return;
      }
    }
  };

  return (
    <nav className="sequence-breadcrumb" aria-label="Open sequence">
      <ol>
        <li>
          <button type="button" className="sequence-breadcrumb-link" onClick={() => exitTo(0)}>
            Main timeline
          </button>
        </li>
        {path.map((id, index) => (
          <li key={id}>
            {index === path.length - 1 ? (
              <span className="sequence-breadcrumb-current" aria-current="location">
                {nameOf(id)}
              </span>
            ) : (
              <button type="button" className="sequence-breadcrumb-link" onClick={() => exitTo(index + 1)}>
                {nameOf(id)}
              </button>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn-secondary sequence-breadcrumb-exit"
        onClick={exit}
        title="Back to the parent timeline — clips placing this sequence take its new length"
      >
        ⤴ Exit to parent
      </button>
    </nav>
  );
}

export const SequenceBreadcrumb = memo(SequenceBreadcrumbImpl);
