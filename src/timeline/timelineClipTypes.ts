import type { Clip } from '../types';

export interface VirtualClipLayout {
  clip: Clip;
  index: number;
  duration: number;
  width: number;
  start: number;
}
