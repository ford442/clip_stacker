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
    expect(toggles).toEqual(['M', 'L']);
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
});
