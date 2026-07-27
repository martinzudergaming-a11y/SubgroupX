export type PdfScaleMode = "fit-width" | "fit-page" | "fit-height";

export interface PdfLocation {
  page: number;
  namedDestination: string | null;
  zoom: number;
  scaleMode: PdfScaleMode;
}

export function pdfLocationFromFragment(
  fragment: string | undefined,
): PdfLocation {
  const params = new URLSearchParams(fragment ?? "");
  const rawPage = Number(params.get("page"));
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawZoom = Number(params.get("zoom"));
  const zoom =
    Number.isFinite(rawZoom) && rawZoom > 0
      ? Math.min(4, Math.max(0.25, rawZoom / 100))
      : 1;
  const view = params.get("view");
  const scaleMode: PdfScaleMode =
    view === "Fit" ? "fit-page" : view === "FitV" ? "fit-height" : "fit-width";
  return {
    page,
    namedDestination: params.get("nameddest"),
    zoom,
    scaleMode,
  };
}

export function pdfFitScale(input: {
  pageWidth: number;
  pageHeight: number;
  stageWidth: number;
  stageHeight: number;
  scaleMode: PdfScaleMode;
  horizontalPadding?: number;
  verticalPadding?: number;
}): number {
  const positive = (value: number, fallback = 1) =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  const pageWidth = positive(input.pageWidth);
  const pageHeight = positive(input.pageHeight);
  const availableWidth = Math.max(
    1,
    positive(input.stageWidth) - Math.max(0, input.horizontalPadding ?? 0),
  );
  const availableHeight = Math.max(
    1,
    positive(input.stageHeight) - Math.max(0, input.verticalPadding ?? 0),
  );
  const fitWidth = availableWidth / pageWidth;
  const fitHeight = availableHeight / pageHeight;
  return input.scaleMode === "fit-page"
    ? Math.min(fitWidth, fitHeight)
    : input.scaleMode === "fit-height"
      ? fitHeight
      : fitWidth;
}

export function clampPdfZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(4, Math.max(0.25, zoom)) : 1;
}

export function clampPdfDisplayScale(input: {
  pageWidth: number;
  pageHeight: number;
  requestedScale: number;
  maxPixels: number;
  maxDimension: number;
}): number {
  const positive = (value: number, fallback = 1) =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  const pageWidth = positive(input.pageWidth);
  const pageHeight = positive(input.pageHeight);
  const requestedScale = positive(input.requestedScale);
  const maxPixels = Math.max(1, positive(input.maxPixels));
  const maxDimension = Math.max(1, positive(input.maxDimension));
  const areaScale =
    Math.sqrt(maxPixels) / Math.sqrt(pageWidth) / Math.sqrt(pageHeight);
  return positive(
    Math.min(
      requestedScale,
      areaScale,
      maxDimension / pageWidth,
      maxDimension / pageHeight,
    ),
    Number.MIN_VALUE,
  );
}

export function pdfPinchWheelScaleFactor(input: {
  ctrlKey: boolean;
  ctrlKeyDown: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
}): number | null {
  const factor = Math.exp(-input.deltaY / 100);
  return input.ctrlKey &&
    !input.ctrlKeyDown &&
    input.deltaMode === 0 &&
    input.deltaX === 0 &&
    input.deltaZ === 0 &&
    Math.abs(factor - 1) < 0.05
    ? factor
    : null;
}

export function accumulatePdfZoomFactor(
  previousScale: number,
  factor: number,
  unusedFactor: number,
): {
  factor: number;
  unusedFactor: number;
} {
  if (
    !Number.isFinite(previousScale) ||
    previousScale <= 0 ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    factor === 1
  ) {
    return { factor: 1, unusedFactor: 1 };
  }
  let remainder =
    Number.isFinite(unusedFactor) && unusedFactor > 0 ? unusedFactor : 1;
  if ((remainder > 1 && factor < 1) || (remainder < 1 && factor > 1))
    remainder = 1;
  const representable =
    Math.floor(previousScale * factor * remainder * 100) /
    (100 * previousScale);
  if (!Number.isFinite(representable) || representable <= 0)
    return { factor: 1, unusedFactor: remainder * factor };
  return { factor: representable, unusedFactor: factor / representable };
}
