const AVATAR_TONES: ReadonlyArray<readonly [string, string]> = [
  ["#A8836B", "#8A6A54"],
  ["#7F9471", "#66795B"],
  ["#B08D57", "#94764A"],
  ["#7E8CA8", "#67748C"],
  ["#9C7B8F", "#816577"],
  ["#6F9A8D", "#5A8175"],
  ["#A87E7E", "#8C6666"],
  ["#8A8A6E", "#71715A"],
];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function Avatar({
  seed,
  size = 20,
  src,
  className = "",
}: {
  seed: string;
  size?: number;
  src?: string | null;
  className?: string;
}) {
  const s = (seed || "?").trim();
  const initial = (s[0] || "?").toUpperCase();
  const h = hash(s.toLowerCase());
  const [c1, c2] = AVATAR_TONES[h % AVATAR_TONES.length];
  const bg = `linear-gradient(135deg, ${c1}, ${c2})`;

  if (src) {
    return (
      <img
        src={src}
        alt={s}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={`rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      aria-label={s}
      title={s}
      style={{
        width: size,
        height: size,
        background: bg,
        fontSize: Math.round(size * 0.5),
        lineHeight: `${size}px`,
      }}
      className={`rounded-full flex items-center justify-center text-white font-semibold select-none shrink-0 ${className}`}
    >
      {initial}
    </div>
  );
}
