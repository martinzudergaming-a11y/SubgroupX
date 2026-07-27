export function installSystemColorScheme(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
