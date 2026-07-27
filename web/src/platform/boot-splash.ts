const FADE_MS = 280;
const CURTAIN_SETTLE_MS = 640;

export function removeBootSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("splash--out");
  const remove = () => splash.remove();
  splash.addEventListener("transitionend", remove, { once: true });
  window.setTimeout(remove, FADE_MS + 120);
}

export function lowerCurtain(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const existing = document.getElementById("splash");
  if (existing) return new Promise((resolve) => window.setTimeout(resolve, FADE_MS));

  const splash = document.createElement("div");
  splash.id = "splash";
  splash.setAttribute("aria-hidden", "true");
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  splash.style.cssText = [
    "position:fixed", "inset:0", "z-index:2147483000",
    "display:flex", "align-items:center", "justify-content:center",
    `background-color:${dark ? "#1E1E1E" : "#F1F4ED"}`,
    `transition:opacity ${FADE_MS}ms ease`,
  ].join(";");
  splash.innerHTML =
    '<div class="splash-lockup">' +
    '<span class="splash-diamond"></span>' +
    '<span class="splash-groupx">SUBGROUP<span class="splash-x">X</span></span>' +
    '<span class="splash-rule"></span>' +
    '<span class="splash-oiia">oiia</span>' +
    "</div>";
  splash.style.opacity = "0";
  document.body.appendChild(splash);
  void splash.getBoundingClientRect();
  splash.style.opacity = "1";

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  return new Promise((resolve) => window.setTimeout(resolve, reduced ? 60 : CURTAIN_SETTLE_MS));
}
