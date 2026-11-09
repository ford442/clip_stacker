import { beforeEach, describe, expect, it } from 'vitest';
import { renderJobStore, renderJobActions } from './renderJobStore';
import { settingsStore } from './settingsStore';
import { editorStore } from './editorStore';
import { exportAudioBus } from '../export/exportAudioBus';
import { exportMasterLimiter } from '../export/webcodecsAudio';
import { DEFAULT_EXPORT_SETTINGS, type Track } from '../types';

describe('renderJobStore', () => {
  beforeEach(() => {
    renderJobStore.setState({ status: '', isRendering: false, renderPlan: null, outputUrl: null });
  });

  it('holds render-job state apart from the project settings', () => {
    const before = settingsStore.getState();
    renderJobActions.setStatus('Rendering…');
    renderJobActions.setIsRendering(true);
    renderJobActions.setProgressValue(0.5);
    expect(renderJobStore.getState()).toMatchObject({
      status: 'Rendering…',
      isRendering: true,
      progressValue: 0.5,
    });
    // A progress tick never touches (or re-notifies) the settings store.
    expect(settingsStore.getState()).toBe(before);
  });

  it('keeps no job fields on the settings store', () => {
    const settings = settingsStore.getState() as unknown as Record<string, unknown>;
    for (const key of ['status', 'isRendering', 'renderPlan', 'outputUrl', 'progressValue']) {
      expect(settings).not.toHaveProperty(key);
    }
  });
});

describe('export state source registration', () => {
  it('reads the editor lanes and the export limiter without the export layer importing a store', () => {
    const tracks: Track[] = [
      { id: 'a1', kind: 'audio', name: 'Music', items: [], muted: false, locked: false },
    ] as unknown as Track[];
    editorStore.setState({ tracks, masterBus: undefined });
    expect(exportAudioBus()).toEqual({ tracks });

    settingsStore.setState({
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, masterLimiter: { enabled: true, ceilingDb: -1, lookahead: 0.005, release: 0.05 } },
    });
    expect(exportMasterLimiter()).not.toBeNull();
    settingsStore.setState({ exportSettings: DEFAULT_EXPORT_SETTINGS });
    expect(exportMasterLimiter()).toBeNull();
  });
});
