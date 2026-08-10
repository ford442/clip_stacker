import type { Clip } from '../../types';
import { ContaboStorageManagerClient } from './contaboClient';
import { applyProjectData } from './applyProjectData';
import {
  countRemoteProjectDownloads,
  emitRemoteProjectLoadProgress,
} from './remoteLoadProgress';
import {
  REMOTE_PROJECT_DOWNLOAD_PROGRESS_END,
  REMOTE_PROJECT_DOWNLOAD_PROGRESS_START,
} from './constants';
import type { AppliedProjectData, LoadRemoteProjectOptions } from './types';

export async function loadRemoteProject(
  client: ContaboStorageManagerClient,
  name: string,
  clips: Clip[],
  options: LoadRemoteProjectOptions = {},
): Promise<AppliedProjectData> {
  emitRemoteProjectLoadProgress(options.onProgress, {
    stage: 'Fetching project manifest...',
    progress: 0,
    indeterminate: true,
  });

  const project = await client.load(name);
  const totalRemoteDownloads = countRemoteProjectDownloads(project, clips);

  if (totalRemoteDownloads === 0) {
    emitRemoteProjectLoadProgress(options.onProgress, {
      stage: 'Applying remote project data...',
      progress: REMOTE_PROJECT_DOWNLOAD_PROGRESS_START,
      indeterminate: true,
    });
  }

  const result = await applyProjectData(project, clips, {
    onProgress: options.onProgress,
    remoteProgressStart: REMOTE_PROJECT_DOWNLOAD_PROGRESS_START,
    remoteProgressEnd: REMOTE_PROJECT_DOWNLOAD_PROGRESS_END,
  });

  emitRemoteProjectLoadProgress(options.onProgress, {
    stage: 'Remote project load complete',
    progress: 1,
    indeterminate: false,
  });

  return result;
}
