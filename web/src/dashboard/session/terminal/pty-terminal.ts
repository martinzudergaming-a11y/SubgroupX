import type { Terminal } from 'ghostty-web';
import { getToken } from '../../../platform/api';
import { safeGet } from '../../../platform/storage';
import { PredictionEngine, isPredictableChar, looksLikeSecretPrompt } from './predict-echo';

export type PtyState = 'idle' | 'connecting' | 'open' | 'ended' | 'verification_required';

const PREDICT_MIN_RTT_MS = 80;
const PING_INTERVAL_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 6;

const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", monospace';

export interface PtyControllerOptions {
  container: HTMLElement;
  sessionId: string;
  remote: boolean;
  spawn: boolean;
  onState: (state: PtyState) => void;
}

export class PtyController {
  private readonly opts: PtyControllerOptions;
  private disposed = false;

  private host: HTMLDivElement | null = null;
  private term: Terminal | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private ended = false;
  private idle = false;
  private createOnConnect: boolean;
  private suppressInput = true;
  private readonly encoder = new TextEncoder();

  private readonly predictor = new PredictionEngine({ maxAgeMs: 1200 });
  private readonly forced: boolean;
  private readonly predictDisabled: boolean;
  private rttEma = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private overlay: HTMLSpanElement | null = null;

  private mirror: HTMLDivElement | null = null;
  private mirrorRaf = 0;

  private mouseButton = -1;
  private lastMouseCell: { x: number; y: number } | null = null;
  private readonly docDisposers: Array<() => void> = [];

  constructor(opts: PtyControllerOptions) {
    this.opts = opts;
    this.createOnConnect = opts.spawn;
    const predictFlag = safeGet('oiia.predict');
    this.forced = predictFlag === 'force';
    this.predictDisabled = predictFlag === 'off' || (!opts.remote && !this.forced);
    opts.onState('connecting');
    void this.start();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.mirrorRaf) cancelAnimationFrame(this.mirrorRaf);
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    for (const off of this.docDisposers.splice(0)) off();
    this.term?.dispose();
    this.term = null;
    this.host?.remove();
    this.host = null;
  }

  private async start(): Promise<void> {
    const { Terminal, FitAddon, init } = await import('ghostty-web');
    await init();
    if (this.disposed) return;

    const dark =
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ||
      document.documentElement.classList.contains('dark');
    const surface =
      getComputedStyle(document.documentElement).getPropertyValue('--app-surface').trim() || '#FFFFFF';
    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      cursorBlink: true,
      theme: dark
        ? { background: '#1A1A1A', foreground: '#E0E0E0', cursor: '#E0E0E0', selectionBackground: '#3A3A3A' }
        : { background: surface, foreground: '#2A2A2A', cursor: '#2A2A2A', selectionBackground: '#D6E4FF' },
    });
    this.term = term;
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.caretColor = 'transparent';
    host.style.outline = 'none';
    this.host = host;
    this.opts.container.appendChild(host);
    const fit = new FitAddon();
    term.loadAddon(fit);
    const originalDocumentAdd = document.addEventListener;
    const ghosttyDocumentListeners: Array<{
      type: string;
      listener: EventListenerOrEventListenerObject;
      options?: boolean | AddEventListenerOptions;
    }> = [];
    document.addEventListener = function captureGhosttyDocumentListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      ghosttyDocumentListeners.push({ type, listener, options });
      originalDocumentAdd.call(document, type, listener, options);
    } as typeof document.addEventListener;
    try {
      term.open(host);
    } finally {
      document.addEventListener = originalDocumentAdd;
      for (const { type, listener, options } of ghosttyDocumentListeners) {
        this.docDisposers.push(() => document.removeEventListener(type, listener, options));
      }
    }
    this.mirror = this.createMirror();

    const syncSize = () => {
      if (this.disposed) return;
      try {
        fit.fit();
        this.sendResize();
      } catch {
      }
    };
    syncSize();
    void document.fonts?.ready.then(() => {
      if (this.disposed) return;
      term.renderer?.remeasureFont();
      syncSize();
    });
    fit.observeResize();
    term.onResize(() => {
      this.sendResize();
    });

    term.onData((data) => {
      if (this.suppressInput) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(this.encoder.encode(data));
      try {
        this.maybePredict(data);
      } catch {
        this.flushPredictions();
      }
    });

    this.attachMouseReporting(term, host);
    this.connect(syncSize);
    term.focus();
  }

  private attachMouseReporting(term: Terminal, host: HTMLElement): void {
    const tracking = () => !this.suppressInput && term.hasMouseTracking();
    const listen = (target: EventTarget, type: string, fn: (ev: Event) => void, capture = true) => {
      target.addEventListener(type, fn, capture);
      this.docDisposers.push(() => target.removeEventListener(type, fn, capture));
    };
    listen(host, 'mousedown', (ev) => {
      const e = ev as MouseEvent;
      if (!tracking() || e.shiftKey || e.button > 1) return;
      const cell = this.mouseCell(e);
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      this.term?.focus();
      this.mouseButton = e.button;
      this.lastMouseCell = cell;
      this.sendMouseReport(e.button, cell, e, false);
    });
    listen(host, 'mousemove', (ev) => {
      const e = ev as MouseEvent;
      if (!tracking() || e.shiftKey) return;
      const drag = this.mouseButton >= 0;
      if (!(drag ? term.getMode(1002) || term.getMode(1003) : term.getMode(1003))) return;
      const cell = this.mouseCell(e);
      if (!cell || (this.lastMouseCell && cell.x === this.lastMouseCell.x && cell.y === this.lastMouseCell.y)) return;
      e.stopPropagation();
      this.lastMouseCell = cell;
      this.sendMouseReport((drag ? this.mouseButton : 3) + 32, cell, e, false);
    });
    listen(document, 'mouseup', (ev) => {
      const e = ev as MouseEvent;
      if (this.mouseButton < 0) return;
      const btn = this.mouseButton;
      this.mouseButton = -1;
      const cell = this.mouseCell(e) ?? this.lastMouseCell;
      this.lastMouseCell = null;
      if (!tracking() || !cell) return;
      e.stopPropagation();
      this.sendMouseReport(btn, cell, e, true);
    });
    term.attachCustomWheelEventHandler((e) => {
      if (!tracking() || e.shiftKey) return false;
      const cell = this.mouseCell(e);
      if (!cell) return false;
      this.sendMouseReport(e.deltaY < 0 ? 64 : 65, cell, e, false);
      return true;
    });
    listen(host, 'focusin', () => {
      if (!this.suppressInput && term.hasFocusEvents()) this.sendRaw('\x1b[I');
    }, false);
    listen(host, 'focusout', () => {
      if (!this.suppressInput && term.hasFocusEvents()) this.sendRaw('\x1b[O');
    }, false);
  }

  private mouseCell(ev: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const term = this.term;
    const renderer = term?.renderer;
    const canvas = renderer?.getCanvas();
    if (!term || !renderer || !canvas || renderer.charWidth <= 0 || renderer.charHeight <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / renderer.charWidth) + 1;
    const y = Math.floor((ev.clientY - rect.top) / renderer.charHeight) + 1;
    if (x < 1 || y < 1 || x > term.cols || y > term.rows) return null;
    return { x, y };
  }

  private sendMouseReport(button: number, cell: { x: number; y: number }, ev: { altKey: boolean; ctrlKey: boolean }, release: boolean): void {
    let b = button;
    if (ev.altKey) b += 8;
    if (ev.ctrlKey) b += 16;
    if (this.term?.getMode(1006)) {
      this.sendRaw(`\x1b[<${b};${cell.x};${cell.y}${release ? 'm' : 'M'}`);
      return;
    }
    if (cell.x > 223 || cell.y > 223) return;
    if (release) b = (b & 0b11100) | 3;
    this.sendRaw(`\x1b[M${String.fromCharCode(32 + b)}${String.fromCharCode(32 + cell.x)}${String.fromCharCode(32 + cell.y)}`);
  }

  private sendRaw(seq: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(this.encoder.encode(seq));
  }

  private connect(syncSize: () => void): void {
    if (this.disposed || !this.term || this.ended || this.idle) return;
    this.opts.onState('connecting');
    this.suppressInput = true;
    const create = this.createOnConnect;
    this.createOnConnect = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url =
      `${proto}://${location.host}/pty?token=${encodeURIComponent(getToken() ?? '')}` +
      `&sessionId=${encodeURIComponent(this.opts.sessionId)}&cols=${this.term.cols}&rows=${this.term.rows}&create=${create ? '1' : '0'}`;
    const ws = new WebSocket(url);
    this.socket = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.attempts = 0;
      this.term?.reset();
      this.scheduleMirrorUpdate();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleControlFrame(ev.data, syncSize);
        return;
      }
      if (!this.term) return;
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      const wasActive = !this.predictor.isEmpty;
      if (wasActive) this.predictor.reconcile(bytes);
      this.term.write(
        bytes,
        wasActive
          ? () => {
              try {
                this.renderOverlay();
              } catch {
                this.hideOverlay();
              }
            }
          : undefined,
      );
      this.scheduleMirrorUpdate();
    };

    ws.onclose = (ev) => {
      if (this.disposed || this.ended || this.idle || ws !== this.socket) return;
      if (ev.code === 4003) {
        this.ended = true;
        this.opts.onState('ended');
        return;
      }
      if (ev.code === 4005) {
        this.ended = true;
        this.opts.onState('verification_required');
        return;
      }
      if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
        this.opts.onState('ended');
        return;
      }
      this.opts.onState('connecting');
      const delay = Math.min(1000 * 2 ** this.attempts, 8000);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(syncSize), delay);
    };

    ws.onerror = () => ws.close();
  }

  private handleControlFrame(raw: string, syncSize: () => void): void {
    let msg: { type?: string; ts?: number };
    try {
      msg = JSON.parse(raw) as { type?: string; ts?: number };
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      this.opts.onState('open');
      syncSize();
      this.suppressInput = false;
      if (!this.predictDisabled && !this.pingTimer) {
        const ping = () => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'ping', seq: ++this.pingSeq, ts: performance.now() }));
          }
        };
        ping();
        this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
      }
    } else if (msg.type === 'pong' && typeof msg.ts === 'number') {
      const rtt = performance.now() - msg.ts;
      this.rttEma = this.rttEma > 0 ? this.rttEma * 0.8 + rtt * 0.2 : rtt;
    } else if (msg.type === 'no_terminal') {
      this.idle = true;
      this.opts.onState('idle');
    } else if (msg.type === 'exit' || msg.type === 'error') {
      this.ended = true;
      this.opts.onState('ended');
    }
  }

  private sendResize(): void {
    if (this.term && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
    }
  }

  private predictable(): boolean {
    return (
      !this.predictDisabled &&
      !this.suppressInput &&
      (this.forced || this.rttEma > PREDICT_MIN_RTT_MS) &&
      this.term?.buffer.active.type === 'normal'
    );
  }

  private cursorLine() {
    const term = this.term;
    if (!term) return undefined;
    const buf = term.buffer.active;
    return buf.getLine(buf.length - term.rows + buf.cursorY);
  }

  private maybePredict(data: string): void {
    if (!this.predictable()) {
      this.flushPredictions();
      return;
    }
    if (data === '\x7f' || data === '\b') {
      if (this.predictor.backspace()) this.renderOverlay();
      return;
    }
    const term = this.term;
    if (!isPredictableChar(data) || !term) {
      this.flushPredictions();
      return;
    }
    const buf = term.buffer.active;
    const line = this.cursorLine();
    const atEnd = (line?.getCell(buf.cursorX)?.getChars() ?? '') === '';
    if (!atEnd || looksLikeSecretPrompt(line?.translateToString(true, 0, buf.cursorX) ?? '')) {
      this.flushPredictions();
      return;
    }
    if (this.predictor.predict(data, performance.now())) this.renderOverlay();
  }

  private flushPredictions(): void {
    this.predictor.flush();
    this.hideOverlay();
  }

  private hideOverlay(): void {
    if (this.overlay) this.overlay.style.display = 'none';
  }

  private renderOverlay(): void {
    const term = this.term;
    const chars = this.predictor.pendingChars;
    const renderer = term?.renderer;
    const canvas = renderer?.getCanvas();
    if (!term || !renderer || !canvas || chars.length === 0 || term.getViewportY() > 0) {
      this.hideOverlay();
      return;
    }
    const buf = term.buffer.active;
    if (buf.cursorX + chars.length > term.cols) {
      this.hideOverlay();
      return;
    }
    let el = this.overlay;
    if (!el) {
      el = document.createElement('span');
      el.contentEditable = 'false';
      el.setAttribute('aria-hidden', 'true');
      el.style.position = 'absolute';
      el.style.color = '#8a8a8a';
      el.style.opacity = '0.75';
      el.style.fontWeight = 'normal';
      el.style.letterSpacing = '0';
      el.style.whiteSpace = 'pre';
      el.style.pointerEvents = 'none';
      el.style.overflow = 'hidden';
      this.host?.appendChild(el);
      this.overlay = el;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const hostRect = this.host?.getBoundingClientRect();
    if (!hostRect) return;
    el.style.left = `${canvasRect.left - hostRect.left + buf.cursorX * renderer.charWidth}px`;
    el.style.top = `${canvasRect.top - hostRect.top + buf.cursorY * renderer.charHeight}px`;
    el.style.height = `${renderer.charHeight}px`;
    el.style.lineHeight = `${renderer.charHeight}px`;
    el.style.fontFamily = String(term.options.fontFamily);
    el.style.fontSize = `${term.options.fontSize}px`;
    el.textContent = chars.join('');
    el.style.display = 'block';
  }

  private createMirror(): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('aria-live', 'off');
    el.setAttribute('role', 'log');
    el.contentEditable = 'false';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.overflow = 'hidden';
    el.style.opacity = '0';
    el.style.whiteSpace = 'pre';
    el.style.pointerEvents = 'none';
    this.host?.appendChild(el);
    return el;
  }

  private scheduleMirrorUpdate(): void {
    if (this.mirrorRaf) return;
    this.mirrorRaf = requestAnimationFrame(() => {
      this.mirrorRaf = 0;
      const term = this.term;
      if (this.disposed || !term || !this.mirror) return;
      const buf = term.buffer.active;
      const top = buf.length - term.rows;
      let text = '';
      for (let y = 0; y < term.rows; y++) {
        text += `${buf.getLine(top + y)?.translateToString(true) ?? ''}\n`;
      }
      this.mirror.textContent = text;
    });
  }
}
