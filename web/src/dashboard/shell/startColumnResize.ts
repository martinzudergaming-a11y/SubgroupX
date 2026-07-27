export function startColumnResize(
  e: React.MouseEvent,
  opts: { startWidth: number; min: number; max: number; sign: 1 | -1; onWidth: (w: number) => void },
) {
  e.preventDefault();
  const startX = e.clientX;
  const { startWidth, min, max, sign, onWidth } = opts;
  const onMouseMove = (moveEvent: MouseEvent) => {
    onWidth(Math.max(min, Math.min(max, startWidth + sign * (moveEvent.clientX - startX))));
  };
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}
