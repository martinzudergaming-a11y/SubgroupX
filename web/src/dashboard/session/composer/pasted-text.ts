export const LONG_PASTE_MIN_BYTES = 2 * 1024;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function hasUtf8BytesAtLeast(text: string, minimum: number): boolean {
  return text.length >= minimum || utf8ByteLength(text) >= minimum;
}

export function shouldPromotePastedText(text: string): boolean {
  return hasUtf8BytesAtLeast(text, LONG_PASTE_MIN_BYTES) && /\S/u.test(text);
}

export function pastedTextFilename(seed: string): string {
  const suffix = seed.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "draft";
  return `pasted-text-${suffix}.txt`;
}
