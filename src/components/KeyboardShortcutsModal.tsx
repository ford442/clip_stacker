interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "R", description: "Render merge" },
  { key: "S", description: "Save local project" },
  { key: "L", description: "Load local project" },
  { key: "Delete / Backspace", description: "Delete selected clip" },
  { key: "Arrow Left (with Ctrl/Cmd)", description: "Move selected clip left" },
  {
    key: "Arrow Right (with Ctrl/Cmd)",
    description: "Move selected clip right",
  },
  { key: "Space", description: "Play/pause preview (when focused)" },
  { key: "Escape", description: "Close modals" },
  { key: "Enter / Space (in library)", description: "Select clip" },
];

export function KeyboardShortcutsModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <table className="shortcuts-table">
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.key}>
                  <td className="shortcut-key">
                    <kbd>{shortcut.key}</kbd>
                  </td>
                  <td className="shortcut-desc">{shortcut.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
