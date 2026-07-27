import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  grep: /PDF preview (skips the text read and renders pages through bounded ranges|survives Retina pinch zoom and repeated sidebar\/window resizing)/,
  workers: 1,
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
