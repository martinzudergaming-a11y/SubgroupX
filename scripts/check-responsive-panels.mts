import assert from "node:assert/strict";
import {
  INITIAL_PANEL_PREFERENCES,
  panelVisibility,
  shellLayoutFor,
  updatePanelPreference,
} from "../web/src/dashboard/shell/use-responsive-panels.ts";

assert.equal(shellLayoutFor(true, false), "mobile");
assert.equal(shellLayoutFor(false, true), "narrow");
assert.equal(shellLayoutFor(false, false), "wide");

let preferences = INITIAL_PANEL_PREFERENCES;
preferences = updatePanelPreference(preferences, "wide", "left", false);
preferences = updatePanelPreference(preferences, "wide", "right", true);
assert.deepEqual(panelVisibility(preferences, "wide"), { leftOpen: false, rightOpen: true });

assert.deepEqual(panelVisibility(preferences, "narrow"), { leftOpen: false, rightOpen: false });
assert.deepEqual(panelVisibility(preferences, "mobile"), { leftOpen: false, rightOpen: false });
assert.deepEqual(panelVisibility(preferences, "wide"), { leftOpen: false, rightOpen: true });

preferences = updatePanelPreference(preferences, "narrow", "right", (open) => !open);
preferences = updatePanelPreference(preferences, "mobile", "left", true);
assert.deepEqual(panelVisibility(preferences, "narrow"), { leftOpen: false, rightOpen: true });
assert.deepEqual(panelVisibility(preferences, "mobile"), { leftOpen: true, rightOpen: false });
assert.deepEqual(panelVisibility(preferences, "wide"), { leftOpen: false, rightOpen: true });

console.log("OK responsive-panels: breakpoint probes preserve each presentation's panel intent");
