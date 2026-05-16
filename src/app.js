import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

const state = {
  clips: [],
  selectedClipId: null,
  ffmpeg: null,
};

const clipInput = document.querySelector('#clipInput');
const clipList = document.querySelector('#clipList');
const timeline = document.querySelector('#timeline');
const statusNode = document.querySelector('#status');
const mergeButton = document.querySelector('#mergeButton');
const videoPreview = document.querySelector('#videoPreview');
const audioPreview = document.querySelector('#audioPreview');
const noPreview = document.querySelector('#noPreview');
const downloadLink = document.querySelector('#downloadLink');
const emptyInspector = document.querySelector('#emptyInspector');
const clipInspector = document.querySelector('#clipInspector');
const clipName = document.querySelector('#clipName');
const trimStart = document.querySelector('#trimStart');
const trimEnd = document.querySelector('#trimEnd');
const videoFadeIn = document.querySelector('#videoFadeIn');
const videoFadeOut = document.querySelector('#videoFadeOut');
const audioFadeIn = document.querySelector('#audioFadeIn');
const audioFadeOut = document.querySelector('#audioFadeOut');
const saveProjectButton = document.querySelector('#saveProjectButton');
const loadProjectButton = document.querySelector('#loadProjectButton');
const projectFileInput = document.querySelector('#projectFileInput');
const saveRemoteButton = document.querySelector('#saveRemoteButton');
const loadRemoteButton = document.querySelector('#loadRemoteButton');
const storageEndpoint = document.querySelector('#storageEndpoint');
const storageAuthToken = document.querySelector('#storageAuthToken');
const projectNameInput = document.querySelector('#projectName');

const DEFAULT_STORAGE_ENDPOINT = '';
const MIN_CLIP_DURATION = 0.1;
const FADE_SAFETY_MARGIN = 0.01;
const DEFAULT_VIDEO_SIZE = '1280x720';

function setStatus(message) {
  statusNode.textContent = message;
}

function getSelectedClip() {
  return state.clips.find((clip) => clip.id === state.selectedClipId) || null;
}

function getClipDuration(clip) {
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  return Math.max(MIN_CLIP_DURATION, end - clip.trimStart);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSafeExtension(fileName, defaultExtension) {
  const extensionMatch = /\.([^.]+)$/.exec(fileName);
  const rawExtension = extensionMatch?.[1]?.toLowerCase();
  return rawExtension && /^[a-z0-9]+$/.test(rawExtension) ? rawExtension : defaultExtension;
}

function createClipId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function renderClips() {
  clipList.replaceChildren();
  timeline.replaceChildren();

  for (const [index, clip] of state.clips.entries()) {
    const clipNode = document.createElement('li');
    clipNode.className = `clip-item${clip.id === state.selectedClipId ? ' selected' : ''}`;
    const safeTitle = escapeHtml(clip.title);
    clipNode.innerHTML = `
      <div class="row">
        <strong>${safeTitle}</strong>
        <span class="muted">${clip.kind.toUpperCase()}</span>
      </div>
      <div class="muted">${getClipDuration(clip).toFixed(1)}s (trim ${clip.trimStart.toFixed(1)}s → ${Number.isFinite(clip.trimEnd) ? clip.trimEnd.toFixed(1) : 'end'})</div>
    `;
    clipNode.addEventListener('click', () => {
      state.selectedClipId = clip.id;
      render();
    });
    clipList.append(clipNode);

    const timelineNode = document.createElement('li');
    timelineNode.className = `timeline-item${clip.id === state.selectedClipId ? ' selected' : ''}`;
    timelineNode.innerHTML = `
      <div class="row">
        <strong>${index + 1}. ${safeTitle}</strong>
        <div class="timeline-buttons">
          <button type="button" data-action="up">↑</button>
          <button type="button" data-action="down">↓</button>
        </div>
      </div>
      <div class="muted">Fade V(in/out): ${clip.videoFadeIn.toFixed(1)}/${clip.videoFadeOut.toFixed(1)}s • A(in/out): ${clip.audioFadeIn.toFixed(1)}/${clip.audioFadeOut.toFixed(1)}s</div>
    `;
    timelineNode.addEventListener('click', () => {
      state.selectedClipId = clip.id;
      render();
    });
    timelineNode.querySelector('[data-action="up"]').addEventListener('click', (event) => {
      event.stopPropagation();
      if (index > 0) {
        [state.clips[index - 1], state.clips[index]] = [state.clips[index], state.clips[index - 1]];
        render();
      }
    });
    timelineNode.querySelector('[data-action="down"]').addEventListener('click', (event) => {
      event.stopPropagation();
      if (index < state.clips.length - 1) {
        [state.clips[index + 1], state.clips[index]] = [state.clips[index], state.clips[index + 1]];
        render();
      }
    });
    timeline.append(timelineNode);
  }
}

function renderInspector() {
  const clip = getSelectedClip();
  const hasClip = Boolean(clip);
  emptyInspector.hidden = hasClip;
  clipInspector.hidden = !hasClip;
  if (!clip) {
    return;
  }

  clipName.value = clip.title;
  trimStart.value = String(clip.trimStart);
  trimEnd.value = Number.isFinite(clip.trimEnd) ? String(clip.trimEnd) : '';
  videoFadeIn.value = String(clip.videoFadeIn);
  videoFadeOut.value = String(clip.videoFadeOut);
  audioFadeIn.value = String(clip.audioFadeIn);
  audioFadeOut.value = String(clip.audioFadeOut);
}

function renderPreview() {
  const clip = getSelectedClip();
  const hasClip = Boolean(clip);
  noPreview.hidden = hasClip;
  if (!clip) {
    videoPreview.hidden = true;
    audioPreview.hidden = true;
    return;
  }

  if (clip.kind === 'video') {
    videoPreview.src = clip.objectUrl;
    videoPreview.hidden = false;
    audioPreview.hidden = true;
  } else {
    audioPreview.src = clip.objectUrl;
    audioPreview.hidden = false;
    videoPreview.hidden = true;
  }
}

function render() {
  renderClips();
  renderInspector();
  renderPreview();
}

function sanitizeClipAdjustments(clip) {
  clip.trimStart = Number.isFinite(clip.trimStart) ? Math.max(0, clip.trimStart) : 0;
  clip.trimEnd = Number.isFinite(clip.trimEnd) ? Math.max(clip.trimStart + MIN_CLIP_DURATION, clip.trimEnd) : NaN;

  const maxFade = Math.max(0, getClipDuration(clip) / 2 - FADE_SAFETY_MARGIN);
  clip.videoFadeIn = Math.min(Math.max(0, clip.videoFadeIn), maxFade);
  clip.videoFadeOut = Math.min(Math.max(0, clip.videoFadeOut), maxFade);
  clip.audioFadeIn = Math.min(Math.max(0, clip.audioFadeIn), maxFade);
  clip.audioFadeOut = Math.min(Math.max(0, clip.audioFadeOut), maxFade);
}

function serializeProject() {
  return {
    clips: state.clips.map((clip) => ({
      id: clip.id,
      title: clip.title,
      kind: clip.kind,
      duration: clip.duration,
      trimStart: clip.trimStart,
      trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : null,
      videoFadeIn: clip.videoFadeIn,
      videoFadeOut: clip.videoFadeOut,
      audioFadeIn: clip.audioFadeIn,
      audioFadeOut: clip.audioFadeOut,
      fileName: clip.file.name,
    })),
  };
}

function applyProjectData(project) {
  if (!project || !Array.isArray(project.clips)) {
    throw new Error('Project file is invalid.');
  }

  const byName = new Map(state.clips.map((clip) => [clip.file.name, clip]));
  const mapped = [];

  for (const savedClip of project.clips) {
    const liveClip = byName.get(savedClip.fileName);
    if (!liveClip) {
      continue;
    }

    liveClip.title = savedClip.title || liveClip.title;
    liveClip.trimStart = Number(savedClip.trimStart ?? liveClip.trimStart);
    liveClip.trimEnd = savedClip.trimEnd == null ? NaN : Number(savedClip.trimEnd);
    liveClip.videoFadeIn = Number(savedClip.videoFadeIn ?? liveClip.videoFadeIn);
    liveClip.videoFadeOut = Number(savedClip.videoFadeOut ?? liveClip.videoFadeOut);
    liveClip.audioFadeIn = Number(savedClip.audioFadeIn ?? liveClip.audioFadeIn);
    liveClip.audioFadeOut = Number(savedClip.audioFadeOut ?? liveClip.audioFadeOut);
    sanitizeClipAdjustments(liveClip);
    mapped.push(liveClip);
  }

  if (mapped.length > 0) {
    state.clips = mapped;
    state.selectedClipId = mapped[mapped.length - 1].id;
  }
}

class ContaboStorageManagerClient {
  constructor(endpoint, authToken) {
    this.endpoint = endpoint || DEFAULT_STORAGE_ENDPOINT;
    this.authToken = authToken?.trim() || '';
  }

  getAuthHeader() {
    if (!this.authToken) {
      return null;
    }

    return this.authToken.startsWith('Bearer ') ? this.authToken : `Bearer ${this.authToken}`;
  }

  async save(name, payload) {
    const authHeader = this.getAuthHeader();
    const headers = { 'content-type': 'application/json' };
    if (authHeader) {
      headers.authorization = authHeader;
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, payload }),
    });
    if (!response.ok) {
      throw new Error(`Remote save failed (${response.status})`);
    }
  }

  async load(name) {
    const authHeader = this.getAuthHeader();
    const response = await fetch(`${this.endpoint}?name=${encodeURIComponent(name)}`, {
      headers: authHeader ? { authorization: authHeader } : undefined,
    });
    if (!response.ok) {
      throw new Error(`Remote load failed (${response.status})`);
    }
    const result = await response.json();
    return result.payload;
  }
}

async function ensureFfmpeg() {
  if (state.ffmpeg) {
    return state.ffmpeg;
  }
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    if (message.includes('time=')) {
      setStatus(`Rendering... ${message}`);
    }
  });
  await ffmpeg.load();
  state.ffmpeg = ffmpeg;
  return ffmpeg;
}

function createFilterParts(inputCount) {
  const filterParts = [];
  const concatInputs = [];

  state.clips.forEach((clip, index) => {
    const duration = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
    const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);

    if (clip.kind === 'video') {
      let videoChain = `[${index}:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;
      if (clip.videoFadeIn > 0) {
        videoChain += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
      }
      if (clip.videoFadeOut > 0) {
        videoChain += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
      }
      videoChain += `[v${index}]`;
      filterParts.push(videoChain);

      let audioChain = `[${index}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
      if (clip.audioFadeIn > 0) {
        audioChain += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      }
      if (clip.audioFadeOut > 0) {
        audioChain += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
      }
      audioChain += `[a${index}]`;
      filterParts.push(audioChain);
    } else {
      filterParts.push(`color=c=black:s=${DEFAULT_VIDEO_SIZE}:d=${duration}[vsrc${index}]`);
      let videoChain = `[vsrc${index}]`;
      if (clip.videoFadeIn > 0) {
        videoChain += `fade=t=in:st=0:d=${clip.videoFadeIn},`;
      }
      if (clip.videoFadeOut > 0) {
        videoChain += `fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut},`;
      }
      videoChain += `format=yuv420p[v${index}]`;
      filterParts.push(videoChain);

      let audioChain = `[${index}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
      if (clip.audioFadeIn > 0) {
        audioChain += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      }
      if (clip.audioFadeOut > 0) {
        audioChain += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
      }
      audioChain += `[a${index}]`;
      filterParts.push(audioChain);
    }

    concatInputs.push(`[v${index}][a${index}]`);
  });

  filterParts.push(`${concatInputs.join('')}concat=n=${inputCount}:v=1:a=1[vout][aout]`);
  return filterParts.join(';');
}

async function mergeClips() {
  if (state.clips.length === 0) {
    setStatus('Upload clips before rendering.');
    return;
  }

  try {
    const ffmpeg = await ensureFfmpeg();
    setStatus('Preparing media...');

    for (const name of await ffmpeg.listDir('/')) {
      if (name.name.startsWith('input-') || name.name === 'stacked.mp4') {
        await ffmpeg.deleteFile(name.name);
      }
    }

    const args = [];

    for (const [index, clip] of state.clips.entries()) {
      const extension = getSafeExtension(clip.file.name, clip.kind === 'video' ? 'mp4' : 'mp3');
      clip.inputName = `input-${index}.${extension}`;
      await ffmpeg.writeFile(clip.inputName, await fetchFile(clip.file));
      args.push('-i', clip.inputName);
    }

    const filterComplex = createFilterParts(state.clips.length);

    await ffmpeg.exec([
      ...args,
      '-filter_complex',
      filterComplex,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      'stacked.mp4',
    ]);

    const output = await ffmpeg.readFile('stacked.mp4');
    const blob = new Blob([output.buffer], { type: 'video/mp4' });
    const outputUrl = URL.createObjectURL(blob);
    downloadLink.href = outputUrl;
    downloadLink.hidden = false;
    videoPreview.src = outputUrl;
    videoPreview.hidden = false;
    audioPreview.hidden = true;
    noPreview.hidden = true;
    setStatus('Render complete. Download your merged MP4.');
  } catch (error) {
    setStatus(`Render failed: ${error.message}`);
  }
}

clipInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }

  for (const file of files) {
    const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.mp4');
    const isAudio = file.type.startsWith('audio/') || /\.(wav|mp3)$/i.test(file.name);
    if (!isVideo && !isAudio) {
      continue;
    }

    const objectUrl = URL.createObjectURL(file);
    const duration = 10;

    const clip = {
      id: createClipId(),
      file,
      objectUrl,
      title: file.name,
      kind: isVideo ? 'video' : 'audio',
      duration: Math.max(MIN_CLIP_DURATION, duration),
      trimStart: 0,
      trimEnd: NaN,
      videoFadeIn: 0,
      videoFadeOut: 0,
      audioFadeIn: 0,
      audioFadeOut: 0,
    };

    state.clips.push(clip);
    state.selectedClipId = clip.id;
  }

  event.target.value = '';
  downloadLink.hidden = true;
  setStatus('Clips imported. Existing clips were kept and the newest clip was selected.');
  render();
});

mergeButton.addEventListener('click', () => {
  mergeClips();
});

const updateSelectedClip = () => {
  const clip = getSelectedClip();
  if (!clip) {
    return;
  }
  clip.title = clipName.value.trim() || clip.file.name;
  clip.trimStart = Number(trimStart.value || 0);
  clip.trimEnd = trimEnd.value === '' ? NaN : Number(trimEnd.value);
  clip.videoFadeIn = Number(videoFadeIn.value || 0);
  clip.videoFadeOut = Number(videoFadeOut.value || 0);
  clip.audioFadeIn = Number(audioFadeIn.value || 0);
  clip.audioFadeOut = Number(audioFadeOut.value || 0);
  sanitizeClipAdjustments(clip);
  render();
};

[clipName, trimStart, trimEnd, videoFadeIn, videoFadeOut, audioFadeIn, audioFadeOut].forEach((node) => {
  node.addEventListener('input', updateSelectedClip);
});

saveProjectButton.addEventListener('click', () => {
  const payload = JSON.stringify(serializeProject(), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${projectNameInput.value || 'clip_stacker-project'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus('Project JSON exported.');
});

loadProjectButton.addEventListener('click', () => {
  projectFileInput.click();
});

projectFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const parsed = JSON.parse(await file.text());
    applyProjectData(parsed);
    setStatus('Project JSON loaded (matching clips applied).');
    render();
  } catch (error) {
    setStatus(`Could not load project: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

saveRemoteButton.addEventListener('click', async () => {
  try {
    const client = new ContaboStorageManagerClient(storageEndpoint.value, storageAuthToken.value);
    await client.save(projectNameInput.value || 'default-project', serializeProject());
    setStatus('Project saved to contabo_storage_manager endpoint.');
  } catch (error) {
    setStatus(error.message);
  }
});

loadRemoteButton.addEventListener('click', async () => {
  try {
    const client = new ContaboStorageManagerClient(storageEndpoint.value, storageAuthToken.value);
    const payload = await client.load(projectNameInput.value || 'default-project');
    applyProjectData(payload);
    setStatus('Project loaded from contabo_storage_manager endpoint.');
    render();
  } catch (error) {
    setStatus(error.message);
  }
});

storageEndpoint.value = DEFAULT_STORAGE_ENDPOINT;
render();
