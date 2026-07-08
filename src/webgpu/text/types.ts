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
}
