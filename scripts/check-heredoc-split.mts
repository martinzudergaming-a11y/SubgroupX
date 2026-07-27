import assert from "node:assert/strict";
import { splitHeredoc } from "../web/src/conversation/markdown/heredoc.ts";

const tests: { name: string; run: () => void }[] = [
  {
    name: "python heredoc → body is python",
    run: () => {
      const segs = splitHeredoc("python3 <<EOF\nprint(hi)\nEOF\necho done");
      assert.equal(segs[1]?.lang, "python");
    },
  },
  {
    name: "node with /usr/bin path → body is javascript",
    run: () => {
      const segs = splitHeredoc("/usr/bin/node <<JS\nconsole.log(1)\nJS");
      assert.equal(segs[1]?.lang, "javascript");
    },
  },
  {
    name: "cat heredoc → body is plaintext",
    run: () => {
      const segs = splitHeredoc("cat <<EOF\nhello\nEOF");
      assert.equal(segs[1]?.lang, "plaintext");
    },
  },
  {
    name: "no heredoc → single bash segment",
    run: () => {
      assert.deepEqual(splitHeredoc("echo hello"), [{ lang: "bash", code: "echo hello" }]);
    },
  },
  {
    name: "unterminated heredoc → single bash segment",
    run: () => {
      const cmd = "python3 <<EOF\nprint(1)";
      assert.deepEqual(splitHeredoc(cmd), [{ lang: "bash", code: cmd }]);
    },
  },
  {
    name: "<<- indented closer matches",
    run: () => {
      const segs = splitHeredoc("bash <<-EOF\necho hi\n\tEOF");
      assert.equal(segs.length, 3);
      assert.equal(segs[1]?.code, "echo hi");
    },
  },
  {
    name: "quoted delimiter → body is javascript",
    run: () => {
      const segs = splitHeredoc("node <<'EOF'\nconsole.log(x)\nEOF");
      assert.equal(segs[1]?.lang, "javascript");
    },
  },
  {
    name: "bash -lc 'node - <<\"NODE\"' wrapper → body is javascript (the reported case)",
    run: () => {
      const cmd = `bash -lc 'node - <<"NODE"\nconst x = 1;\nconsole.log(x);\nNODE\n'`;
      const segs = splitHeredoc(cmd);
      assert.equal(segs.length, 3, "should split into 3 segments");
      assert.equal(segs[1]?.lang, "javascript", "heredoc body must be javascript, not bash");
      assert.equal(segs[1]?.code, "const x = 1;\nconsole.log(x);");
    },
  },
  {
    name: "closing delimiter immediately followed by the wrapper quote (D') still terminates",
    run: () => {
      const cmd = `bash -lc 'python3 - <<PY\nprint(1)\nPY'`;
      const segs = splitHeredoc(cmd);
      assert.equal(segs.length, 3, "should split despite trailing quote on the closer line");
      assert.equal(segs[1]?.lang, "python");
      assert.equal(segs[1]?.code, "print(1)");
    },
  },
];

let failed = false;
for (const t of tests) {
  try {
    t.run();
    console.log(`✓ ${t.name}`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${t.name}`);
    console.error(e instanceof Error ? e.message : e);
  }
}
if (failed) {
  console.error("\nFAIL: splitHeredoc regression");
  process.exit(1);
}
console.log("\nOK: splitHeredoc segmentation");
