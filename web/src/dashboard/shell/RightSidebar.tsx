import { LazyMotion, m, domAnimation, AnimatePresence, useIsPresent } from "motion/react";
import { Spinner } from "../../ui/Spinner";
import { FolderTree, GitCompareArrows, History, Search, Download, SquareTerminal, Waypoints, Wrench, DatabaseZap } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../platform/api.ts";
import { startColumnResize } from "./startColumnResize";
import { useT } from "../../i18n";
import { fallbackFileEntryVersion, type FileEntry, type TimelineItem, type SessionInfo } from "@shared/protocol";
import { FilePreview, warmPdfPreviewRuntime } from "../../files/FilePreview";
import { fileIconFor } from "../../files/fileIcons";
import { writeClipboard } from "../../platform/clipboard";
import { ToolDetail } from "../session/tools/ToolDetail";
import { CanvasCard } from "../session/timeline/CanvasCard";
import { ChangesPane } from "../../files/ChangesPane";
import { PRODUCT_NAME } from '../../platform/brand';
import { TerminalPanel, PTY_STATE_DOT, ptyStateLabel, backendLabel } from '../session/terminal/TerminalPanel';
import type { PtyState } from '../session/terminal/pty-terminal';
import { StatusDot } from '../../ui/StatusDot';
import { HoverLabel } from '../ui/HoverLabel';
import { CompactionPane, TreeItem, StatusPill, TabItem, type ToolItem } from './RightSidebar-parts';
import { FileContentCache } from '../../files/file-content-cache';
import { mediaPreviewKind, warmFilePreviewSource } from '../../files/media-preview-source';
import { safeGet, safeRemove, safeSet } from '../../platform/storage';

const RunInspector = React.lazy(() => import('../session/run/RunInspector').then(({ RunInspector }) => ({ default: RunInspector })));

const RS_MIN_W = 300;
const RS_CHAT_MIN_W = 480;
const RS_WIDTH_KEY = "oiia.workspacePaneWidth";
const RS_LEGACY_WIDTH_KEY = "agentweb.rightSidebarWidth";
const adaptiveSidebarWidth = () => {
  const viewport = typeof window === "undefined" ? 1440 : window.innerWidth;
  return Math.round(Math.min(860, Math.max(560, viewport * 0.46)));
};
function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash <= 0 ? '.' : filePath.slice(0, slash);
}
function storedSidebarPreference(): number | null {
  const current = safeGet(RS_WIDTH_KEY);
  const legacy = current === null ? safeGet(RS_LEGACY_WIDTH_KEY) : null;
  const stored = Number(current ?? legacy);
  if (!Number.isFinite(stored) || stored < RS_MIN_W) return null;
  const width = Math.min(stored, 1200);
  if (legacy !== null) {
    safeSet(RS_WIDTH_KEY, String(width));
    safeRemove(RS_LEGACY_WIDTH_KEY);
  }
  return width;
}
function storedSidebarWidth(): number {
  return storedSidebarPreference() ?? adaptiveSidebarWidth();
}

type RightSidebarProps = {
  sessionId: string;
  session?: SessionInfo | null;
  refreshKey: number;
  openTool: { id: string; n: number } | null;
  openFile?: { sessionId: string; path: string; frag?: string; n: number } | null;
  openCompaction?: { id: string; n: number } | null;
  timelineItems: TimelineItem[];
  onRequestReview?: (prompt: string) => void;
  mobile?: boolean;
};

function WorkspaceRailButton({ icon, label, active, onClick }: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`group/hoverlabel relative flex size-[30px] shrink-0 items-center justify-center rounded-md outline-none transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(.16,1,.3,1)] active:scale-[.96] focus-visible:ring-2 focus-visible:ring-[#8F958A]/40 motion-reduce:transition-none ${
        active
          ? 'bg-[#EFF1EB] text-[#565C53] dark:bg-[#292B28] dark:text-[#D8DBD4]'
          : 'text-[#92978F] hover:bg-[#F5F6F2] hover:text-[#62675F] dark:text-[#747970] dark:hover:bg-[#242623] dark:hover:text-[#AEB2AA]'
      }`}
    >
      {icon}
      <HoverLabel label={label} placement="right" />
    </button>
  );
}

export function RightSidebar({ sessionId, session, refreshKey, openTool, openFile, openCompaction, timelineItems, onRequestReview, mobile = false }: RightSidebarProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<string>('files');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileNavigatorOnly, setFileNavigatorOnly] = useState(false);
  const [termState, setTermState] = useState<PtyState>('connecting');
  const [openedFiles, setOpenedFiles] = useState<string[]>([]);
  const [width, setWidth] = useState(storedSidebarWidth);
  const userSizedRef = useRef(storedSidebarPreference() !== null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileCacheRef = useRef(new FileContentCache());
  const fileInflightRef = useRef<Map<string, symbol>>(new Map());
  const requestSessionRef = useRef(sessionId);
  requestSessionRef.current = sessionId;
  const hoverTimer = useRef<number | null>(null);
  const isPresent = useIsPresent();
  useEffect(() => {
    if (!isPresent && hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, [isPresent]);
  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);
  const fileStaleRef = useRef<Set<string>>(new Set());
  const [fileByPath, setFileByPath] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [previewFrag, setPreviewFrag] = useState<{ sessionId: string; path: string; frag: string; n: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [downloadingAll, setDownloadingAll] = useState(false);
  useEffect(() => {
    if (mobile || userSizedRef.current) return;
    const adapt = () => setWidth(adaptiveSidebarWidth());
    window.addEventListener('resize', adapt);
    return () => window.removeEventListener('resize', adapt);
  }, [mobile]);
  const ROOT = '.';
  const [childrenByDir, setChildrenByDir] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const rootLoading = loadingDirs.has(ROOT) && !childrenByDir.has(ROOT);
  const childrenByDirRef = useRef(childrenByDir);
  const dirInflightRef = useRef<Map<string, symbol>>(new Map());
  childrenByDirRef.current = childrenByDir;
  const mediaVersionByPath = useMemo(() => {
    const versions = new Map<string, string>();
    for (const entries of childrenByDir.values()) {
      for (const entry of entries) {
        if (entry.kind === "file") versions.set(entry.path, entry.version ?? fallbackFileEntryVersion(entry));
      }
    }
    return versions;
  }, [childrenByDir]);
  const mediaVersionByPathRef = useRef(mediaVersionByPath);
  mediaVersionByPathRef.current = mediaVersionByPath;
  const mediaVersionFor = useCallback(
    (path: string) => mediaVersionByPathRef.current.get(path) ?? "unknown",
    [],
  );
  const treeGenRef = useRef(0);

  const flashNotice = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? '' : cur)), 3000);
  };

  const downloadEntry = (entry: FileEntry) => {
    api.downloadFile(sessionId, entry.path).catch((e) => flashNotice(e instanceof Error ? e.message : t('rs.errorDownloadFailed')));
  };

  const downloadAll = () => {
    if (downloadingAll) return;
    setDownloadingAll(true);
    api
      .downloadAllFiles(sessionId)
      .catch((e) => flashNotice(e instanceof Error ? e.message : t('rs.errorDownloadFailed')))
      .finally(() => setDownloadingAll(false));
  };

  const copyEntry = async (entry: FileEntry) => {
    try {
      const res = await api.readFile(sessionId, entry.path);
      if (res.binary) {
        flashNotice(t('rs.errorBinary'));
        return;
      }
      if (!(await writeClipboard(res.content))) {
        flashNotice(t('rs.errorCopyFailed'));
        return;
      }
      setCopiedPath(entry.path);
      window.setTimeout(() => setCopiedPath((p) => (p === entry.path ? null : p)), 1500);
    } catch (e) {
      flashNotice(e instanceof Error ? e.message : t('rs.errorCopyFailed'));
    }
  };

  const loadDir = useCallback(
    (path: string, force = false): Promise<void> => {
      const gen = treeGenRef.current;
      if (!force && dirInflightRef.current.has(path)) return Promise.resolve();
      const requestToken = Symbol(path);
      dirInflightRef.current.set(path, requestToken);
      setLoadingDirs((s) => new Set(s).add(path));
      return api.files(sessionId, path)
        .then((res) => {
          if (gen !== treeGenRef.current || dirInflightRef.current.get(path) !== requestToken) return;
          setChildrenByDir((m) => new Map(m).set(path, res.entries));
        })
        .catch(() => {
          if (gen !== treeGenRef.current || dirInflightRef.current.get(path) !== requestToken) return;
          setChildrenByDir((m) => (m.has(path) && !force ? m : new Map(m).set(path, [])));
        })
        .finally(() => {
          if (gen !== treeGenRef.current || dirInflightRef.current.get(path) !== requestToken) return;
          dirInflightRef.current.delete(path);
          setLoadingDirs((s) => {
            const n = new Set(s);
            n.delete(path);
            return n;
          });
        });
    },
    [sessionId],
  );

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(path)) {
          n.delete(path);
        } else {
          n.add(path);
          if (!childrenByDir.has(path)) void loadDir(path);
        }
        return n;
      });
    },
    [childrenByDir, loadDir],
  );

  useEffect(() => {
    treeGenRef.current++;
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setChildrenByDir(new Map());
    setExpanded(new Set());
    setLoadingDirs(new Set());
    dirInflightRef.current.clear();
    fileCacheRef.current.clear();
    fileInflightRef.current.clear();
    fileStaleRef.current.clear();
    setFileByPath(new Map());
    setOpenedFiles([]);
    setActiveFile(null);
    setFileNavigatorOnly(false);
    setActiveTab('files');
    setPreviewFrag(null);
    void loadDir(ROOT, true);
  }, [sessionId, loadDir]);

  const loadFile = useCallback(
    (path: string, force = false) => {
      const mediaKind = mediaPreviewKind(path);
      if (mediaKind) {
        if (mediaKind === 'pdf') warmPdfPreviewRuntime();
        warmFilePreviewSource(sessionId, path, mediaVersionFor(path));
        return;
      }
      const cached = fileCacheRef.current.read(path);
      const stale = fileStaleRef.current.has(path);
      if (!force && cached !== null && !stale) return;
      if (fileInflightRef.current.has(path) && !force) return;
      const requestSession = sessionId;
      const requestToken = Symbol(path);
      fileInflightRef.current.set(path, requestToken);

      void (async () => {
        try {
          const res = await api.readFile(sessionId, path);
          if (requestSessionRef.current !== requestSession || fileInflightRef.current.get(path) !== requestToken) return;
          fileStaleRef.current.delete(path);
          if (res.content !== cached) {
            fileCacheRef.current.write(path, res.content);
            setFileByPath(fileCacheRef.current.snapshot());
          }
        } catch {
        } finally {
          if (fileInflightRef.current.get(path) === requestToken) fileInflightRef.current.delete(path);
        }
      })();
    },
    [sessionId, mediaVersionFor],
  );

  const prevRefresh = useRef(refreshKey);
  useEffect(() => {
    if (prevRefresh.current === refreshKey) return;
    prevRefresh.current = refreshKey;
    const dirsToRefresh = new Set<string>([ROOT, ...expanded]);
    for (const path of openedFiles) {
      if (mediaPreviewKind(path)) dirsToRefresh.add(parentDir(path));
    }
    for (const path of dirsToRefresh) void loadDir(path, true);
    for (const p of fileCacheRef.current.stats().paths) fileStaleRef.current.add(p);
    if (activeFile && openedFiles.includes(activeFile) && !mediaPreviewKind(activeFile)) void loadFile(activeFile, true);
  }, [refreshKey, expanded, loadDir, openedFiles, activeFile, sessionId, loadFile]);

  useEffect(() => {
    if (activeFile && openedFiles.includes(activeFile) && !mediaPreviewKind(activeFile) && !fileByPath.has(activeFile)) loadFile(activeFile);
  }, [openedFiles, activeFile, fileByPath, loadFile]);

  const openFileInTab = useCallback(
    (path: string) => {
      setOpenedFiles((cur) => (cur.includes(path) ? cur : [...cur, path]));
      setActiveFile(path);
      setFileNavigatorOnly(false);
      setActiveTab('files');
      if (mediaPreviewKind(path) && !childrenByDirRef.current.has(parentDir(path))) void loadDir(parentDir(path));
      loadFile(path);
    },
    [loadDir, loadFile],
  );

  const closeFileTab = useCallback((path: string) => {
    const nextFiles = openedFiles.filter((current) => current !== path);
    setOpenedFiles(nextFiles);
    if (activeFile === path) {
      setActiveFile(nextFiles.length > 0 ? nextFiles[nextFiles.length - 1] : null);
      if (nextFiles.length === 0) setFileNavigatorOnly(true);
    }
    fileCacheRef.current.delete(path);
    setFileByPath(fileCacheRef.current.snapshot());
    setPreviewFrag((current) => current?.sessionId === sessionId && current.path === path ? null : current);
  }, [activeFile, openedFiles, sessionId]);

  const prefetchOnHover = useCallback(
    (path: string, isDir: boolean) => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => {
        if (isDir) { if (!childrenByDir.has(path)) void loadDir(path); }
        else {
          const mediaKind = mediaPreviewKind(path);
          if (mediaKind) {
            if (mediaKind === 'pdf') warmPdfPreviewRuntime();
            warmFilePreviewSource(sessionId, path, mediaVersionFor(path));
          } else loadFile(path);
        }
      }, 110);
    },
    [childrenByDir, loadDir, loadFile, sessionId, mediaVersionFor],
  );
  const cancelHoverPrefetch = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!openTool) {
      setActiveTab((prev) => (prev === 'tool' ? 'files' : prev));
      return;
    }
    setActiveTab('tool');
  }, [openTool?.n, openTool]);

  useEffect(() => {
    if (!openCompaction) {
      setActiveTab((prev) => (prev === 'compaction' ? 'files' : prev));
      return;
    }
    setActiveTab('compaction');
  }, [openCompaction?.n, openCompaction]);

  useEffect(() => {
    if (openFile?.sessionId === sessionId) {
      setPreviewFrag(openFile.frag ? { sessionId, path: openFile.path, frag: openFile.frag, n: openFile.n } : null);
      openFileInTab(openFile.path);
    }
  }, [openFile, openFileInTab]);

  const activeTool = useMemo(
    () => timelineItems.find((i): i is ToolItem => i.kind === 'tool' && i.id === openTool?.id) ?? null,
    [timelineItems, openTool?.id],
  );

  const handleDrag = (e: React.MouseEvent) => {
    const panel = panelRef.current;
    const rowWidth = panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const max = Math.max(RS_MIN_W, rowWidth - RS_CHAT_MIN_W);
    startColumnResize(e, {
      startWidth: panel?.getBoundingClientRect().width ?? width,
      min: RS_MIN_W,
      max,
      sign: -1,
      onWidth: (w) => {
        userSizedRef.current = true;
        setWidth(w);
        safeSet(RS_WIDTH_KEY, String(Math.round(w)));
      },
    });
  };

  const matchesFilter = useCallback(
    (name: string) => !filter.trim() || name.toLowerCase().includes(filter.trim().toLowerCase()),
    [filter],
  );

  const shellItems = useMemo(
    () => timelineItems.filter((item): item is ToolItem => item.kind === 'tool' && item.toolKind === 'shell'),
    [timelineItems],
  );
  const changeItems = useMemo(
    () => timelineItems.filter((item): item is ToolItem => item.kind === 'tool' && (item.toolKind === 'write' || item.toolKind === 'edit')),
    [timelineItems],
  );
  function renderDir(dirPath: string, depth: number): React.ReactNode {
    const entries = childrenByDir.get(dirPath);
    if (entries === undefined) {
      return loadingDirs.has(dirPath) ? (
        <div className="py-1 text-[#999] dark:text-[#777]" style={{ paddingLeft: `${depth * 14 + 34}px` }}>
          <Spinner className="inline-block size-2.5" strokeWidth={3.6} />
        </div>
      ) : null;
    }
    const sorted = [...entries]
      .filter((e) => matchesFilter(e.name))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return sorted.map((entry) => {
      const isDir = entry.kind === 'directory';
      const isMedia = !isDir && Boolean(mediaPreviewKind(entry.path));
      const isExp = isDir && expanded.has(entry.path);
      return (
        <React.Fragment key={entry.path}>
          <TreeItem
            name={entry.name}
            depth={depth}
            kind={isDir ? 'folder' : 'file'}
            isOpen={isExp}
            isActive={activeFile === entry.path}
            onClick={() => (isDir ? toggleDir(entry.path) : openFileInTab(entry.path))}
            onHover={() => prefetchOnHover(entry.path, isDir)}
            onHoverEnd={cancelHoverPrefetch}
            onDownload={isDir ? undefined : () => downloadEntry(entry)}
            onCopy={isDir || isMedia ? undefined : () => void copyEntry(entry)}
            copied={copiedPath === entry.path}
            testId={`file-${entry.name}`}
          />
          {isExp && renderDir(entry.path, depth + 1)}
        </React.Fragment>
      );
    });
  }

  const getFileIcon = (fileName: string) => fileIconFor(fileName.split('/').pop() ?? fileName);

  const fileBrowserPane = (
    <div
      data-testid="file-browser"
      className={`@container ${mobile ? 'w-full' : `w-[clamp(9.5rem,30%,14rem)] border-r border-[#ECEEE7] dark:border-[#2C2E2B] ${activeFile && !fileNavigatorOnly ? '@max-[32.5rem]/workbench:hidden' : ''}`} min-w-0 shrink-0 h-full flex flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]`}
    >
      <div className="px-1.5 pt-3 pb-2 sticky top-0 bg-[var(--app-surface)] dark:bg-[#1A1A1A] z-10 shrink-0 space-y-2">
        <div className="flex min-h-9 md:min-h-0 items-center px-2 py-1.5 bg-[#F5F5F5] dark:bg-[#222] rounded-[6px] group">
          <Search strokeWidth={2.5} className="size-[13px] text-[#999] dark:text-[#888] shrink-0 mr-2" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('rs.filterPlaceholder')}
            aria-label={t('rs.filterPlaceholder')}
            className="min-w-0 bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-[12.5px] text-[#333] dark:text-[#E0E0E0] placeholder-[#A3A3A3] dark:placeholder-[#666] w-full"
          />
        </div>
        <div className="flex items-center justify-between px-2 text-[11px] text-[#888] dark:text-[#888]">
          <span className="min-w-0 flex-1 truncate pr-2" title="/">/</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="rs-download-all"
              title={t('rs.downloadAll')}
              aria-label={t('rs.downloadAll')}
              disabled={downloadingAll}
              className="min-h-9 md:min-h-0 px-2 md:px-0 rounded-md hover:text-[#333] dark:hover:text-[#E0E0E0] flex items-center gap-1 disabled:opacity-50"
              onClick={downloadAll}
            >
              {downloadingAll ? (
                <Spinner className="size-2.5" strokeWidth={3.6} />
              ) : (
                <Download className="size-[13px]" />
              )}
              <span className="hidden @min-[13rem]:inline">{t('rs.downloadAll')}</span>
            </button>
            <button
              type="button"
              aria-label={t('rs.refresh')}
              title={t('rs.refresh')}
              className="min-h-9 md:min-h-0 px-2 md:px-0 rounded-md hover:text-[#333] dark:hover:text-[#E0E0E0] flex items-center gap-1"
              onClick={() => { void loadDir(ROOT, true); for (const p of expanded) void loadDir(p, true); }}
            >
              {loadingDirs.size > 0 && <Spinner className="size-2.5" strokeWidth={3.6} />}
              <span className="hidden @min-[13rem]:inline">{t('rs.refresh')}</span>
            </button>
          </div>
        </div>
        {notice && (
          <output className="block px-2 text-[11px] text-[#B45309] dark:text-[#E0B97F]">{notice}</output>
        )}
      </div>

      <div className="flex-1 overflow-y-auto w-full pt-1 pb-6 relative">
        {rootLoading ? (
          <div className="px-3 pt-1 space-y-2" data-testid="file-skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[16px] rounded bg-[#F0F0F0] dark:bg-[#262626] animate-pulse" style={{ width: `${70 - i * 7}%` }} />
            ))}
          </div>
        ) : (
          renderDir(ROOT, 0)
        )}
      </div>
    </div>
  );

  const filePreviewPane = activeFile ? (
    <div data-testid="file-view" className={`relative min-w-0 flex-1 h-full overflow-hidden flex-col hide-scrollbar bg-[var(--app-surface)] dark:bg-[#1A1A1A] ${!mobile && fileNavigatorOnly ? 'flex @max-[32.5rem]/workbench:hidden' : 'flex'}`}>
      {mediaPreviewKind(activeFile) || fileByPath.has(activeFile) ? (
        <m.div key={activeFile} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }} className="absolute inset-0 flex flex-col min-h-0">
          <FilePreview
            sessionId={sessionId}
            fileName={activeFile}
            fragment={previewFrag?.sessionId === sessionId && previewFrag.path === activeFile ? previewFrag.frag : undefined}
            locationNonce={previewFrag?.sessionId === sessionId && previewFrag.path === activeFile ? previewFrag.n : undefined}
            mediaVersion={mediaVersionFor(activeFile)}
            content={fileByPath.get(activeFile) ?? ""}
            openFiles={mobile ? undefined : openedFiles}
            onSelectFile={(path) => { setActiveFile(path); setFileNavigatorOnly(false); loadFile(path); }}
            integratedPdfToolbar={!mobile}
            onClose={() => closeFileTab(activeFile)}
          />
        </m.div>
      ) : (
        <m.div key={`loading:${activeFile}`} data-testid="file-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="absolute inset-0 flex items-center justify-center">
          <output className="oiia-loader" aria-label={t('rs.loadingFile')}>{PRODUCT_NAME}</output>
        </m.div>
      )}
    </div>
  ) : (
    <div data-testid="file-workbench-empty" className="hidden min-w-0 flex-1 items-center justify-center px-6 text-center text-[12px] text-[#A0A49C] dark:text-[#666B64] md:flex">
      {t('rs.selectFile')}
    </div>
  );

  return (
    <LazyMotion features={domAnimation}>
    <m.div
      ref={panelRef}
      initial={mobile ? { opacity: 0 } : { width: 0, opacity: 0 }}
      animate={mobile ? { opacity: 1 } : { width, opacity: 1 }}
      exit={mobile ? { opacity: 0 } : { width: 0, opacity: 0 }}
      transition={mobile ? { duration: 0.16 } : { width: { duration: 0 }, opacity: { duration: 0.14 } }}
      className={`${mobile ? "w-full" : "shrink-0 max-w-[calc(100%-480px)]"} min-w-0 border-l border-[#E5E5E5] dark:border-[#333] h-full flex flex-col select-none font-sans bg-[var(--app-surface)] dark:bg-[#1A1A1A] overflow-hidden relative`}
    >
      {!mobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('rs.resizeHandle')}
          onMouseDown={handleDrag}
          className="absolute left-[-3px] top-0 bottom-0 w-2 cursor-col-resize z-20 bg-transparent"
        />
      )}
      <div style={mobile ? { width: "100%" } : { width, maxWidth: "100%" }} className={`h-full flex relative ${mobile ? "w-full flex-col" : "shrink-0 flex-row"}`}>
        {!mobile && (
          <nav
            data-testid="workspace-rail"
            aria-label={t('rs.workspace')}
            className="relative z-30 flex h-full w-10 shrink-0 flex-col items-center overflow-visible border-r border-[#ECEEE7] bg-[var(--app-surface)] py-2 dark:border-[#2C2E2B] dark:bg-[#1A1A1A]"
          >
            <div className="flex shrink-0 flex-col items-center gap-1">
              <WorkspaceRailButton icon={<FolderTree className="size-4" strokeWidth={1.65} />} label={t('rs.tabFileTree')} active={activeTab === 'files'} onClick={() => { setActiveTab('files'); setFileNavigatorOnly(true); }} />
              <WorkspaceRailButton icon={<GitCompareArrows className="size-4" strokeWidth={1.65} />} label={t('rs.tabChanges')} active={activeTab === 'changes'} onClick={() => setActiveTab('changes')} />
              <WorkspaceRailButton icon={<SquareTerminal className="size-4" strokeWidth={1.65} />} label={t('rs.tabTerminal')} active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
              <WorkspaceRailButton icon={<History className="size-4" strokeWidth={1.65} />} label={t('rs.tabShell')} active={activeTab === 'shell'} onClick={() => setActiveTab('shell')} />
              <WorkspaceRailButton icon={<Waypoints className="size-4" strokeWidth={1.65} />} label={t('rs.tabRun')} active={activeTab === 'run'} onClick={() => setActiveTab('run')} />
            </div>
            {(openTool || openCompaction) && (
              <div className="mt-2 flex shrink-0 flex-col items-center gap-1 border-t border-[#E5E8E0] pt-2 dark:border-[#30322F]">
                {openTool && (
                  <WorkspaceRailButton
                    icon={<Wrench className="size-4" strokeWidth={1.65} />}
                    label={t('rs.tabTool')}
                    active={activeTab === 'tool'}
                    onClick={() => setActiveTab('tool')}
                  />
                )}
                {openCompaction && (
                  <WorkspaceRailButton
                    icon={<DatabaseZap className="size-4" strokeWidth={1.65} />}
                    label={t('rs.tabCompaction')}
                    active={activeTab === 'compaction'}
                    onClick={() => setActiveTab('compaction')}
                  />
                )}
              </div>
            )}
          </nav>
        )}

        {mobile && <div className="flex items-center px-1.5 h-[44px] border-b border-[#F0F0F0] dark:border-[#333] shrink-0 w-full overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] bg-[var(--app-surface)] dark:bg-[#1A1A1A] gap-1">

          {openTool && (
            <TabItem
              icon={<Wrench className="size-[14px] stroke-[1.5]" />}
              label={t('rs.tabTool')}
              isActive={activeTab === 'tool'}
              onClick={() => setActiveTab('tool')}
              onClose={() => setActiveTab('files')}
            />
          )}

          {openCompaction && (
            <TabItem
              icon={<DatabaseZap className="size-[14px] stroke-[1.5]" />}
              label={t('rs.tabCompaction')}
              isActive={activeTab === 'compaction'}
              onClick={() => setActiveTab('compaction')}
              onClose={() => setActiveTab('files')}
            />
          )}
          <TabItem icon={<GitCompareArrows className="size-[14px]" strokeWidth={1.65} />} label={t('rs.tabChanges')} isActive={activeTab === 'changes'} onClick={() => setActiveTab('changes')} />
          <TabItem icon={<SquareTerminal className="size-[14px]" strokeWidth={1.65} />} label={t('rs.tabTerminal')} isActive={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
          <TabItem icon={<History className="size-[14px]" strokeWidth={1.65} />} label={t('rs.tabShell')} isActive={activeTab === 'shell'} onClick={() => setActiveTab('shell')} />
          <TabItem icon={<Waypoints className="size-[14px]" strokeWidth={1.65} />} label={t('rs.tabRun')} isActive={activeTab === 'run'} onClick={() => setActiveTab('run')} />
          <TabItem icon={<FolderTree className="size-[14px] text-[#666] dark:text-[#A0A0A0]" strokeWidth={1.65} />} label={t('rs.tabFileTree')} isActive={activeTab === 'files' && activeFile === null} onClick={() => { setActiveTab('files'); setActiveFile(null); }} />

          {openedFiles.map((file) => (
            <TabItem
              key={file}
              icon={getFileIcon(file)}
              label={file.split('/').pop() ?? file}
              isActive={activeTab === 'files' && activeFile === file}
              onClick={() => { setActiveTab('files'); setActiveFile(file); setFileNavigatorOnly(false); loadFile(file); }}
              onClose={() => closeFileTab(file)}
            />
          ))}
        </div>}

        <div className="min-w-0 h-full flex-1 overflow-hidden flex flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
          {activeTab === 'compaction' ? (
            openCompaction ? (
              <CompactionPane sessionId={sessionId} compactionId={openCompaction.id} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[#888] dark:text-[#888]">
                {t('rs.toolGone')}
              </div>
            )
          ) : activeTab === 'tool' ? (
            <div className="min-h-0 flex-1 overflow-hidden w-full">
              <AnimatePresence mode="wait" initial={false}>
                {activeTool ? (
                  <m.div
                    key={activeTool.id}
                    className="h-full min-h-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                  >
                    {activeTool.toolKind === 'canvas' ? (
                      <div className="h-full overflow-y-auto p-3">
                        <CanvasCard
                          canvasId={activeTool.id}
                          title={typeof (activeTool.arguments as Record<string, unknown> | undefined)?.title === 'string' ? String((activeTool.arguments as Record<string, unknown>).title) : ''}
                          html={typeof (activeTool.arguments as Record<string, unknown> | undefined)?.html === 'string' ? String((activeTool.arguments as Record<string, unknown>).html) : ''}
                          height={640}
                          theme={typeof (activeTool.arguments as Record<string, unknown> | undefined)?.theme === 'string' ? String((activeTool.arguments as Record<string, unknown>).theme) : undefined}
                          status={activeTool.status}
                        />
                      </div>
                    ) : (
                      <ToolDetail sessionId={sessionId} item={activeTool} onOpenFile={openFileInTab} />
                    )}
                  </m.div>
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[#888] dark:text-[#888]">
                    {t('rs.toolGone')}
                  </div>
                )}
              </AnimatePresence>
            </div>
          ) : activeTab === 'files' ? (
            mobile ? (
              activeFile ? filePreviewPane : fileBrowserPane
            ) : (
              <div data-testid="file-workbench" className="@container/workbench flex h-full min-w-0 flex-1 bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
                {fileBrowserPane}
                {filePreviewPane}
              </div>
            )
          ) : activeTab === 'terminal' ? (
            session ? (
              <div className="flex-1 min-h-0 w-full flex flex-col bg-[var(--app-surface)] dark:bg-[#1A1A1A]">

                <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[11px] text-[#8A8A8A] dark:text-[#999] shrink-0 min-w-0">
                  <StatusDot tone={PTY_STATE_DOT[termState].tone} pulse={PTY_STATE_DOT[termState].pulse} />
                  <span className="truncate font-medium text-[#666] dark:text-[#AAA]">{session.title || t('session.untitled')}</span>
                  <span className="shrink-0 text-[#C5C5C5] dark:text-[#555]">·</span>
                  <span className="shrink-0">{backendLabel(session.sandboxKind, t)}</span>
                  <span className="ml-auto shrink-0">{ptyStateLabel(termState, t)}</span>
                </div>
                <TerminalPanel session={session} compact onStateChange={setTermState} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[13px] text-[#999] dark:text-[#777]">{t('shell.noSession')}</div>
            )
          ) : activeTab === 'shell' ? (
            <div className="flex-1 w-full overflow-y-auto bg-[var(--app-surface)] dark:bg-[#1A1A1A] p-4 hide-scrollbar">
              <h3 className="text-[14px] font-medium text-[#333] dark:text-[#E0E0E0] mb-5">{t('rs.headingShell')}</h3>
              {shellItems.length === 0 ? (
                <div className="text-[13px] text-[#888] dark:text-[#888]">{t('rs.emptyShell')}</div>
              ) : (
                <div className="space-y-2">
                  {shellItems.map((item) => (
                    <div key={item.id} className="border-l-2 border-[#E5E5E5] dark:border-[#333] pl-3 py-1">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="text-[13px] text-[#555] dark:text-[#C0C0C0] leading-[1.6] break-all min-w-0" style={{ fontFamily: 'var(--font-code)' }}>
                          <span className="opacity-70 select-none mr-2 text-[#888] dark:text-[#777]">$</span>
                          {String((item.arguments as Record<string, unknown>).command ?? '')}
                        </div>
                        <StatusPill status={item.status} termination={item.termination} />
                      </div>
                      {item.resultText && (
                        <div className="text-[13px] text-[#888] dark:text-[#777] leading-[1.6] break-all mt-1 relative pl-4 whitespace-pre-wrap" style={{ fontFamily: 'var(--font-code)' }}>
                          <span className="absolute left-0 top-0 opacity-60 select-none">↳</span>
                          {item.resultText}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'changes' ? (
            <ChangesPane
              sessionId={sessionId}
              session={session}
              refreshKey={refreshKey}
              onRequestReview={onRequestReview ?? (() => {})}
              fallbackFiles={changeItems.map((i) => ({ path: i.path ?? i.name, kind: i.toolKind === 'write' ? 'write' : 'edit' }))}
            />

          ) : activeTab === 'run' ? (
            <React.Suspense fallback={<div className="h-full bg-[var(--app-surface)] dark:bg-[#1A1A1A]" />}>
              <RunInspector sessionId={sessionId} />
            </React.Suspense>

          ) : null}
        </div>
      </div>
    </m.div>
    </LazyMotion>
  );
}
