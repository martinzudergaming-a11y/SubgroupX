import { INTERP_LANG } from "../../files/languages";

export interface ShellSegment {
  lang: string;
  code: string;
}

export function splitHeredoc(command: string): ShellSegment[] {
  const open = command.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
  if (!open || open.index === undefined) return [{ lang: 'bash', code: command }];
  const nl = command.indexOf('\n', open.index);
  if (nl === -1) return [{ lang: 'bash', code: command }];
  const closeRe = new RegExp(`\\n${open[1] === '-' ? '[ \\t]*' : ''}${open[3]}[ \\t]*['"]?(?=\\n|$)`);
  const m = command.slice(nl).match(closeRe);
  if (!m || m.index === undefined) return [{ lang: 'bash', code: command }];
  const closeAbs = nl + m.index;

  const before = command.slice(0, open.index).trim().split(/\s+/);
  let lang = 'plaintext';
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const w = (before[i].replace(/['"]/g, '').split('/').pop() || '').toLowerCase();
    if (INTERP_LANG[w]) { lang = INTERP_LANG[w]; break; }
  }

  return [
    { lang: 'bash', code: command.slice(0, nl) },
    { lang, code: command.slice(nl + 1, closeAbs) },
    { lang: 'bash', code: command.slice(closeAbs + 1) },
  ];
}
