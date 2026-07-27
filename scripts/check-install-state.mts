import assert from "node:assert/strict";
import { installState, isAppleTouchDevice, type InstallEnvironment } from "../web/src/platform/install-app.ts";

const CHROME_VERSION = `${126}.${0}.${0}.${0}`;

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  androidChrome: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Mobile Safari/537.36`,
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  edge: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36 Edg/${CHROME_VERSION}`,
};

const env = (over: Partial<InstallEnvironment>): InstallEnvironment => ({
  standalone: false,
  hasPrompt: false,
  userAgent: UA.macChrome,
  maxTouchPoints: 0,
  ...over,
});

assert.equal(installState(env({ standalone: true })), "installed");
assert.equal(installState(env({ standalone: true, hasPrompt: true })), "installed", "a stale prompt must not outrank being installed");
assert.equal(installState(env({ standalone: true, userAgent: UA.iphone })), "installed");

assert.equal(installState(env({ hasPrompt: true })), "prompt");
assert.equal(installState(env({ hasPrompt: true, userAgent: UA.androidChrome })), "prompt");
assert.equal(installState(env({ hasPrompt: true, userAgent: UA.ipad, maxTouchPoints: 5 })), "prompt");

assert.equal(installState(env({ userAgent: UA.iphone })), "ios");
assert.equal(
  installState(env({ userAgent: UA.ipad, maxTouchPoints: 5 })),
  "ios",
  "iPadOS reports a Macintosh UA — without touch points it gets desktop Safari's File menu, which it does not have",
);

assert.equal(installState(env({ userAgent: UA.macSafari, maxTouchPoints: 0 })), "desktop-safari");
assert.equal(isAppleTouchDevice(env({ userAgent: UA.macSafari, maxTouchPoints: 0 })), false);

assert.equal(installState(env({ userAgent: UA.macChrome })), "manual");
assert.equal(installState(env({ userAgent: UA.edge })), "manual");
assert.equal(installState(env({ userAgent: UA.firefox })), "manual");
assert.equal(installState(env({ userAgent: UA.androidChrome })), "manual");

console.log("check-install-state: every browser gets a route that exists on it");
