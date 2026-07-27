export const FILE_CONTENT_CACHE_MAX_ENTRIES = 8;
export const FILE_CONTENT_CACHE_MAX_CHARS = 4 * 1024 * 1024;

export class FileContentCache {
  private entries = new Map<string, string>();
  private charCount = 0;

  has(path: string): boolean {
    return this.entries.has(path);
  }

  read(path: string): string | null {
    const content = this.entries.get(path);
    if (content === undefined) return null;
    this.entries.delete(path);
    this.entries.set(path, content);
    return content;
  }

  write(path: string, content: string): void {
    this.delete(path);
    if (content.length > FILE_CONTENT_CACHE_MAX_CHARS) {
      this.clear();
      this.entries.set(path, content);
      this.charCount = content.length;
      return;
    }
    this.entries.set(path, content);
    this.charCount += content.length;
    this.trim();
  }

  delete(path: string): void {
    const content = this.entries.get(path);
    if (content === undefined) return;
    this.charCount -= content.length;
    this.entries.delete(path);
  }

  clear(): void {
    this.entries.clear();
    this.charCount = 0;
  }

  snapshot(): Map<string, string> {
    return new Map(this.entries);
  }

  stats(): { entries: number; chars: number; paths: string[] } {
    return { entries: this.entries.size, chars: this.charCount, paths: [...this.entries.keys()] };
  }

  private trim(): void {
    while (this.entries.size > FILE_CONTENT_CACHE_MAX_ENTRIES || this.charCount > FILE_CONTENT_CACHE_MAX_CHARS) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.delete(oldest);
    }
  }
}
