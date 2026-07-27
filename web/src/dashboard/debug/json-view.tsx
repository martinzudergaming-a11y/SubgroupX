import { useMemo } from "react";
import { KIND_CLASS, prettyOf, tokenizeLine } from "./json-view-helpers";

export { JsonTree } from "./JsonTree";
export { JsonDiff } from "./JsonDiff";

export function JsonView({ value }: { value: unknown }) {
  const lines = useMemo(() => {
    let lineSeq = 0;
    return prettyOf(value)
      .split("\n")
      .map((line) => {
        let tokSeq = 0;
        const num = ++lineSeq;
        return {
          key: `${num} ${line}`,
          num,
          toks: tokenizeLine(line).map((tok) => ({ ...tok, key: `${tokSeq++} ${tok.kind} ${tok.text}` })),
        };
      });
  }, [value]);
  const gutterW = String(lines.length).length;
  return (
    <div data-testid="json-view" className="h-full min-h-0 overflow-auto rounded-lg bg-[#FAFAFA] dark:bg-[#171717] border border-[#F0F0F0] dark:border-[#2A2A2A] font-mono text-[11.5px] leading-relaxed">
      <table className="border-collapse w-full">
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="align-top">
              <td
                className="select-none text-right pr-3 pl-3 text-[#C4C4C4] dark:text-[#555] tabular-nums sticky left-0 bg-[#FAFAFA] dark:bg-[#171717]"
                style={{ minWidth: `${gutterW + 2}ch` }}
              >
                {line.num}
              </td>
              <td className="pr-4 whitespace-pre">
                {line.toks.map((tok) => (
                  <span key={tok.key} className={KIND_CLASS[tok.kind]}>
                    {tok.text}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
