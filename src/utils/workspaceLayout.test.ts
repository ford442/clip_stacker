import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_LIMITS,
  clampSideWidth,
  loadWorkspaceLayout,
  resizeSideByDrag,
  resizeVerticalSplit,
  sanitizeWorkspaceLayout,
  saveWorkspaceLayout,
  splitterKeyAction,
  workspaceShellAttributes,
} from './workspaceLayout';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('clampSideWidth', () => {
  it('keeps each side within its own limits', () => {
    expect(clampSideWidth('library', 50)).toBe(WORKSPACE_LIMITS.libraryMin);
    expect(clampSideWidth('library', 5000)).toBe(WORKSPACE_LIMITS.libraryMax);
    expect(clampSideWidth('inspector', 100)).toBe(WORKSPACE_LIMITS.inspectorMin);
    expect(clampSideWidth('inspector', 301.6)).toBe(302);
  });

  it('leaves the preview its minimum next to the other side', () => {
    const gridWidth = 1200;
    const otherWidth = 300;
    const room =
      gridWidth - otherWidth - WORKSPACE_LIMITS.previewMin - 2 * WORKSPACE_LIMITS.splitterSize;
    expect(clampSideWidth('library', 640, { gridWidth, otherWidth })).toBe(room);
  });

  it('lets the minimum win when the window is too cramped for it', () => {
    expect(clampSideWidth('library', 400, { gridWidth: 500, otherWidth: 300 })).toBe(
      WORKSPACE_LIMITS.libraryMin,
    );
  });
});

describe('resizeSideByDrag', () => {
  it('widens the library when its splitter moves right', () => {
    expect(resizeSideByDrag('library', 260, 40)).toBe(300);
  });

  it('narrows the inspector when its splitter moves right', () => {
    expect(resizeSideByDrag('inspector', 300, 40)).toBe(260);
    expect(resizeSideByDrag('inspector', 300, -40)).toBe(340);
  });
});

describe('resizeVerticalSplit', () => {
  it('trades height between the upper zone and the timeline, keeping the sum', () => {
    const next = resizeVerticalSplit({ upperHeight: 500, timelineHeight: 300 }, 100);
    expect(next).toEqual({ upperHeight: 600, timelineHeight: 200 });
  });

  it('stops where either side hits its minimum', () => {
    const down = resizeVerticalSplit({ upperHeight: 500, timelineHeight: 300 }, 10_000);
    expect(down.timelineHeight).toBe(WORKSPACE_LIMITS.timelineMin);
    expect(down.upperHeight).toBe(800 - WORKSPACE_LIMITS.timelineMin);

    const up = resizeVerticalSplit({ upperHeight: 500, timelineHeight: 300 }, -10_000);
    expect(up.upperHeight).toBe(WORKSPACE_LIMITS.upperMin);
    expect(up.timelineHeight).toBe(800 - WORKSPACE_LIMITS.upperMin);
  });

  it('only moves the upper zone when there is no timeline to trade with', () => {
    expect(resizeVerticalSplit({ upperHeight: 500, timelineHeight: null }, -80)).toEqual({
      upperHeight: 420,
      timelineHeight: null,
    });
    expect(resizeVerticalSplit({ upperHeight: 500, timelineHeight: null }, -1e6).upperHeight).toBe(
      WORKSPACE_LIMITS.upperMin,
    );
  });

  it('does not move when both sides already start below their minimums', () => {
    expect(resizeVerticalSplit({ upperHeight: 100, timelineHeight: 50 }, 30)).toEqual({
      upperHeight: 100,
      timelineHeight: 50,
    });
  });
});

describe('splitterKeyAction', () => {
  it('maps arrows along the splitter axis only', () => {
    expect(splitterKeyAction('ArrowRight', false, 'vertical')).toEqual({ kind: 'step', deltaPx: 16 });
    expect(splitterKeyAction('ArrowLeft', true, 'vertical')).toEqual({ kind: 'step', deltaPx: -64 });
    expect(splitterKeyAction('ArrowUp', false, 'vertical')).toBeNull();
    expect(splitterKeyAction('ArrowDown', false, 'horizontal')).toEqual({ kind: 'step', deltaPx: 16 });
    expect(splitterKeyAction('ArrowLeft', false, 'horizontal')).toBeNull();
  });

  it('maps Home / End / Enter and ignores everything else', () => {
    expect(splitterKeyAction('Home', false, 'vertical')).toEqual({ kind: 'min' });
    expect(splitterKeyAction('End', false, 'horizontal')).toEqual({ kind: 'max' });
    expect(splitterKeyAction('Enter', false, 'vertical')).toEqual({ kind: 'toggle' });
    expect(splitterKeyAction('a', false, 'vertical')).toBeNull();
  });
});

describe('sanitizeWorkspaceLayout', () => {
  it('returns defaults for junk', () => {
    expect(sanitizeWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(sanitizeWorkspaceLayout('nope')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('keeps valid fields, clamps sizes and drops malformed ones', () => {
    const layout = sanitizeWorkspaceLayout({
      libraryWidth: 10,
      inspectorWidth: 'wide',
      libraryCollapsed: true,
      inspectorCollapsed: 1,
      upperHeight: 50,
      timelineHeight: 360.4,
      density: 'huge',
      fullWidth: false,
    });
    expect(layout).toEqual({
      ...DEFAULT_WORKSPACE_LAYOUT,
      libraryWidth: WORKSPACE_LIMITS.libraryMin,
      libraryCollapsed: true,
      upperHeight: WORKSPACE_LIMITS.upperMin,
      timelineHeight: 360,
      fullWidth: false,
    });
  });

  it('treats non-finite heights as natural height', () => {
    expect(sanitizeWorkspaceLayout({ upperHeight: Number.NaN }).upperHeight).toBeNull();
  });
});

describe('load / save', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const layout = { ...DEFAULT_WORKSPACE_LAYOUT, libraryWidth: 333, density: 'compact' as const };
    saveWorkspaceLayout(layout, storage);
    expect(loadWorkspaceLayout(storage)).toEqual(layout);
  });

  it('falls back to defaults on unparseable JSON or missing storage', () => {
    expect(
      loadWorkspaceLayout(memoryStorage({ [WORKSPACE_LAYOUT_STORAGE_KEY]: '{oops' })),
    ).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(loadWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('swallows storage errors on save', () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(() => saveWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, throwing)).not.toThrow();
  });
});

describe('workspaceShellAttributes', () => {
  it('omits height variables and flags at natural height', () => {
    const { vars, data } = workspaceShellAttributes(DEFAULT_WORKSPACE_LAYOUT);
    expect(vars['--ws-library-width']).toBe('260px');
    expect(vars['--ws-upper-height']).toBeNull();
    expect(vars['--ws-timeline-height']).toBeNull();
    expect(data['data-density']).toBe('comfortable');
    expect(data['data-full-width']).toBe('true');
  });

  it('emits heights and collapse flags when set', () => {
    const { vars, data } = workspaceShellAttributes({
      ...DEFAULT_WORKSPACE_LAYOUT,
      upperHeight: 480,
      timelineHeight: 240,
      inspectorCollapsed: true,
      fullWidth: false,
    });
    expect(vars['--ws-upper-height']).toBe('480px');
    expect(vars['--ws-timeline-height']).toBe('240px');
    expect(data['data-inspector-collapsed']).toBe('true');
    expect(data['data-library-collapsed']).toBeNull();
    expect(data['data-full-width']).toBeNull();
  });
});
