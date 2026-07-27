import assert from "node:assert/strict";
import { seedContextTokensFromTranscript } from "../server/src/runtime/context-accounting.ts";
import type { Message } from "@earendil-works/pi-ai";

const PREFIX = "[Conversation summary]";

const user = (text: string, ts: number): Message =>
  ({ role: "user", content: text, timestamp: ts }) as Message;
const assistant = (totalTokens: number, ts: number): Message =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "…" }],
    timestamp: ts,
    usage: { totalTokens },
  }) as unknown as Message;

{
  const messages: Message[] = [
    user(`${PREFIX} The earlier part of this conversation was compacted…`, 1000),
    user("retained user message", 800),
    assistant(267_229, 900),
  ];
  const seed = seedContextTokensFromTranscript(messages, PREFIX);
  assert.equal(seed, 0, `post-compaction rebuild must seed 0, got ${seed} (stale pre-compaction base)`);
  console.log("✓ post-compaction rebuild seeds 0 (stale retained usage ignored)");
}

{
  const messages: Message[] = [
    user(`${PREFIX} …`, 1000),
    assistant(267_229, 900),
    user("next question", 1100),
    assistant(48_000, 1200),
  ];
  assert.equal(seedContextTokensFromTranscript(messages, PREFIX), 48_000);
  console.log("✓ post-compaction fresh turn seeds its measured total");
}

{
  const messages: Message[] = [user("q1", 10), assistant(120_000, 20), user("q2", 30)];
  assert.equal(seedContextTokensFromTranscript(messages, PREFIX), 120_000);
  console.log("✓ un-compacted transcript seeds the last measured total");
}

{
  const messages: Message[] = [user(`${PREFIX} …`, 1000), user("hello", 1100)];
  assert.equal(seedContextTokensFromTranscript(messages, PREFIX), 0);
  console.log("✓ transcript without measured turns seeds 0");
}

{
  const legacy = (m: Partial<Message>) => ({ ...m, timestamp: undefined }) as unknown as Message;
  const messages: Message[] = [
    legacy({ role: "assistant", content: [{ type: "text", text: "…" }], usage: { totalTokens: 250_000 } } as never),
    legacy({ role: "user", content: `${PREFIX} …` } as never),
    legacy({ role: "assistant", content: [{ type: "text", text: "…" }], usage: { totalTokens: 30_000 } } as never),
  ];
  assert.equal(seedContextTokensFromTranscript(messages, PREFIX), 30_000);
  console.log("✓ timestampless legacy transcript falls back to the position rule");
}

console.log("check-context-seed: all cases passed");
