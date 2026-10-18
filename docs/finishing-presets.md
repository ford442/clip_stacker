# Finishing presets

A finishing preset is a whole finishing stack (noise reduction → primary →
curves → secondary → LUT → sharpen → chromatic aberration → bloom → grain)
saved under a name. Presets live in the browser (localStorage
`clip_stacker.finishingPresets.v1`), so they work in every project; they are
never written into a project file.

Where to use them:

- **Export tab → Finishing → Finishing presets** — built-ins, your presets,
  *Save current as preset*, Apply / Rename / Export (`.json`) / Delete, and
  *Import JSON* (paste, drop a file, or *Open .json…*).
- **Effects Stack → Preset…** under the preview — quick apply.

Applying a preset is **one undo step** (Ctrl+Z restores the previous stack).
An invalid preset is rejected as a whole, with the reason for every problem;
nothing is partially applied.

## Built-in presets

| Name | What it does |
| --- | --- |
| Clean | Edge-aware denoise and gentle, halo-free sharpening |
| Film look | Soft S-curve, warm highlights, subtle bloom, 35mm film grain |
| High contrast | Strong S-curve, richer colour, multi-scale detail |
| Soft | Lifted matte blacks, gentle desaturation, light glow, fine grain |

Saving a preset with a built-in's name replaces that built-in in the list;
deleting your preset brings the built-in back.

## Format

```json
{
  "schema": "clip_stacker.finishing-preset",
  "version": 1,
  "name": "Night city glow",
  "description": "Optional, shown as a tooltip",
  "apply": "replace",
  "finishing": {
    "curves": {
      "enabled": true,
      "levels": { "outBlack": 0.04 },
      "curves": { "master": [{ "x": 0, "y": 0 }, { "x": 0.25, "y": 0.2 }, { "x": 0.75, "y": 0.82 }, { "x": 1, "y": 1 }] }
    },
    "bloom": { "enabled": true, "amount": 0.35, "radius": 0.45, "tint": [1, 0.8, 0.6] },
    "grain": { "enabled": true, "quality": "film", "amount": 0.25 }
  }
}
```

- `finishing` has the same shape a saved project stores (`Project.finishing`),
  so a project's stack and a preset are interchangeable. Every pass and every
  field is optional; missing fields take the pass defaults.
- `apply: "replace"` (default) — the preset **is** the stack: passes it omits
  are switched off.
- `apply: "merge"` — only the passes it names change, deep-merged onto the
  current stack (e.g. `{"apply": "merge", "finishing": {"grain": {"amount": 0.4}}}`).
- A bare finishing object (`{"grain": {…}}`) is accepted as a `replace` preset.
- A custom LUT is embedded: `"lut": {"enabled": true, "lutId": "custom",
  "customCubeText": "<.cube text>"}`; bundled LUTs are referenced by id
  (`teal-orange`, `film`, `bleach`, `warm`).

Every field, its range and meaning is in the JSON Schema
[`finishing-preset.schema.json`](./finishing-preset.schema.json) (draft
2020-12). It is generated from the same field specs the validator uses
(`src/utils/finishingPresets.ts`), and a test fails if the committed file is
stale — regenerate with
`UPDATE_FINISHING_SCHEMA=1 npx vitest --run src/utils/finishingPresets.test.ts`.

Validation is strict: unknown passes or fields (typos such as `grian` or
`ammount`), wrong types, out-of-range numbers, an input white point not above
the black point, curves with fewer than two knots, and a custom LUT whose
`.cube` text does not parse are all reported with their JSON path.

## For AI agents

*Copy format for agents* (in the import box) puts instructions, an example and
the JSON Schema on the clipboard — give that to the agent and paste back what
it returns. Tools running in the page (browser automation, devtools) can also
call the app directly:

```js
// Validate / apply / save
clipStacker.finishing.validate(presetJsonOrObject)  // → { ok, errors, warnings, name, summary }
clipStacker.finishing.apply(presetJsonOrObject, { save: true })
clipStacker.finishing.applyPreset('Film look')
clipStacker.finishing.get()        // the current stack (a copy)
clipStacker.finishing.list()       // preset names
clipStacker.finishing.schema()     // the JSON Schema
clipStacker.finishing.agentBrief() // the same text as "Copy format for agents"

// Or with events, no globals:
window.addEventListener('clip-stacker:finishing-preset-result', (e) => console.log(e.detail));
window.dispatchEvent(new CustomEvent('clip-stacker:apply-finishing-preset', {
  detail: { preset: { finishing: { grain: { enabled: true, amount: 0.3 } } }, save: false },
}));
```

Both paths go through the same validate → apply (one undo step) code as the
UI. There is deliberately no cross-origin `postMessage` listener: only code
already running in the page can change the grade.
