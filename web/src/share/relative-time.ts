import type { TFunction } from "../i18n";

export function relativeShareTime(ms: number, t: TFunction): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("share.relative.now");
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t("share.relative.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("share.relative.hoursAgo", { n: hours });
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}
