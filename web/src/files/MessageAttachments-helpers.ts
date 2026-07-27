const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export interface ParsedAttachment {
  path: string;
  name: string;
  isImage: boolean;
}
export interface ParsedMessage {
  cleanText: string;
  files: ParsedAttachment[];
}

export function parseMessageAttachments(text: string): ParsedMessage {
  const noteRe =
    /\n*\[Attached \d+ file\(s\) in \.\/uploads\/: ([^\]]+)\](?:\n*Use read_image to view the image\(s\):[^\n]*)?(?:\n*Use read_file to read the pasted text before responding:[^\n]*)?\s*$/i;
  const m = text.match(noteRe);
  if (!m) return { cleanText: text, files: [] };
  const files: ParsedAttachment[] = m[1].split(",").flatMap((s) => {
    const path = s.trim();
    if (!path) return [];
    const name = path.split("/").pop() || path;
    return [{ path, name, isImage: IMAGE_RE.test(name) }];
  });
  const cleanText = text.replace(noteRe, "").trim();
  return { cleanText, files };
}
