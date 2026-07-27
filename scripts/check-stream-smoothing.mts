import assert from "node:assert/strict";
import {
  normalizeMathDelimiters,
  protectGfmTableMath,
  protectLiteralDollars,
  scanStreamingMath,
  stabilizeStreamingMath,
  stripMathLabels,
} from "../web/src/conversation/markdown/streaming-math.ts";
import {
  nextStreamFollow,
  shouldAnimateStreamFollow,
  type StreamFollowState,
} from "../web/src/dashboard/session/reader/stream-follow-motion.ts";
import {
  MAX_STREAM_HEIGHT_COMPENSATION_PX,
  resolveStreamHeight,
  type StreamHeightState,
} from "../web/src/dashboard/session/reader/stream-height-stability.ts";
import {
  createStreamArrivalController,
  segmentStreamText,
} from "../web/src/conversation/markdown/stream-arrival-motion.ts";
import { latestThinkingPreview } from "../web/src/dashboard/session/timeline/timeline-format.ts";

let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

console.log("\n── new streamed lines rise without a scroll snap ──");

console.log("\n── source snapshots gain visual continuity without a second text clock ──");

check("CJK and Latin prose split at natural word boundaries", () => {
  const cjk = segmentStreamText("你好世界，新的一行").filter((part) => part.animate);
  const latin = segmentStreamText("Fast source chunks arrive").filter((part) => part.animate);
  assert.ok(cjk.length >= 3, "a no-whitespace CJK sentence must not become one giant animated span");
  assert.deepEqual(latin.map((part) => part.text), ["Fast", "source", "chunks", "arrive"]);
});

check("only newly appended prose retains arrival motion after the prior batch settles", () => {
  type Node = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
  let time = 0;
  const controller = createStreamArrivalController(() => time);
  const render = (text: string) => {
    const tree: Node = { type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value: text }] }] };
    controller.prepare(true, text);
    controller.rehypePlugin()(tree);
    return tree.children?.[0]?.children ?? [];
  };

  assert.ok(render("Hello 世界").some((node) => node.properties?.["data-stream-arrival"]));
  assert.ok(
    render("Hello 世界").some((node) => node.properties?.["data-stream-arrival"]),
    "a StrictMode re-evaluation of the same snapshot must not consume its first paint",
  );
  time = 250;
  const next = render("Hello 世界 新内容");
  const arrived = next.filter((node) => node.properties?.["data-stream-arrival"]);
  const settled = next.filter((node) => node.properties?.["data-stream-word"] && !node.properties?.["data-stream-arrival"]);
  assert.deepEqual(arrived.map((node) => node.children?.[0]?.value), ["新", "内容"]);
  assert.ok(settled.length >= 2, "previous words keep stable, non-animated span identities");
});

check("tables and rich renderers never acquire per-word animation nodes", () => {
  type Node = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
  const tree: Node = {
    type: "root",
    children: [{ type: "element", tagName: "table", children: [{ type: "element", tagName: "td", children: [{ type: "text", value: "Large table cell" }] }] }],
  };
  const controller = createStreamArrivalController(() => 0);
  controller.prepare(true, "table");
  controller.rehypePlugin()(tree);
  const serialized = JSON.stringify(tree);
  assert.doesNotMatch(serialized, /data-stream-(?:word|arrival)/);
});

check("a one-line growth follows a critically damped monotonic path", () => {
  let state: StreamFollowState = { position: 0, velocity: 0 };
  const samples: number[] = [];
  for (let frame = 0; frame < 24; frame++) {
    state = nextStreamFollow(state, 24, 16);
    samples.push(state.position);
  }
  assert.ok(samples[0] > 0 && samples[0] < 24, "the first frame moves but never snaps");
  assert.ok(samples.every((value, index) => index === 0 || value >= samples[index - 1]), "motion stays monotonic");
  assert.ok(samples.at(-1)! > 23.9, "the spring settles at the new bottom");
});

check("a later line retargets from current motion without overshoot", () => {
  let state: StreamFollowState = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 3; frame++) state = nextStreamFollow(state, 24, 16);
  const before = state.position;
  state = nextStreamFollow(state, 48, 16);
  assert.ok(state.position > before && state.position < 48);
  assert.ok(shouldAnimateStreamFollow(24, true, false));
  assert.ok(!shouldAnimateStreamFollow(120, true, false), "large structural growth stays instant");
  assert.ok(!shouldAnimateStreamFollow(24, false, false), "history and non-stream changes stay instant");
  assert.ok(!shouldAnimateStreamFollow(24, true, true), "reduced motion stays instant");
});

console.log("\n── provider reasoning previews stay semantic and cheap ──");

check("free-form provider prose never enters the animated heading ticker", () => {
  const prefix = "I checked the transport and found one stable boundary. ";
  assert.deepEqual(latestThinkingPreview(prefix + "Now I am reading a long unfinished explanation", true), {
    mode: "prose",
    text: "I checked the transport and found one stable boundary.",
  });
  assert.deepEqual(latestThinkingPreview(prefix + "Now I am reading a much longer unfinished explanation that keeps growing", true), {
    mode: "prose",
    text: "I checked the transport and found one stable boundary.",
  });
});

check("provider headings animate only after a semantic boundary", () => {
  assert.equal(latestThinkingPreview("## Inspecting the transport", true)?.mode, "prose");
  assert.deepEqual(latestThinkingPreview("## Inspecting the transport\nReading prose", true), {
    mode: "heading",
    text: "Inspecting the transport",
  });
  const bodyA = latestThinkingPreview("**Planning**\nFirst cumulative body snapshot", true);
  const bodyB = latestThinkingPreview("**Planning**\nFirst cumulative body snapshot keeps growing", true);
  assert.deepEqual(bodyA, { mode: "heading", text: "Planning" });
  assert.deepEqual(bodyB, bodyA, "body tokens must not retarget the heading motion");
});

check("reasoning preview work stays bounded to the newest tail", () => {
  const hiddenPrefix = `**Old phase**\n${"discarded ".repeat(700)}`;
  const preview = latestThinkingPreview(`${hiddenPrefix}\nThe newest bounded sentence is ready.`, true);
  assert.deepEqual(preview, { mode: "prose", text: "The newest bounded sentence is ready." });
});

console.log("\n── small live height regressions never reverse the bottom edge ──");

check("a transient shrink becomes spacer and later growth consumes it", () => {
  let state: StreamHeightState = { floor: null };
  let next = resolveStreamHeight(state, 100, true);
  state = next.state;
  assert.equal(next.spacer, 0);

  next = resolveStreamHeight(state, 84, true);
  state = next.state;
  assert.equal(next.spacer, 16);
  assert.equal(84 + next.spacer, 100);

  next = resolveStreamHeight(state, 95, true);
  state = next.state;
  assert.equal(next.spacer, 5);
  assert.equal(95 + next.spacer, 100);

  next = resolveStreamHeight(state, 104, true);
  assert.equal(next.spacer, 0);
  assert.equal(next.state.floor, 104);
});

check("the settled tail stays after stream end and disappears into later content", () => {
  let state: StreamHeightState = { floor: 100 };
  let next = resolveStreamHeight(state, 92, false);
  assert.equal(next.spacer, 8, "ending the stream must not immediately recreate the shrink");
  state = next.state;
  next = resolveStreamHeight(state, 108, false);
  assert.equal(next.spacer, 0);
  assert.equal(next.state.floor, null);
});

check("large structural shrink is bounded rather than hidden", () => {
  const next = resolveStreamHeight({ floor: 500 }, 100, true);
  assert.equal(next.spacer, MAX_STREAM_HEIGHT_COMPENSATION_PX);
  assert.equal(next.state.floor, 100 + MAX_STREAM_HEIGHT_COMPENSATION_PX);
});

console.log("\n── math commits only at complete syntax boundaries ──");

check("an unfinished display formula is replaced by one stable placeholder", () => {
  const source = "Before\n\n$$\n\\frac{a}{b";
  const first = stabilizeStreamingMath(source, source.indexOf("$$") + 1, true);
  const last = stabilizeStreamingMath(source, source.length, true);
  assert.deepEqual(first, { source: "Before\n\n", pendingMath: "display" });
  assert.deepEqual(last, first, "the placeholder source must not change for each TeX character");
});

check("a complete formula commits atomically only after its closing delimiter", () => {
  const source = "Before \\(x + y\\) after";
  const close = source.indexOf("\\)");
  const pending = stabilizeStreamingMath(source, close + 1, true);
  assert.deepEqual(pending, { source: "Before ", pendingMath: "inline" });
  const complete = stabilizeStreamingMath(source, close + 2, true);
  assert.equal(complete.source, source.slice(0, close + 2));
  assert.equal(complete.pendingMath, null);
});

check("line-leading same-line double dollars reserve and normalize as display math", () => {
  const source = "Before\n\n$$\\int_0^1 x^2\\,dx$$\n\nAfter";
  const openPrefix = source.slice(0, source.indexOf("$$") + 8);
  assert.equal(scanStreamingMath(openPrefix).at(-1)?.kind, "display");
  assert.deepEqual(stabilizeStreamingMath(openPrefix, openPrefix.length, true), {
    source: "Before\n\n",
    pendingMath: "display",
  });
  assert.match(normalizeMathDelimiters(source), /\$\$\n\\int_0\^1 x\^2\\,dx\n\$\$/);
});

check("common bare display environments stay atomic and become KaTeX-supported blocks", () => {
  const partial = "Reasoning\n\n\\begin{align}\na&=b";
  assert.deepEqual(stabilizeStreamingMath(partial, partial.length, true), {
    source: "Reasoning\n\n",
    pendingMath: "display",
  });
  const complete = `${partial}\\\\\nc&=d\n\\end{align}`;
  const normalized = normalizeMathDelimiters(complete);
  assert.match(normalized, /\$\$\n\\begin\{aligned\}a&=b\\\\\nc&=d\\end\{aligned\}\n\$\$/);
  assert.doesNotMatch(normalized, /\\begin\{align\}/);

  const opener = "\\begin{equation}";
  for (let length = "\\begin".length; length < opener.length; length++) {
    const source = `Before\n\n${opener.slice(0, length)}`;
    assert.deepEqual(stabilizeStreamingMath(source, source.length, true), {
      source: "Before\n\n",
      pendingMath: "display",
    });
  }

  for (const environment of ["pmatrix", "bmatrix*", "aligned", "split", "dcases", "smallmatrix"]) {
    const argument = environment.endsWith("matrix*") ? "[r]" : "";
    const source = `\\begin{${environment}}${argument}a&b\\\\c&d\\end{${environment}}`;
    assert.equal(scanStreamingMath(source)[0]?.kind, "display", `${environment} must reserve display geometry`);
    assert.match(normalizeMathDelimiters(source), /^\n\$\$\n[\s\S]+\n\$\$\n$/);
  }
});

check("an incomplete single-dollar formula cannot leak TeX or table pipes", () => {
  const frac = "Loss: $\\frac{1}{n}\\sum";
  assert.deepEqual(stabilizeStreamingMath(frac, frac.length, true), {
    source: "Loss: ", pendingMath: "inline",
  });
  const tableCell = "Huber | $|r| \\le \\delta";
  assert.deepEqual(stabilizeStreamingMath(tableCell, tableCell.length, true), {
    source: "Huber | ", pendingMath: "inline",
  });
});

check("complete math bars cannot become GFM table separators", () => {
  const source = "| Huber | $|r| \\le \\delta$ | Regression |";
  const protectedSource = protectGfmTableMath(source);
  assert.equal((protectedSource.match(/\|/g) ?? []).length, 4, "only real cell separators remain");
  assert.doesNotMatch(protectedSource, /\$\|r\|/);
});

check("currency and code remain ordinary streamed text", () => {
  for (const source of ["The price is $50 today", "Ticker $USD today"]) {
    assert.deepEqual(stabilizeStreamingMath(source, source.length, true), { source, pendingMath: null });
  }
  const inline = "Use `$$not math` now";
  assert.equal(stabilizeStreamingMath(inline, inline.length, true).pendingMath, null);
  const fenced = "```sh\necho '$$not math'\n```";
  assert.equal(stabilizeStreamingMath(fenced, fenced.length, true).pendingMath, null);
  const currencies = "Costs: $50, $USD, $20 and $30; math stays $x$ and $E=mc^2$.";
  assert.deepEqual(scanStreamingMath(currencies).map(({ start, end }) => currencies.slice(start, end ?? undefined)), [
    "$x$",
    "$E=mc^2$",
  ]);
  const protectedCurrencies = protectLiteralDollars(currencies);
  assert.doesNotMatch(protectedCurrencies, /\$50|\$USD|\$20|\$30/);
  assert.match(protectedCurrencies, /\$x\$/);
  assert.match(protectedCurrencies, /\$E=mc\^2\$/);
  assert.equal(protectLiteralDollars("Code: ``$not_math$`` and `price $50`."), "Code: ``$not_math$`` and `price $50`.");
});

check("malformed final math is released as source after the live stream ends", () => {
  for (const source of ["Result: \\[x +", "Result: $x_i +"]) {
    assert.ok(stabilizeStreamingMath(source, source.length, true).pendingMath);
    assert.deepEqual(stabilizeStreamingMath(source, source.length, false), { source, pendingMath: null });
  }
});

check("a mixed display closer ends the current formula instead of swallowing the next section", () => {
  const source = "\\[\nV = x\n$$\n\n## Hilbert\n\n\\[\nH = \\frac{1}{2}\n\\]";
  const spans = scanStreamingMath(source).filter((span) => span.kind === "display");
  assert.equal(spans.length, 2);
  assert.equal(source.slice(spans[0].start, spans[0].end ?? undefined), "\\[\nV = x\n$$");
  const normalized = normalizeMathDelimiters(source);
  assert.equal((normalized.match(/\$\$/g) ?? []).length, 4);
  assert.match(normalized, /\$\$\s*## Hilbert\s*\$\$/);
  assert.doesNotMatch(normalized, /\\\[|\\\]/);
});

check("normalization does not cross a second opener or rewrite matrix spacing and code", () => {
  const malformed = "\\[\nfirst\n\n## Next\n\\[\nsecond\n\\]";
  const normalizedMalformed = normalizeMathDelimiters(malformed);
  assert.ok(normalizedMalformed.startsWith("\\[\nfirst"));
  assert.equal((normalizedMalformed.match(/\$\$/g) ?? []).length, 2);
  const scannedMalformed = scanStreamingMath(malformed);
  assert.equal(scannedMalformed.length, 1);
  assert.equal(scannedMalformed[0]?.start, malformed.lastIndexOf("\\["));

  const matrix = "\\[\n\\begin{matrix}a \\\\[4pt] b\\end{matrix}\n\\]";
  assert.ok(normalizeMathDelimiters(matrix).includes("\\\\[4pt]"));
  const code = "Use ``\\[not math\\]`` and:\n~~~~txt\n\\begin{align}\na&=b\n\\end{align}\n~~~~";
  assert.equal(normalizeMathDelimiters(code), code);
});

check("currency pairs never scan as math (Pandoc closing-digit rule)", () => {
  assert.equal(scanStreamingMath("打折后$100,原价$200,很划算").length, 0);
  assert.equal(scanStreamingMath("It costs $5-$10 total").length, 0);
  const real = scanStreamingMath("the bound is $2^{10}$ here");
  assert.equal(real.length, 1);
  assert.equal(real[0].kind, "inline");
});

check("\\label is stripped from a math body, prose and braces untouched", () => {
  assert.equal(stripMathLabels("E = mc^2 \\label{eq:emc}"), "E = mc^2 ");
  assert.equal(stripMathLabels("a \\label{x} + b \\label{y}"), "a  + b ");
  assert.equal(stripMathLabels("\\mathbb{R}^n"), "\\mathbb{R}^n");
  assert.equal(stripMathLabels("plain text"), "plain text");
});

if (failed > 0) {
  console.error(`\n${failed} streamed-content check(s) FAILED`);
  process.exit(1);
}
console.log("\nOK: all streamed-content checks passed");
