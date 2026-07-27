export type CanvasTheme = "broadsheet" | "console" | "terminal" | "bureau";

const CONTRACT = "--bg --surface --fill --border --border-strong --text --text-muted --accent --accent-text --font-ui --font-mono --font-serif --radius --shadow";

const FONTS = {
  ui: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`,
  mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`,
  serif: `Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif`,
};

function baseReset(): string {
  return `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:var(--font-ui);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,h4{color:var(--text);line-height:1.2;margin:1.4em 0 .5em;font-weight:600;letter-spacing:-.011em}
h1{font-size:1.6rem} h2{font-size:1.25rem} h3{font-size:1.05rem}
p{margin:0 0 1em;max-width:68ch}
a{color:var(--accent-text);text-decoration:none} a:hover{text-decoration:underline}
small,.muted{color:var(--text-muted)}
hr{border:0;border-top:1px solid var(--border);margin:1.5em 0}
code,kbd,pre{font-family:var(--font-mono)}
code{font-size:.9em;background:var(--fill);padding:.1em .35em;border-radius:4px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:.95em}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{color:var(--text-muted);font-weight:600;font-size:.82em;letter-spacing:.02em;text-transform:uppercase}
.card,section.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
button{font:inherit;color:var(--text);background:var(--fill);border:1px solid var(--border);border-radius:var(--radius);
  padding:.5em .9em;cursor:pointer;transition:background .12s,border-color .12s}
button:hover{border-color:var(--border-strong)}
button.primary,button[data-variant="primary"]{background:var(--accent);border-color:var(--accent);color:#fff}
button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
input,textarea,select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:.5em .7em}
input:focus,textarea:focus,select:focus,button:focus-visible{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
label{color:var(--text-muted);font-size:.86rem;display:block;margin:0 0 .3em}
::selection{background:color-mix(in srgb,var(--accent) 24%,transparent)}
`;
}

const VARS: Record<CanvasTheme, { light: string; dark: string; extra?: string }> = {
  broadsheet: {
    light: `--bg:#fdfdfc;--surface:#f9f9f8;--fill:#f1f0ef;--border:#e3e2df;--border-strong:#dad9d6;
      --text:#21201c;--text-muted:#63635e;--accent:#ab6400;--accent-text:#ab6400;
      --font-ui:${FONTS.serif};--font-mono:${FONTS.mono};--font-serif:${FONTS.serif};--radius:5px;
      --shadow:0 1px 2px rgba(0,0,0,.04)`,
    dark: `--bg:#111110;--surface:#191918;--fill:#222221;--border:#33322e;--border-strong:#3b3a37;
      --text:#eeeeec;--text-muted:#b5b3ad;--accent:#ffca16;--accent-text:#ffca16;--shadow:none`,
    extra: `body{font-size:1.0625rem;line-height:1.65}h1{font-size:1.9rem;letter-spacing:-.02em}`,
  },
  console: {
    light: `--bg:#fcfcfd;--surface:#f9f9fb;--fill:#f0f0f3;--border:#e4e4e9;--border-strong:#d9d9e0;
      --text:#1c2024;--text-muted:#60646c;--accent:#0090ff;--accent-text:#0d74ce;
      --font-ui:${FONTS.ui};--font-mono:${FONTS.mono};--font-serif:${FONTS.serif};--radius:8px;
      --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.04)`,
    dark: `--bg:#111113;--surface:#18191b;--fill:#212225;--border:#2a2d31;--border-strong:#363a3f;
      --text:#edeef0;--text-muted:#b0b4ba;--accent:#0090ff;--accent-text:#70b8ff;--shadow:none`,
    extra: `body{font-size:14px}.metric{font-variant-numeric:tabular-nums;font-size:2rem;font-weight:600}`,
  },
  terminal: {
    light: `--bg:#f7f7f6;--surface:#efefee;--fill:#e7e7e5;--border:#d9d9d6;--border-strong:#c9c9c5;
      --text:#1a1a18;--text-muted:#575752;--accent:#218358;--accent-text:#218358;
      --font-ui:${FONTS.mono};--font-mono:${FONTS.mono};--font-serif:${FONTS.serif};--radius:4px;--shadow:none`,
    dark: `--bg:#111110;--surface:#191918;--fill:#222221;--border:#33322e;--border-strong:#3b3a37;
      --text:#eeeeec;--text-muted:#b5b3ad;--accent:#3dd68c;--accent-text:#70b8ff;--shadow:none`,
    extra: `body{font-family:var(--font-mono);font-size:.8125rem;line-height:1.6}`,
  },
  bureau: {
    light: `--bg:#ffffff;--surface:#fafafa;--fill:#f4f4f5;--border:#e4e4e7;--border-strong:#d4d4d8;
      --text:#18181b;--text-muted:#71717a;--accent:#0090ff;--accent-text:#0d74ce;
      --font-ui:${FONTS.ui};--font-mono:${FONTS.mono};--font-serif:${FONTS.serif};--radius:6px;
      --shadow:0 4px 12px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.05)`,
    dark: `--bg:#18181b;--surface:#212124;--fill:#27272a;--border:#3f3f46;--border-strong:#52525b;
      --text:#f4f4f5;--text-muted:#a1a1aa;--accent:#3b9eff;--accent-text:#70b8ff;--shadow:0 4px 12px rgba(0,0,0,.3)`,
  },
};

export function canvasThemeStyle(theme?: string): string {
  if (!theme || !(theme in VARS)) return "";
  const v = VARS[theme as CanvasTheme];
  return `<style data-canvas-theme="${theme}">
:root{${v.light}}
@media (prefers-color-scheme: dark){:root{${v.dark}}}
${baseReset()}${v.extra ?? ""}
</style>`;
}

export const CANVAS_THEME_DOC =
  `broadsheet = warm editorial serif document (notes, long-form); ` +
  `console = cool minimal dashboard, tabular numbers (KPIs, stats); ` +
  `terminal = dark mono technical (logs, code, technical widgets); ` +
  `bureau = clean neutral form/widget (forms, settings, inputs). ` +
  `Each fills the same CSS variables [${CONTRACT}] and a quiet base reset, both with light+dark. ` +
  `Style by referencing the variables (e.g. color:var(--text); background:var(--surface); ` +
  `border:1px solid var(--border)) — do NOT hardcode colours.`;
