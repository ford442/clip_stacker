import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initCaptionProviders } from "./utils/captionProviderBootstrap";

// Auto-caption backends. Registering here (rather than inside a component)
// keeps the registry out of React's lifecycle and lets tests reset it.
initCaptionProviders();

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
