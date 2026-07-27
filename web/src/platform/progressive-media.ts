export interface ByteProgress {
  loaded: number;
  total: number | null;
}

export interface ProgressiveBlobResult {
  url: string;
  blob: Blob;
}

export async function fetchBlobWithProgress(
  url: string,
  opts: { signal?: AbortSignal; onProgress?: (progress: ByteProgress) => void } = {},
): Promise<ProgressiveBlobResult> {
  const res = await fetch(url, { signal: opts.signal, credentials: "include" });
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
  const lengthHeader = res.headers.get("content-length");
  const encoded = res.headers.get("content-encoding");
  const total = lengthHeader && !encoded ? Number.parseInt(lengthHeader, 10) || null : null;
  if (!res.body) {
    const blob = await res.blob();
    opts.onProgress?.({ loaded: blob.size, total: total ?? blob.size });
    return { url: URL.createObjectURL(blob), blob };
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  opts.onProgress?.({ loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    opts.onProgress?.({ loaded, total });
  }
  const blob = new Blob(chunks, { type: res.headers.get("content-type") ?? undefined });
  return { url: URL.createObjectURL(blob), blob };
}
