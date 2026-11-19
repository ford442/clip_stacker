/**
 * The app's Render action, bound by the composition root (`App.tsx`) once it
 * mounts, for callers below the component layer: the scripting API
 * (`window.clipStacker.project.render`) and the `?test_harness`.
 */
export const renderBinding: { performRender: (() => Promise<void>) | null } = { performRender: null };
