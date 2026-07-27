import { useI18n } from "../i18n";

export function LangToggle({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  const target = locale === "en" ? "zh" : "en";
  return (
    <button
      type="button"
      className={`lang-toggle ${className}`}
      onClick={() => setLocale(target)}
      aria-label={target === "zh" ? "切换到中文" : "Switch to English"}
      title={target === "zh" ? "切换到中文" : "Switch to English"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
      </svg>
      <span>{target === "zh" ? "中文" : "EN"}</span>
    </button>
  );
}
