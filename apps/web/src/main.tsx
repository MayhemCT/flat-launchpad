import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// A tab that was opened before the site was last deployed still names the old build's files. When it then
// opens a page whose code it has not loaded yet, that file is gone and the page would stay blank. Vite reports
// this as `vite:preloadError`: the tab is reloaded once, which brings the current build. The time of the last
// such reload is kept for this tab, so a file that is truly missing cannot make it reload forever.
const RELOADED_KEY = "callz.reloaded-for-build";
window.addEventListener("vite:preloadError", (event) => {
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(RELOADED_KEY) ?? 0);
    if (Date.now() - last < 60_000) return;
    window.sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    // Without storage there is no way to tell a second reload from the first: leave the error to show.
    return;
  }
  // The page is about to be replaced: the failed import does not need to reach the console as well.
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
