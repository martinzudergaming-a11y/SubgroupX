import assert from "node:assert/strict";
import shMod from "mvdan-sh";
import { createBashFormatter, createShfmtPrinter, BASH_FORMAT_MAX_LEN, BASH_CHAIN_BREAK_LEN } from "../web/src/conversation/markdown/bash-format-core.ts";

const { format, peek } = createBashFormatter(createShfmtPrinter(shMod));

{
  const cmd = `for meta in "script-src-elem 'unsafe-inline'" "script-src 'unsafe-inline'"; do echo "== $meta =="; curl -s "https://example.com/?p=$meta" | grep -c ok; done`;
  const out = await format(cmd);
  assert.ok(out, "for-loop one-liner formats");
  const lines = out.split("\n");
  assert.ok(lines.length >= 4, `for-loop expands to multiple lines (got ${lines.length})`);
  assert.ok(lines[0].startsWith("for meta in"), "opener stays first");
  assert.ok(lines.some((l) => l.startsWith("  ")), "body is indented 2 spaces");
  assert.equal(lines.at(-1), "done", "closer on its own line");
  assert.equal(await format(out), null, "formatting is idempotent");
}

{
  const out = await format(`echo a; echo b; cd /x; ls -la`);
  assert.ok(out, ";-chain formats");
  assert.deepEqual(out.split("\n"), ["echo a", "echo b", "cd /x", "ls -la"]);
}

{
  assert.equal(await format(`git status --short`), null, "no-op short command → null");
}

{
  assert.equal(await format(`for meta in "script-src-elem 'unsafe-inl`), null, "unterminated quote → null");
  await format(`cd /app && npm insta`);
}

{
  assert.equal(await format(``), null, "empty → null");
  assert.equal(await format(`   \n `), null, "whitespace → null");
  assert.equal(await format(`echo ` + `x`.repeat(BASH_FORMAT_MAX_LEN)), null, "oversized → null");
}

{
  const cmd = `cat <<'EOF' > /tmp/c.yaml\nserver:\n  port: 8080\nEOF\necho done`;
  const out = await format(cmd);
  const body = (out ?? cmd);
  assert.ok(body.includes("server:") && body.includes("  port: 8080"), "heredoc body intact");
}

{
  const cmd = `echo a; echo b`;
  await format(cmd);
  assert.notEqual(peek(cmd), undefined, "formatted result is cached");
}

{
  const cmd = `mkdir -p /x/y && cd /x/y && curl -sL https://ex.com/t.tar.gz | tar xz && make -j4 || echo "build && install failed"`;
  const out = await format(cmd);
  assert.ok(out, "long &&/|| chain formats");
  const lines = out.split("\n");
  assert.equal(lines[0], "mkdir -p /x/y \\", "first segment stays first, continuation-escaped");
  assert.ok(lines.slice(1, -1).every((l) => l.startsWith("  && ") || l.startsWith("  || ")), "continuations lead with their operator");
  assert.ok(lines.some((l) => l.includes("| tar xz")), "pipes stay inline inside their segment");
  assert.ok(out.includes(`"build && install failed"`), "quoted && is never split");
  assert.equal(await format(out), null, "chain-broken output is idempotent");
}

{
  assert.equal(await format(`npm test && git push`), null, "short chain stays a one-liner");
  const zh = `echo "构建完成" && echo done-${"x".repeat(BASH_CHAIN_BREAK_LEN)}`;
  const out = await format(zh);
  assert.ok(out === null || !out.includes("\\"), "non-ASCII long chain is not offset-split");
}

console.log("check-bash-format: all assertions passed");
