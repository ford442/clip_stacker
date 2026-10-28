import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initCaptionProviders } from "./utils/captionProviderBootstrap";
import { installFinishingPresetApi } from "./utils/finishingPresetApi";

// Auto-caption backends. Registering here (rather than inside a component)
// keeps the registry out of React's lifecycle and lets tests reset it.
initCaptionProviders();

// `window.clipStacker.finishing` + the apply-preset event, for tools and AI
// agents running in this page (docs/finishing-presets.md).
installFinishingPresetApi();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
