import { JsonNode } from "./JsonNode";

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div
      data-testid="json-tree"
      className="h-full min-h-0 overflow-auto rounded-lg bg-[#FAFAFA] dark:bg-[#171717] border border-[#F0F0F0] dark:border-[#2A2A2A] p-3 pl-4 font-mono text-[11.5px] leading-relaxed"
    >
      <JsonNode value={value} depth={0} trailingComma={false} />
    </div>
  );
}
