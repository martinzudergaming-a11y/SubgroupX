function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function shikiFallback(code: string): string {
  return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
}
