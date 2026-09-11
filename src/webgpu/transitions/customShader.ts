/**
 * Parametric ("custom") transitions — a user-supplied WGSL *expression* that
 * is substituted into the shared transition shader template.
 *
 * The expression is only ever spliced into the one `result = (...)` slot of
 * `shaderTemplate.ts`, so the surface a user can reach is limited to whatever
 * the template already binds: `sampleFrom` / `sampleTo` / `sampleMask` /
 * `sampleMaskLuma` / `u.*` / `uv`. `validateCustomExpression` rejects the
 * syntax that would let an expression break *out* of that slot (statement
 * separators, comments, attributes, declarations), and
 * `compileCustomTransition` does the real check on the GPU so the editor can
 * show the driver's own error text instead of guessing.
 */

import type { TransitionDef, TransitionParamDef } from './types';
import { buildTransitionShader } from './shaderTemplate';

export const CUSTOM_TRANSITION_TYPE = 'custom';

/** Identity-ish default so a freshly picked "Custom" renders a plain dissolve. */
export const DEFAULT_CUSTOM_EXPRESSION =
  'mix(sampleFrom(uv), sampleTo(uv), u.progress)';

export const MAX_CUSTOM_EXPRESSION_LENGTH = 2000;

/** Cap on distinct compiled custom variants held at once (pipelines are GPU memory). */
const MAX_CUSTOM_VARIANTS = 16;

export interface CustomExpressionValidation {
  ok: boolean;
  error?: string;
}

/** Tokens that would let an expression escape the `result = (...)` slot. */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /;/, message: 'Statements are not allowed — write a single expression.' },
  { pattern: /\/\/|\/\*|\*\//, message: 'Comments are not allowed inside the expression.' },
  { pattern: /@/, message: 'Attributes (@…) are not allowed.' },
  { pattern: /\bfn\b/, message: 'Function declarations are not allowed.' },
  { pattern: /\bstruct\b/, message: 'Struct declarations are not allowed.' },
  { pattern: /\b(var|let|const|override)\b/, message: 'Declarations are not allowed — write a single expression.' },
  { pattern: /\b(enable|requires|diagnostic|const_assert)\b/, message: 'Directives are not allowed.' },
  { pattern: /\b(return|if|else|for|while|loop|switch|break|continue|discard)\b/, message: 'Control flow is not allowed — write a single expression.' },
];

const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function checkBalanced(expression: string): string | undefined {
  const stack: string[] = [];
  for (const ch of expression) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in BRACKET_PAIRS) {
      if (stack.pop() !== BRACKET_PAIRS[ch]) return `Unbalanced "${ch}".`;
    }
  }
  return stack.length > 0 ? `Unclosed "${stack[stack.length - 1]}".` : undefined;
}

/** Static (no-GPU) check. Passing this does not guarantee the WGSL compiles. */
export function validateCustomExpression(
  expression: string,
): CustomExpressionValidation {
  const trimmed = expression.trim();
  if (!trimmed) {
    return { ok: false, error: 'Expression is empty.' };
  }
  if (trimmed.length > MAX_CUSTOM_EXPRESSION_LENGTH) {
    return {
      ok: false,
      error: `Expression is too long (max ${MAX_CUSTOM_EXPRESSION_LENGTH} characters).`,
    };
  }
  for (const { pattern, message } of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) return { ok: false, error: message };
  }
  const unbalanced = checkBalanced(trimmed);
  if (unbalanced) return { ok: false, error: unbalanced };
  return { ok: true };
}

/** FNV-1a — stable across reloads so a saved project reuses its cached pipeline. */
function hashExpression(expression: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < expression.length; i++) {
    hash ^= expression.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Runtime shader id for a custom expression (`custom#<hash>`). */
export function customTransitionId(expression: string): string {
  return `${CUSTOM_TRANSITION_TYPE}#${hashExpression(expression.trim())}`;
}

export function isCustomTransitionId(id: string): boolean {
  return id === CUSTOM_TRANSITION_TYPE || id.startsWith(`${CUSTOM_TRANSITION_TYPE}#`);
}

/**
 * Four generic knobs wired to `custom0`-`custom3` — an expression has no other
 * way to take input, so every custom transition gets the full set.
 */
const CUSTOM_PARAMS: TransitionParamDef[] = [0, 1, 2, 3].map((i) => ({
  key: `custom${i}`,
  label: `Custom ${i}`,
  type: 'float' as const,
  default: 0,
  min: -8,
  max: 8,
  step: 0.1,
}));

export function buildCustomTransitionDef(
  expression: string,
  id = customTransitionId(expression),
): TransitionDef {
  return {
    id,
    label: 'Custom (WGSL)',
    description: 'User-supplied WGSL expression evaluated per pixel',
    xfadeName: 'fade',
    wgslBody: `\n  result = (${expression.trim()});\n`,
    params: CUSTOM_PARAMS,
  };
}

/** Insertion-ordered LRU of compiled custom variants. */
const customDefs = new Map<string, TransitionDef>();

/**
 * Register an expression and return the shader id to render it with.
 * Invalid expressions fall back to the base `custom` id (a plain dissolve),
 * so a half-typed shader never breaks playback.
 */
export function registerCustomTransition(expression: string): string {
  if (!validateCustomExpression(expression).ok) return CUSTOM_TRANSITION_TYPE;
  const id = customTransitionId(expression);
  const existing = customDefs.get(id);
  if (existing) {
    // Refresh recency.
    customDefs.delete(id);
    customDefs.set(id, existing);
    return id;
  }
  customDefs.set(id, buildCustomTransitionDef(expression, id));
  while (customDefs.size > MAX_CUSTOM_VARIANTS) {
    const oldest = customDefs.keys().next().value;
    if (oldest === undefined) break;
    customDefs.delete(oldest);
  }
  return id;
}

export function getCustomTransitionDef(id: string): TransitionDef | undefined {
  return customDefs.get(id);
}

export function __clearCustomTransitionsForTests(): void {
  customDefs.clear();
}

export interface CustomCompileResult {
  ok: boolean;
  error?: string;
}

/**
 * Compile the expression on the real device so the editor can surface the
 * driver's diagnostics. The module is thrown away — this only type-checks the
 * WGSL, it never becomes a pipeline.
 */
export async function compileCustomTransition(
  device: GPUDevice,
  expression: string,
): Promise<CustomCompileResult> {
  const staticCheck = validateCustomExpression(expression);
  if (!staticCheck.ok) return staticCheck;

  const code = buildTransitionShader(buildCustomTransitionDef(expression));

  device.pushErrorScope('validation');
  let module: GPUShaderModule | null = null;
  let thrown: string | undefined;
  try {
    module = device.createShaderModule({ code });
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  // Always drain the scope we pushed, even when the call above threw.
  const scopedError = await device.popErrorScope().catch(() => null);

  if (thrown) return { ok: false, error: thrown };
  if (scopedError) return { ok: false, error: scopedError.message };
  if (!module) return { ok: false, error: 'WGSL compilation failed.' };

  try {
    const info = await module.getCompilationInfo();
    const firstError = info.messages.find((m) => m.type === 'error');
    if (firstError) return { ok: false, error: formatCompilationMessage(firstError) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

function formatCompilationMessage(message: GPUCompilationMessage): string {
  const text = message.message.trim();
  // Line numbers are template-relative and meaningless to the user.
  return text.length > 0 ? text : 'WGSL compilation failed.';
}
