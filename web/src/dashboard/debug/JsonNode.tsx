import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  KIND_CLASS,
  STRING_INLINE_CAP,
  collapsedSummary,
  primitiveClass,
  primitiveText,
} from "./json-view-helpers";

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= STRING_INLINE_CAP) {
    return <span className={KIND_CLASS.string}>{JSON.stringify(value)}</span>;
  }
  const shown = expanded ? value : value.slice(0, STRING_INLINE_CAP);
  return (
    <span className={KIND_CLASS.string}>
      {JSON.stringify(shown)}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((x) => !x);
        }}
        className="ml-1 align-baseline rounded px-1 text-[10px] not-italic text-[#888] dark:text-[#999] bg-[#EEE] dark:bg-[#2A2A2A] hover:bg-[#E2E2E2] dark:hover:bg-[#333]"
      >
        {expanded ? "less" : `+${value.length - STRING_INLINE_CAP} chars`}
      </button>
    </span>
  );
}

function nodeKey(name: string | number, isArrayIndex: boolean) {
  return (
    <span className={isArrayIndex ? "text-[#B0B0B0] dark:text-[#666]" : KIND_CLASS.key}>
      {isArrayIndex ? name : JSON.stringify(name)}
      <span className={KIND_CLASS.punct}>: </span>
    </span>
  );
}

export function JsonNode({
  name,
  isArrayIndex,
  value,
  depth,
  trailingComma,
}: {
  name?: string | number;
  isArrayIndex?: boolean;
  value: unknown;
  depth: number;
  trailingComma: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isArr = Array.isArray(value);
  const isObj = !isArr && value !== null && typeof value === "object";

  if (!isArr && !isObj) {
    return (
      <div className="whitespace-pre-wrap break-words">
        {name !== undefined && nodeKey(name, !!isArrayIndex)}
        {typeof value === "string" ? <StringValue value={value} /> : <span className={primitiveClass(value)}>{primitiveText(value)}</span>}
        {trailingComma && <span className={KIND_CLASS.punct}>,</span>}
      </div>
    );
  }

  const entries: Array<[string | number, unknown]> = isArr
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const openB = isArr ? "[" : "{";
  const closeB = isArr ? "]" : "}";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start text-left cursor-pointer rounded hover:bg-[#F0F0F0] dark:hover:bg-[#222] -ml-3.5 pl-3.5"
      >
        <ChevronRight
          className={`mt-[3px] mr-0.5 size-3 shrink-0 text-[#999] dark:text-[#777] transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="whitespace-pre-wrap break-words">
          {name !== undefined && nodeKey(name, !!isArrayIndex)}
          <span className={KIND_CLASS.punct}>{openB}</span>
          {!open && (
            <>
              <span className="mx-1 text-[#AAA] dark:text-[#666] italic">{collapsedSummary(value as never, isArr)}</span>
              <span className={KIND_CLASS.punct}>{closeB}</span>
              {trailingComma && <span className={KIND_CLASS.punct}>,</span>}
            </>
          )}
        </span>
      </button>
      {open && (
        <>
          <div className="ml-[7px] pl-3 border-l border-[#ECECEC] dark:border-[#2D2D2D]">
            {entries.map(([k, v], i) => (
              <JsonNode
                key={k}
                name={k}
                isArrayIndex={isArr}
                value={v}
                depth={depth + 1}
                trailingComma={i < entries.length - 1}
              />
            ))}
          </div>
          <div className="whitespace-pre-wrap">
            <span className={KIND_CLASS.punct}>{closeB}</span>
            {trailingComma && <span className={KIND_CLASS.punct}>,</span>}
          </div>
        </>
      )}
    </div>
  );
}
