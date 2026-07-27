import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  TouchManager,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PRODUCT_NAME } from "../platform/brand";
import { useT } from "../i18n";
import {
  accumulatePdfZoomFactor,
  clampPdfDisplayScale,
  clampPdfZoom,
  pdfFitScale,
  pdfLocationFromFragment,
  pdfPinchWheelScaleFactor,
  type PdfScaleMode,
} from "./pdf-preview-model";
import "./pdf-preview.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const RANGE_CHUNK_BYTES = 256 * 1024;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_CANVAS_DIMENSION = 16_384;
const PDF_ASSET_ROOT = "/pdfjs-assets";
const PDF_PAGE_HORIZONTAL_GUTTER = 40;
const PDF_PAGE_VERTICAL_GUTTER = 32;
const PDF_GESTURE_ZOOM_SETTLE_MS = 250;
const PDF_IMMEDIATE_REDRAW_DELAY = 0;
const PDF_VIEWER_MIN_SCALE = 0.1;
const RESIZE_SETTLE_MS = 120;

type ViewerRenderSource = {
  id: number;
  div: HTMLDivElement;
  canvas?: HTMLCanvasElement | null;
};

type ViewerPage = ViewerRenderSource & {
  width: number;
  height: number;
  scale: number;
};

type PendingView = {
  page: number;
  zoom: number;
  scaleMode: PdfScaleMode;
};

type TouchManagerConstructor = new (options: {
  container: HTMLElement;
  isPinchingDisabled?: () => boolean;
  isPinchingStopped?: () => boolean;
  onPinching?: (
    origin: number[],
    previousDistance: number,
    distance: number,
  ) => void;
  onPinchEnd?: () => void;
  signal: AbortSignal;
}) => { destroy(): void };

class PdfRangeResponseError extends Error {
  constructor(readonly status: number) {
    super(`pdf range response ${status}`);
    this.name = "PdfRangeResponseError";
  }
}

type PdfProtocolErrorCode = "content-range" | "short-range" | "canvas";
class PdfProtocolError extends Error {
  constructor(readonly code: PdfProtocolErrorCode) {
    super(`pdf protocol error: ${code}`);
    this.name = "PdfProtocolError";
  }
}

class HttpPdfRangeTransport extends PDFDataRangeTransport {
  private readonly controllers = new Set<AbortController>();
  private loaded = 0;
  private stopped = false;
  private failed = false;

  constructor(
    length: number,
    private readonly url: string,
    private readonly onProgress: (loaded: number) => void,
    private readonly onFatal: (error: Error) => void,
  ) {
    super(length, null, true);
  }

  requestDataRange(begin: number, end: number): void {
    if (this.stopped || end <= begin) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    void fetch(this.url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status !== 206)
          throw new PdfRangeResponseError(response.status);
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") ?? "",
        );
        if (
          !match ||
          Number(match[1]) !== begin ||
          Number(match[2]) + 1 !== end ||
          Number(match[3]) !== this.length
        ) {
          throw new PdfProtocolError("content-range");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== end - begin)
          throw new PdfProtocolError("short-range");
        if (this.stopped) return;
        this.loaded = Math.min(this.length, this.loaded + bytes.byteLength);
        this.onProgress(this.loaded);
        this.onDataRange(begin, bytes);
      })
      .catch((reason: unknown) => {
        if (this.stopped || controller.signal.aborted) return;
        this.fail(reason instanceof Error ? reason : new Error(String(reason)));
      })
      .finally(() => {
        this.controllers.delete(controller);
      });
  }

  abort(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.abort();
    this.onFatal(error);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clearViewerDocument(viewer: PDFViewer): void {
  (viewer.setDocument as (document: PDFDocumentProxy | null) => void)(null);
}

function viewerFitGeometry(
  viewer: PDFViewer,
  scaleMode: PdfScaleMode,
  pageNumber = viewer.currentPageNumber,
): { fitScale: number; pageWidth: number; pageHeight: number } | null {
  const page = viewer.getPageView(Math.max(0, pageNumber - 1)) as
    ViewerPage | undefined;
  if (
    !page ||
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    !Number.isFinite(page.scale) ||
    page.scale <= 0
  ) {
    return null;
  }
  const pageWidth = page.width / page.scale;
  const pageHeight = page.height / page.scale;
  return {
    pageWidth,
    pageHeight,
    fitScale: pdfFitScale({
      pageWidth,
      pageHeight,
      stageWidth: viewer.container.clientWidth,
      stageHeight: viewer.container.clientHeight,
      scaleMode,
      horizontalPadding: PDF_PAGE_HORIZONTAL_GUTTER,
      verticalPadding: PDF_PAGE_VERTICAL_GUTTER,
    }),
  };
}

function applyViewerZoom(
  viewer: PDFViewer,
  scaleMode: PdfScaleMode,
  zoom: number,
  drawingDelay: number,
  origin?: number[],
  fitPageNumber?: number,
): boolean {
  const geometry = viewerFitGeometry(viewer, scaleMode, fitPageNumber);
  const currentScale = viewer.currentScale;
  if (!geometry || !Number.isFinite(currentScale) || currentScale <= 0)
    return true;
  const boundedScale = clampPdfDisplayScale({
    pageWidth: geometry.pageWidth,
    pageHeight: geometry.pageHeight,
    requestedScale: geometry.fitScale * clampPdfZoom(zoom),
    maxPixels: MAX_CANVAS_PIXELS,
    maxDimension: MAX_CANVAS_DIMENSION,
  });
  if (boundedScale < PDF_VIEWER_MIN_SCALE) return false;
  const targetScale = Math.floor(boundedScale * 100) / 100;
  const hasCommittedScale = viewer.currentScaleValue !== null;
  if (hasCommittedScale && Math.abs(targetScale - currentScale) < 0.005)
    return true;
  if (!hasCommittedScale) {
    viewer.currentScale = targetScale;
    return true;
  }
  viewer.updateScale({
    scaleFactor: targetScale / currentScale,
    drawingDelay,
    origin,
  });
  return true;
}

const toolbarButton =
  "flex size-7 shrink-0 items-center justify-center rounded-md transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.97] hover:bg-[#EAEAE5] disabled:opacity-35 disabled:active:scale-100 motion-reduce:transition-none dark:hover:bg-[#2B2B2B]";

export function PdfPreview({
  url,
  path,
  size,
  version,
  fragment,
  locationNonce,
  integratedToolbar = false,
  onRetry,
  onSourceInvalid,
  onSourceReady,
  onOpenFullViewer,
}: {
  url: string;
  path: string;
  size: number;
  version: string;
  fragment?: string;
  locationNonce?: number;
  integratedToolbar?: boolean;
  onRetry: () => void;
  onSourceInvalid: () => boolean;
  onSourceReady: () => void;
  onOpenFullViewer: (page?: number) => void;
}) {
  const t = useT();
  const previewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pagesEpoch, setPagesEpoch] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scaleMode, setScaleMode] = useState<PdfScaleMode>("fit-width");
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [phase, setPhase] = useState<
    "loading" | "rendering" | "ready" | "error"
  >("loading");
  const [error, setError] = useState("");

  const pageNumberRef = useRef(pageNumber);
  const zoomRef = useRef(zoom);
  const scaleModeRef = useRef(scaleMode);
  const pathRef = useRef(path);
  const translateRef = useRef(t);
  const sourceInvalidRef = useRef(onSourceInvalid);
  const sourceReadyRef = useRef(onSourceReady);
  const loadedIdentityRef = useRef<string | null>(null);
  const preserveLocationRef = useRef(false);
  const preserveLocationKeyRef = useRef("");
  const appliedLocationKeyRef = useRef("");
  const pendingViewRef = useRef<PendingView>({
    page: 1,
    zoom: 1,
    scaleMode: "fit-width",
  });
  const pendingNamedDestinationRef = useRef(false);
  const pendingLocationKeyRef = useRef("");
  const pagesDocumentRef = useRef<PDFDocumentProxy | null>(null);

  pageNumberRef.current = pageNumber;
  zoomRef.current = zoom;
  scaleModeRef.current = scaleMode;
  pathRef.current = path;
  translateRef.current = t;
  sourceInvalidRef.current = onSourceInvalid;
  sourceReadyRef.current = onSourceReady;

  const documentIdentity = JSON.stringify([path, size, version]);
  const locationKey = JSON.stringify([fragment ?? "", locationNonce ?? 0]);
  const currentLocationKeyRef = useRef(locationKey);
  currentLocationKeyRef.current = locationKey;

  const describePdfError = (reason: unknown): string => {
    if (reason instanceof PdfRangeResponseError) {
      return reason.status === 412
        ? t("pdf.errorChanged")
        : t("pdf.errorRange", { status: reason.status });
    }
    if (reason instanceof PdfProtocolError) {
      if (reason.code === "content-range") return t("pdf.errorContentRange");
      return t(
        reason.code === "short-range"
          ? "pdf.errorShortRange"
          : "pdf.errorCanvas",
      );
    }
    if ((reason as { name?: string } | null)?.name === "PasswordException")
      return t("pdf.passwordRequired");
    return reason instanceof Error ? reason.message : String(reason);
  };

  useEffect(() => {
    const stage = stageRef.current;
    const preview = previewRef.current;
    if (!stage || !preview) return;
    const lifecycle = new AbortController();
    const host = document.createElement("div");
    host.className = "pdfViewer oiia-pdf-pages";
    host.dataset.testid = "pdf-pages";
    stage.append(host);

    const eventBus = new EventBus();
    let viewer: PDFViewer;
    try {
      viewer = new PDFViewer({
        container: stage,
        viewer: host,
        eventBus,
        textLayerMode: 0,
        annotationMode: AnnotationMode.DISABLE,
        removePageBorders: false,
        maxCanvasPixels: MAX_CANVAS_PIXELS,
        maxCanvasDim: MAX_CANVAS_DIMENSION,
        capCanvasAreaFactor: 200,
        enableDetailCanvas: true,
        enableOptimizedPartialRendering: false,
        enableSelectionRendering: false,
        imagesRightClickMinSize: -1,
        supportsPinchToZoom: true,
        enableAutoLinking: false,
        minDurationToUpdateCanvas: 0,
        abortSignal: lifecycle.signal,
      } as ConstructorParameters<typeof PDFViewer>[0]);
    } catch (reason) {
      host.remove();
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("error");
      return;
    }
    viewerRef.current = viewer;

    const installPageSemantics = (page: ViewerRenderSource): void => {
      page.div.dataset.testid = "pdf-page";
      const canvas = page.canvas;
      if (!canvas) return;
      canvas.dataset.testid = "pdf-canvas";
      canvas.dataset.ready = "true";
      canvas.dataset.pageNumber = String(page.id);
      canvas.setAttribute("role", "img");
      canvas.setAttribute(
        "aria-label",
        translateRef.current("pdf.canvasLabel", {
          page: page.id,
          path: pathRef.current,
        }),
      );
    };

    const failCanvasBudget = () => {
      pagesDocumentRef.current = null;
      setError(translateRef.current("pdf.errorCanvas"));
      setPhase("error");
      queueMicrotask(() => {
        if (viewer.pdfDocument) clearViewerDocument(viewer);
      });
    };

    const onPagesInit = () => {
      const document = viewer.pdfDocument;
      if (!document) return;
      pagesDocumentRef.current = document;
      const pending = pendingViewRef.current;
      const nextPage = Math.min(
        viewer.pagesCount || 1,
        Math.max(1, pending.page),
      );
      pageNumberRef.current = nextPage;
      zoomRef.current = pending.zoom;
      scaleModeRef.current = pending.scaleMode;
      setPageNumber(nextPage);
      setPageDraft(String(nextPage));
      setPageCount(viewer.pagesCount);
      setZoom(pending.zoom);
      setScaleMode(pending.scaleMode);
      for (let index = 0; index < viewer.pagesCount; index++) {
        const page = viewer.getPageView(index) as ViewerPage | undefined;
        if (page) page.div.dataset.testid = "pdf-page";
      }
      if (
        !applyViewerZoom(
          viewer,
          pending.scaleMode,
          pending.zoom,
          -1,
          undefined,
          nextPage,
        )
      ) {
        failCanvasBudget();
        return;
      }
      viewer.currentPageNumber = nextPage;
      if (!pendingNamedDestinationRef.current) {
        preserveLocationRef.current = false;
        appliedLocationKeyRef.current = pendingLocationKeyRef.current;
      }
      setPagesEpoch((epoch) => epoch + 1);
    };
    const onPageChanging = (event: { pageNumber: number }) => {
      pageNumberRef.current = event.pageNumber;
      setPageNumber(event.pageNumber);
      setPageDraft(String(event.pageNumber));
    };
    const onPageRender = (event: { source?: ViewerRenderSource }) => {
      const source = event.source;
      if (!source) return;
      source.div.dataset.rendering = "true";
    };
    const onPageRendered = (event: {
      source?: ViewerRenderSource;
      cssTransform?: boolean;
      isDetailView?: boolean;
      error?: unknown;
    }) => {
      if (event.source?.div) delete event.source.div.dataset.rendering;
      if (event.error && event.isDetailView) {
        return;
      }
      if (event.error) {
        setError(
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
        );
        setPhase("error");
        return;
      }
      if (event.source && !event.isDetailView)
        installPageSemantics(event.source);
      if (!event.cssTransform && !event.isDetailView) setPhase("ready");
    };
    eventBus.on("pagesinit", onPagesInit);
    eventBus.on("pagechanging", onPageChanging);
    eventBus.on("pagerender", onPageRender);
    eventBus.on("pagerendered", onPageRendered);

    const localOrigin = (clientX: number, clientY: number): number[] => {
      const rect = stage.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return [stage.clientWidth / 2, stage.clientHeight / 2];
      }
      return [clientX - rect.left, clientY - rect.top];
    };
    const applyGestureFactor = (
      factor: number,
      origin: number[],
      kind: "wheel" | "touch",
    ) => {
      const unusedRef =
        kind === "wheel" ? wheelUnusedFactorRef : touchUnusedFactorRef;
      const accumulated = accumulatePdfZoomFactor(
        viewer.currentScale,
        factor,
        unusedRef.current,
      );
      unusedRef.current = accumulated.unusedFactor;
      if (accumulated.factor === 1) return;
      const nextZoom = clampPdfZoom(zoomRef.current * accumulated.factor);
      if (Math.abs(nextZoom - zoomRef.current) < 0.0001) {
        unusedRef.current = 1;
        return;
      }
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      applyViewerZoom(
        viewer,
        scaleModeRef.current,
        nextZoom,
        PDF_GESTURE_ZOOM_SETTLE_MS,
        origin,
      );
    };

    let ctrlKeyDown = false;
    const wheelUnusedFactorRef = { current: 1 };
    const touchUnusedFactorRef = { current: 1 };
    let webkitGestureActive = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Control") ctrlKeyDown = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") ctrlKeyDown = false;
    };
    const onBlur = () => {
      ctrlKeyDown = false;
      webkitGestureActive = false;
      wheelUnusedFactorRef.current = 1;
      touchUnusedFactorRef.current = 1;
    };
    window.addEventListener("keydown", onKeyDown, { signal: lifecycle.signal });
    window.addEventListener("keyup", onKeyUp, { signal: lifecycle.signal });
    window.addEventListener("blur", onBlur, { signal: lifecycle.signal });
    preview.addEventListener(
      "wheel",
      (event) => {
        const pinchFactor = pdfPinchWheelScaleFactor({
          ctrlKey: event.ctrlKey,
          ctrlKeyDown,
          deltaMode: event.deltaMode,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
        });
        if (pinchFactor === null && !event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        if (webkitGestureActive) return;
        if (!viewer.pdfDocument || document.visibilityState === "hidden")
          return;
        const factor =
          pinchFactor ??
          (event.deltaY < 0 ? 1.1 : event.deltaY > 0 ? 1 / 1.1 : 1);
        applyGestureFactor(
          factor,
          localOrigin(event.clientX, event.clientY),
          "wheel",
        );
      },
      { capture: true, passive: false, signal: lifecycle.signal },
    );

    let lastTouchOrigin = [stage.clientWidth / 2, stage.clientHeight / 2];
    const rememberTouchOrigin = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      lastTouchOrigin = localOrigin(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
      );
    };
    preview.addEventListener("touchstart", rememberTouchOrigin, {
      passive: true,
      signal: lifecycle.signal,
    });
    preview.addEventListener("touchmove", rememberTouchOrigin, {
      passive: true,
      signal: lifecycle.signal,
    });
    const PdfTouchManager = TouchManager as unknown as TouchManagerConstructor;
    const touchManager = new PdfTouchManager({
      container: preview,
      isPinchingDisabled: () => !viewer.pdfDocument,
      onPinching: (_origin, previousDistance, distance) => {
        applyGestureFactor(
          distance / previousDistance,
          lastTouchOrigin,
          "touch",
        );
      },
      onPinchEnd: () => {
        touchUnusedFactorRef.current = 1;
      },
      signal: lifecycle.signal,
    });

    type WebKitGestureEvent = Event & {
      scale?: number;
      clientX?: number;
      clientY?: number;
    };
    const webKitScale = (event: WebKitGestureEvent, fallback: number) =>
      typeof event.scale === "number" &&
      Number.isFinite(event.scale) &&
      event.scale > 0
        ? event.scale
        : fallback;
    let previousWebKitScale = 1;
    const onGestureStart = (rawEvent: Event) => {
      const event = rawEvent as WebKitGestureEvent;
      event.preventDefault();
      webkitGestureActive = true;
      previousWebKitScale = webKitScale(event, 1);
      touchUnusedFactorRef.current = 1;
    };
    const onGestureChange = (rawEvent: Event) => {
      const event = rawEvent as WebKitGestureEvent;
      event.preventDefault();
      if (!viewer.pdfDocument) return;
      const currentScale = webKitScale(event, previousWebKitScale);
      const factor = currentScale / previousWebKitScale;
      previousWebKitScale = currentScale;
      const stageRect = stage.getBoundingClientRect();
      applyGestureFactor(
        factor,
        localOrigin(
          event.clientX ?? stageRect.left + stage.clientWidth / 2,
          event.clientY ?? stageRect.top + stage.clientHeight / 2,
        ),
        "touch",
      );
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      webkitGestureActive = false;
      previousWebKitScale = 1;
      touchUnusedFactorRef.current = 1;
    };
    preview.addEventListener("gesturestart", onGestureStart, {
      capture: true,
      passive: false,
      signal: lifecycle.signal,
    });
    preview.addEventListener("gesturechange", onGestureChange, {
      capture: true,
      passive: false,
      signal: lifecycle.signal,
    });
    preview.addEventListener("gestureend", onGestureEnd, {
      capture: true,
      passive: false,
      signal: lifecycle.signal,
    });
    preview.addEventListener("gesturecancel", onGestureEnd, {
      capture: true,
      passive: false,
      signal: lifecycle.signal,
    });

    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (!viewer.pdfDocument) return;
        applyViewerZoom(
          viewer,
          scaleModeRef.current,
          zoomRef.current,
          PDF_IMMEDIATE_REDRAW_DELAY,
          [stage.clientWidth / 2, stage.clientHeight / 2],
        );
      }, RESIZE_SETTLE_MS);
    });
    resizeObserver.observe(stage);

    return () => {
      resizeObserver.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      touchManager.destroy();
      lifecycle.abort();
      eventBus.off("pagesinit", onPagesInit);
      eventBus.off("pagechanging", onPageChanging);
      eventBus.off("pagerender", onPageRender);
      eventBus.off("pagerendered", onPageRendered);
      clearViewerDocument(viewer);
      if (viewerRef.current === viewer) viewerRef.current = null;
      pagesDocumentRef.current = null;
      host.remove();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    let live = true;
    let failed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let resolvedDocument: PDFDocumentProxy | null = null;

    preserveLocationRef.current =
      loadedIdentityRef.current !== null &&
      appliedLocationKeyRef.current === currentLocationKeyRef.current;
    preserveLocationKeyRef.current = currentLocationKeyRef.current;
    pendingLocationKeyRef.current = currentLocationKeyRef.current;
    const requested = pdfLocationFromFragment(fragment);
    pendingViewRef.current = preserveLocationRef.current
      ? {
          page: pageNumberRef.current,
          zoom: zoomRef.current,
          scaleMode: scaleModeRef.current,
        }
      : {
          page: requested.page,
          zoom: requested.zoom,
          scaleMode: requested.scaleMode,
        };
    pendingNamedDestinationRef.current = !preserveLocationRef.current && Boolean(requested.namedDestination);
    if (!preserveLocationRef.current) {
      stageRef.current?.scrollTo(0, 0);
      pageNumberRef.current = requested.page;
      zoomRef.current = requested.zoom;
      scaleModeRef.current = requested.scaleMode;
      setPageNumber(requested.page);
      setPageDraft(String(requested.page));
      setZoom(requested.zoom);
      setScaleMode(requested.scaleMode);
    }

    if (viewer.pdfDocument) clearViewerDocument(viewer);
    pagesDocumentRef.current = null;
    setPdfDocument(null);
    setPageCount(0);
    setLoadedBytes(0);
    setError("");
    setPhase("loading");

    const fail = (reason: unknown) => {
      if (!live || failed) return;
      failed = true;
      if (
        reason instanceof PdfRangeResponseError &&
        (reason.status === 401 || reason.status === 412)
      ) {
        if (sourceInvalidRef.current()) {
          if (viewer.pdfDocument) clearViewerDocument(viewer);
          void loadingTask?.destroy();
          return;
        }
      }
      setError(describePdfError(reason));
      setPhase("error");
      if (viewer.pdfDocument) clearViewerDocument(viewer);
      void loadingTask?.destroy();
    };
    const range = new HttpPdfRangeTransport(
      size,
      url,
      (loaded) => {
        if (live) setLoadedBytes(loaded);
      },
      fail,
    );
    loadingTask = getDocument({
      range,
      rangeChunkSize: RANGE_CHUNK_BYTES,
      disableStream: true,
      disableAutoFetch: true,
      docBaseUrl: new URL(url, window.location.href).href,
      cMapUrl: `${PDF_ASSET_ROOT}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDF_ASSET_ROOT}/standard_fonts/`,
      wasmUrl: `${PDF_ASSET_ROOT}/wasm/`,
      iccUrl: `${PDF_ASSET_ROOT}/iccs/`,
      maxImageSize: -1,
      canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    });
    void loadingTask.promise.then((document) => {
      if (!live) return;
      resolvedDocument = document;
      sourceReadyRef.current();
      loadedIdentityRef.current = documentIdentity;
      setPdfDocument(document);
      setPageCount(document.numPages);
      setPhase("rendering");
      try {
        viewer.setDocument(document);
        void Promise.resolve(viewer.pagesPromise).catch(fail);
      } catch (reason) {
        fail(reason);
      }
    }, fail);
    return () => {
      live = false;
      range.abort();
      if (resolvedDocument && viewer.pdfDocument === resolvedDocument)
        clearViewerDocument(viewer);
      void loadingTask?.destroy();
    };
  }, [url, size, documentIdentity]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!pdfDocument || !viewer || pagesDocumentRef.current !== pdfDocument)
      return;
    if (appliedLocationKeyRef.current === locationKey) return;
    if (
      preserveLocationRef.current &&
      preserveLocationKeyRef.current === locationKey
    ) {
      preserveLocationRef.current = false;
      const next = Math.min(
        pdfDocument.numPages,
        Math.max(1, pageNumberRef.current),
      );
      applyViewerZoom(
        viewer,
        scaleModeRef.current,
        zoomRef.current,
        -1,
        undefined,
        next,
      );
      viewer.currentPageNumber = next;
      appliedLocationKeyRef.current = locationKey;
      return;
    }
    preserveLocationRef.current = false;
    let live = true;
    const location = pdfLocationFromFragment(fragment);
    scaleModeRef.current = location.scaleMode;
    zoomRef.current = location.zoom;
    setScaleMode(location.scaleMode);
    setZoom(location.zoom);
    void (async () => {
      let requestedPage = location.page;
      if (location.namedDestination) {
        try {
          const destination = await pdfDocument.getDestination(
            location.namedDestination,
          );
          const reference = destination?.[0];
          if (Number.isInteger(reference))
            requestedPage = Number(reference) + 1;
          else if (reference && typeof reference === "object")
            requestedPage = (await pdfDocument.getPageIndex(reference)) + 1;
        } catch {
        }
      }
      if (!live || viewer.pdfDocument !== pdfDocument) return;
      const nextPage = Math.min(
        pdfDocument.numPages,
        Math.max(1, requestedPage),
      );
      applyViewerZoom(
        viewer,
        location.scaleMode,
        location.zoom,
        PDF_IMMEDIATE_REDRAW_DELAY,
        undefined,
        nextPage,
      );
      viewer.currentPageNumber = nextPage;
      appliedLocationKeyRef.current = locationKey;
    })();
    return () => {
      live = false;
    };
  }, [pdfDocument, pagesEpoch, fragment, locationNonce, locationKey]);

  const commitPage = () => {
    const requested = Number(pageDraft);
    const next = Number.isFinite(requested)
      ? Math.min(pageCount || 1, Math.max(1, Math.round(requested)))
      : pageNumber;
    const viewer = viewerRef.current;
    if (viewer?.pdfDocument) viewer.currentPageNumber = next;
    else {
      pageNumberRef.current = next;
      setPageNumber(next);
      setPageDraft(String(next));
    }
  };
  const goToPage = (next: number) => {
    const bounded = Math.min(pageCount || 1, Math.max(1, next));
    const viewer = viewerRef.current;
    if (viewer?.pdfDocument) viewer.currentPageNumber = bounded;
  };
  const changeZoom = (next: number, nextMode = scaleModeRef.current) => {
    const bounded = Math.round(clampPdfZoom(next) * 100) / 100;
    zoomRef.current = bounded;
    scaleModeRef.current = nextMode;
    setZoom(bounded);
    setScaleMode(nextMode);
    const viewer = viewerRef.current;
    if (viewer?.pdfDocument) {
      const stage = stageRef.current;
      applyViewerZoom(
        viewer,
        nextMode,
        bounded,
        PDF_IMMEDIATE_REDRAW_DELAY,
        stage ? [stage.clientWidth / 2, stage.clientHeight / 2] : undefined,
      );
    }
  };

  const progressLabel = useMemo(() => {
    if (!loadedBytes) return t("pdf.preparing");
    return t("pdf.loaded", {
      loaded: formatBytes(loadedBytes),
      total: formatBytes(size),
    });
  }, [loadedBytes, size, t]);
  const workerRuntimeFailed =
    /fake worker|dynamically imported module|pdf\.worker/i.test(error);

  return (
    <div
      ref={previewRef}
      data-testid="pdf-preview"
      className={`oiia-pdf-preview @container relative flex size-full min-h-0 flex-col rounded-[5px] bg-[#F3F2ED] dark:bg-[#111] ${integratedToolbar ? 'overflow-visible' : 'overflow-hidden'}`}
    >
      <div
        data-testid="pdf-toolbar"
        data-integrated={integratedToolbar ? "true" : "false"}
        className={integratedToolbar
          ? "absolute right-8 top-[-52px] z-20 flex h-10 w-52 shrink-0 items-center gap-0.5 bg-transparent px-0.5 text-[#666] @sm/file:w-[21rem] @sm/file:gap-1 dark:text-[#AAA]"
          : "flex h-10 shrink-0 items-center gap-0.5 border-b border-[#E8EBE3] bg-[var(--app-surface)] px-1.5 text-[#666] @sm:gap-1.5 @sm:px-2.5 dark:border-[#333] dark:bg-[#1A1A1A] dark:text-[#AAA]"}
      >
        <button
          type="button"
          aria-label={t("pdf.previousPage")}
          title={t("pdf.previousPage")}
          disabled={pageNumber <= 1 || phase === "loading"}
          onClick={() => goToPage(pageNumber - 1)}
          className={toolbarButton}
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex items-center gap-1 text-[11.5px] tabular-nums">
          <input
            aria-label={t("pdf.pageNumber")}
            inputMode="numeric"
            value={pageDraft}
            onChange={(event) =>
              setPageDraft(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPage();
                event.currentTarget.blur();
              }
            }}
            className="h-7 w-10 rounded-md border border-[#DCDDD6] bg-white px-1 text-center text-[#444] outline-none focus:border-[#A9AAA3] dark:border-[#3A3A3A] dark:bg-[#242424] dark:text-[#DDD]"
          />
          <span className={integratedToolbar ? "sr-only text-[#92928C] @sm/file:not-sr-only @sm/file:min-w-8" : "min-w-8 text-[#92928C]"}>/ {pageCount || "—"}</span>
        </div>
        <button
          type="button"
          aria-label={t("pdf.nextPage")}
          title={t("pdf.nextPage")}
          disabled={!pageCount || pageNumber >= pageCount}
          onClick={() => goToPage(pageNumber + 1)}
          className={toolbarButton}
        >
          <ChevronRight className="size-4" />
        </button>

        <span className="mx-0.5 h-4 w-px bg-[#E8EBE3] @sm:mx-1 dark:bg-[#3A3A3A]" />
        <button
          type="button"
          aria-label={t("pdf.zoomOut")}
          title={t("pdf.zoomOut")}
          disabled={zoom <= 0.25 || phase === "loading"}
          onClick={() => changeZoom(zoom - 0.1)}
          className={toolbarButton}
        >
          <Minus className="size-3.5" />
        </button>
        <span
          data-testid="pdf-zoom"
          className={integratedToolbar
            ? "sr-only text-center text-[11px] tabular-nums text-[#777] @sm/file:not-sr-only @sm/file:block @sm/file:w-10 dark:text-[#AAA]"
            : "w-10 text-center text-[11px] tabular-nums text-[#777] dark:text-[#AAA]"}
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label={t("pdf.zoomIn")}
          title={t("pdf.zoomIn")}
          disabled={zoom >= 4 || phase === "loading"}
          onClick={() => changeZoom(zoom + 0.1)}
          className={toolbarButton}
        >
          <Plus className="size-3.5" />
        </button>
        <span className={integratedToolbar ? "hidden @sm/file:block" : "hidden @sm:block"}>
          <button
            type="button"
            aria-label={t("pdf.fitWidth")}
            title={t("pdf.fitWidth")}
            disabled={zoom === 1 && scaleMode === "fit-width"}
            onClick={() => changeZoom(1, "fit-width")}
            className={toolbarButton}
          >
            <RotateCcw className="size-3.5" />
          </button>
        </span>
        <span className={integratedToolbar ? "hidden" : "ml-auto hidden truncate text-[10.5px] text-[#999] @lg:block"}>
          {phase === "loading"
            ? progressLabel
            : `${pageCount} ${t(pageCount === 1 ? "pdf.page" : "pdf.pages")}`}
        </span>
        <button
          type="button"
          aria-label={t("pdf.openFullViewer")}
          title={t("pdf.openFullViewer")}
          onClick={() => onOpenFullViewer(pageNumber)}
          className={toolbarButton}
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={stageRef}
          data-testid="pdf-stage"
          role="region"
          tabIndex={0}
          aria-label={path}
          aria-busy={phase === "loading" || phase === "rendering"}
          className="oiia-pdf-stage absolute inset-0 overflow-auto overscroll-contain bg-[#F3F2ED] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#A9AAA3] dark:bg-[#111] dark:focus-visible:ring-[#666]"
        />
        {(phase === "loading" || phase === "rendering") && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
            aria-live="polite"
          >
            <div className="flex aspect-[0.707] h-[min(72%,620px)] max-w-[82%] flex-col items-center justify-center gap-3 rounded-[2px] bg-[#FBFAF7] text-center shadow-[0_2px_18px_rgba(53,48,36,0.10)] ring-1 ring-black/[0.05] dark:bg-[#202020]">
              <span
                className="oiia-loader"
                aria-label={
                  phase === "loading" ? t("pdf.preparing") : t("pdf.rendering")
                }
              >
                {PRODUCT_NAME}
              </span>
              <span className="px-5 text-[11px] text-[#999] dark:text-[#777]">
                {phase === "loading"
                  ? progressLabel
                  : t("pdf.renderingPage", { page: pageNumber })}
              </span>
            </div>
          </div>
        )}
        {phase === "error" && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-[#F3F2ED]/90 p-8 text-center backdrop-blur-[2px] dark:bg-[#111]/90"
            role="alert"
          >
            <div className="max-w-sm rounded-xl border border-[#E7DDD8] bg-[var(--app-surface)] p-5 shadow-sm dark:border-[#463632] dark:bg-[#1A1A1A]">
              <div className="text-[13px] font-medium text-[#8F3F37] dark:text-[#E59A92]">
                {t("pdf.failed")}
              </div>
              {error && (
                <div className="mt-1.5 break-words text-[11px] leading-relaxed text-[#999] dark:text-[#777]">
                  {error}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (workerRuntimeFailed) window.location.reload();
                    else onRetry();
                  }}
                  className="rounded-md border border-[#D8D9D2] bg-white px-3 py-1.5 text-[11.5px] text-[#555] transition-[transform,background-color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.97] hover:bg-[#F1F1EC] motion-reduce:transition-none dark:border-[#444] dark:bg-[#252525] dark:text-[#CCC] dark:hover:bg-[#303030]"
                >
                  {t(workerRuntimeFailed ? "file.reload" : "pdf.retry")}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenFullViewer(pageNumber)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11.5px] text-[#777] hover:text-[#333] dark:text-[#999] dark:hover:text-[#DDD]"
                >
                  <ExternalLink className="size-3.5" />
                  {t("pdf.openFullViewer")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
