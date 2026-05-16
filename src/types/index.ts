export type ClipKind = 'video' | 'audio';

export interface Clip {
  id: string;
  file: File;
  objectUrl: string;
  title: string;
  kind: ClipKind;
  duration: number;
  trimStart: number;
  trimEnd: number; // NaN means "use full duration"
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  inputName?: string;
}

export interface SerializedClip {
  id: string;
  title: string;
  kind: ClipKind;
  duration: number;
  trimStart: number;
  trimEnd: number | null;
  videoFadeIn: number;
  videoFadeOut: number;
  audioFadeIn: number;
  audioFadeOut: number;
  fileName: string;
}

export interface Project {
  clips: SerializedClip[];
}
