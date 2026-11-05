import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { initCaptionProviders } from "./app/captionProviderBootstrap";
import { installFinishingPresetApi } from "./actions/finishingPresetApi";
import { testHarnessRequested } from "./app/harnessBindings";

// Auto-caption backends. Registering here (rather than inside a component)
// keeps the registry out of React's lifecycle and lets tests reset it.
initCaptionProviders();

// `window.clipStacker.finishing` + the apply-preset event, for tools and AI
// agents running in this page (docs/finishing-presets.md).
installFinishingPresetApi();

// `?test_harness` (e2e/): `window.clipStacker.test`. A separate chunk, never
// loaded — or present on `window` — without the query parameter.
if (testHarnessRequested()) {
  void import("./app/testHarness/harness").then(({ installTestHarness }) => installTestHarness());
}

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
