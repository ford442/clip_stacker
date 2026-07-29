export type TextFillMode = 'solid' | 'shader';

export interface TextShaderParamDef {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  default: number;
}

export interface TextShaderDef {
  id: string;
  label: string;
  /** Defaults applied when no shaderParams provided. */
  defaults?: Record<string, number>;
  params?: TextShaderParamDef[];
  /**
   * Maps this shader's named params to uniform slots `p0`/`p1`/`p2` in the
   * `TextFillUniforms` WGSL struct (`textFill.wgsl`). Slot 3 is reserved for
   * `mode` below and must not appear here — adding a shader with new named
   * params only requires an entry here, no change to `textFill.ts`.
   */
  paramSlots: Record<string, 0 | 1 | 2>;
  /** Fixed index consumed by `fs_main` to select which `fill_*` function runs. */
  mode: number;
}
