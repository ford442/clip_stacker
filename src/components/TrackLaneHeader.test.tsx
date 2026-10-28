import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TrackLaneHeader } from './TrackLaneHeader';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { MAIN_VIDEO_TRACK_ID, OVERLAY_VIDEO_TRACK_ID } from '../utils/trackModel';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`No button labelled "${label}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('TrackLaneHeader', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the lane name with mute and lock toggles', () => {
    render(<TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />);

    expect(container.textContent).toContain('Video 1');
    const toggles = Array.from(container.querySelectorAll('.timeline-lane-toggle')).map(
      (b) => b.textContent,
    );
    expect(toggles).toEqual(['M', 'L', 'FX']);
  });

  it('M toggles the lane mute flag in the store', () => {
    render(<TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />);

    click('M');
    expect(editorStore.getState().tracks[0].muted).toBe(true);
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe('M');

    click('M');
    expect(editorStore.getState().tracks[0].muted).toBeUndefined();
  });

  it('L toggles the lane lock flag in the store', () => {
    render(<TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />);

    click('L');
    expect(editorStore.getState().tracks[0].locked).toBe(true);
    expect(container.querySelector('.timeline-lane-header--locked')).not.toBeNull();
  });

  it('offers a remove button for a removable lane only', () => {
    render(<TrackLaneHeader trackId={OVERLAY_VIDEO_TRACK_ID} />);
    expect(container.querySelector('.timeline-lane-remove')).not.toBeNull();

    click('×');
    expect(
      editorStore.getState().tracks.some((t) => t.id === OVERLAY_VIDEO_TRACK_ID),
    ).toBe(false);
  });

  it('renders nothing for a lane that no longer exists', () => {
    render(<TrackLaneHeader trackId="gone" />);
    expect(container.textContent).toBe('');
  });

  it('FX opens the lane bus dialog; adding an effect is one undo step', () => {
    render(<TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />);
    const depth = editorStore.getState().undoDepth;
    click('FX');
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Video 1: lane bus');
    const add = dialog!.querySelector<HTMLSelectElement>('select[aria-label="Add an effect to Video 1"]')!;
    act(() => {
      add.value = 'compressor';
      add.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const lane = editorStore.getState().tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!;
    expect(lane.audioFx?.map((e) => e.kind)).toEqual(['compressor']);
    expect(editorStore.getState().undoDepth).toBe(depth + 1);
    // The header badge counts active effects.
    const fx = Array.from(container.querySelectorAll('.timeline-lane-fx'))[0]!;
    expect(fx.textContent).toBe('FX1');
    // Escape closes the dialog.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a locked lane opens its FX read-only', () => {
    act(() => editorStore.getState().toggleTrackLocked(MAIN_VIDEO_TRACK_ID));
    render(<TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />);
    click('FX');
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('is locked');
    expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Add an effect to Video 1"]')!.disabled).toBe(
      true,
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('titles lanes have no FX', () => {
    act(() => editorStore.getState().addTrack('text'));
    const titles = editorStore.getState().tracks.find((t) => t.kind === 'text')!;
    render(<TrackLaneHeader trackId={titles.id} />);
    expect(container.querySelector('.timeline-lane-fx')).toBeNull();
  });
});
