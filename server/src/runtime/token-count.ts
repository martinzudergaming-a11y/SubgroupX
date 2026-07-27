let encodeFn: ((text: string) => number[]) | null = null;
let loading: Promise<void> | null = null;
const LARGE_TEXT_CODE_UNITS = 8_192;
const TOKENIZER_CHUNK_CODE_UNITS = 2_048;

function countEncodedBounded(encode: (text: string) => number[], text: string): number {
  if (text.length <= LARGE_TEXT_CODE_UNITS) return encode(text).length;
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + TOKENIZER_CHUNK_CODE_UNITS);
    if (end < text.length) {
      const prior = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (prior >= 0xD800 && prior <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
    }
    count += encode(text.slice(start, end)).length;
    start = end;
  }
  return count;
}

function loadTokenizer(): Promise<void> {
  if (encodeFn) return Promise.resolve();
  if (loading) return loading;
  loading = import("gpt-tokenizer/encoding/o200k_base")
    .then((m) => {
      encodeFn = m.encode;
    })
    .catch(() => {
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function warmupTokenizer(): void {
  void loadTokenizer();
}

export async function prepareTokenizer(): Promise<boolean> {
  await loadTokenizer();
  return encodeFn !== null;
}

export function tokenizerReady(): boolean {
  return encodeFn !== null;
}

export function countText(text: string): number {
  if (encodeFn) {
    try {
      return countEncodedBounded(encodeFn, text);
    } catch {
      return Buffer.byteLength(text, "utf8");
    }
  } else {
    warmupTokenizer();
  }
  return Math.ceil(text.length / 3.4);
}

export async function countTextHard(text: string): Promise<number> {
  try {
    await loadTokenizer();
    const encode = encodeFn;
    if (!encode) throw new Error("o200k tokenizer is unavailable");
    return countEncodedBounded(encode, text);
  } catch {
    return Buffer.byteLength(text, "utf8");
  }
}

export async function countTextExact(text: string): Promise<number> {
  await loadTokenizer();
  const encode = encodeFn;
  if (!encode) throw new Error("o200k tokenizer is unavailable");
  return encode(text).length;
}

const IMAGE_BLOCK_TOKENS = 1_000;
const MESSAGE_OVERHEAD_TOKENS = 5;

export function countMessage(msg: unknown): number {
  const m = msg as {
    content?: unknown;
    thinking?: string;
    toolCalls?: unknown;
  };
  let n = MESSAGE_OVERHEAD_TOKENS;
  const content = m.content;
  if (typeof content === "string") {
    n += countText(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string; data?: unknown };
      if (b.type?.includes("image") ?? false) n += IMAGE_BLOCK_TOKENS;
      else if (typeof b.text === "string") n += countText(b.text);
      else n += countJson(block);
    }
  } else if (content != null) {
    n += countJson(content);
  }
  if (typeof m.thinking === "string") n += countText(m.thinking);
  if (m.toolCalls != null) n += countJson(m.toolCalls);
  return n;
}

export async function countMessageHard(msg: unknown): Promise<number> {
  const m = msg as {
    content?: unknown;
    thinking?: string;
    toolCalls?: unknown;
  };
  let n = MESSAGE_OVERHEAD_TOKENS;
  const content = m.content;
  if (typeof content === "string") {
    n += await countTextHard(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string; data?: unknown };
      if (b.type?.includes("image") ?? false) n += IMAGE_BLOCK_TOKENS;
      else if (typeof b.text === "string") n += await countTextHard(b.text);
      else n += await countJsonHard(block);
    }
  } else if (content != null) {
    n += await countJsonHard(content);
  }
  if (typeof m.thinking === "string") n += await countTextHard(m.thinking);
  if (m.toolCalls != null) n += await countJsonHard(m.toolCalls);
  return n;
}

async function countJsonHard(value: unknown): Promise<number> {
  try {
    return await countTextHard(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function countJson(value: unknown): number {
  try {
    return countText(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}
