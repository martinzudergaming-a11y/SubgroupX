export type BashPrinter = (cmd: string) => string;

export const BASH_CHAIN_BREAK_LEN = 72;

interface MvdanShLike {
  syntax: {
    NewParser: (...opts: unknown[]) => { Parse: (src: string, name: string) => MvdanFile };
    NewPrinter: (...opts: unknown[]) => { Print: (file: MvdanFile) => string };
    KeepComments: (on: boolean) => unknown;
    Indent: (n: number) => unknown;
    BinaryNextLine: (on: boolean) => unknown;
  };
}
interface MvdanFile { Stmts?: MvdanStmt[] }
interface MvdanStmt { Cmd?: MvdanNode }
interface MvdanNode {
  $type?: unknown;
  X?: MvdanStmt;
  OpPos?: { Offset: () => number };
}

export function createShfmtPrinter(shModule: unknown): BashPrinter {
  const sh = ((shModule as { default?: MvdanShLike }).default ?? shModule) as MvdanShLike;
  const parser = sh.syntax.NewParser(sh.syntax.KeepComments(true));
  const printer = sh.syntax.NewPrinter(sh.syntax.Indent(2), sh.syntax.BinaryNextLine(true));

  const isAndOrChain = (node: MvdanNode | undefined, src: string): number[] => {
    const offsets: number[] = [];
    let cur = node;
    while (cur && String(cur.$type ?? "").includes("BinaryCmd") && cur.OpPos) {
      const off = cur.OpPos.Offset();
      const op = src.slice(off, off + 2);
      if (op !== "&&" && op !== "||") break;
      offsets.push(off);
      cur = cur.X?.Cmd ? cur.X.Cmd : undefined;
    }
    return offsets;
  };

  return (cmd: string): string => {
    const file = parser.Parse(cmd, "command.sh");
    const trimmed = cmd.trim();
    if (trimmed.length > BASH_CHAIN_BREAK_LEN && !trimmed.includes("\n") && /^[\x20-\x7E\t]*$/.test(cmd)) {
      const offsets = (file.Stmts ?? [])
        .flatMap((stmt) => isAndOrChain(stmt.Cmd, cmd))
        .sort((a, b) => b - a);
      if (offsets.length > 0) {
        let broken = cmd;
        for (const off of offsets) broken = `${broken.slice(0, off + 2)}\n${broken.slice(off + 2)}`;
        try {
          return printer.Print(parser.Parse(broken, "command.sh"));
        } catch {
        }
      }
    }
    return printer.Print(file);
  };
}

export const BASH_FORMAT_MAX_LEN = 20_000;

export function createBashFormatter(print: BashPrinter, cacheCap = 300) {
  const cache = new Map<string, string | null>();
  const format = (cmd: string): string | null => {
    const hit = cache.get(cmd);
    if (hit !== undefined) return hit;
    let out: string | null = null;
    const trimmed = cmd.trim();
    if (trimmed !== '' && cmd.length <= BASH_FORMAT_MAX_LEN) {
      try {
        const clean = print(cmd).trimEnd();
        out = clean === '' || clean === trimmed ? null : clean;
      } catch {
        out = null;
      }
    }
    if (cache.size >= cacheCap) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cmd, out);
    return out;
  };
  const peek = (cmd: string): string | null | undefined => cache.get(cmd);
  return { format, peek };
}
