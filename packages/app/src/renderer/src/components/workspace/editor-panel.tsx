import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
import { folderName } from "@renderer/lib/utils";
import type {
  FileEntry,
  FileSnapshot,
  WorkspaceSnapshot,
} from "@shared/workspace-types";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileDiffIcon,
  FilesIcon,
  GitBranchIcon,
  PanelLeftIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SaveIcon,
  XIcon,
  RadioIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { toast } from "sonner";

import { FileIcon, FileIconDefinitions } from "./file-icon";

const MonacoSurface = lazy(() => import("./monaco-surface"));
interface Tab {
  file: FileSnapshot;
  value: string;
  conflict: boolean;
}
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const EXPLORER_WIDTH = "yukino.explorer-width";
const MIN_EXPLORER_WIDTH = 112;
const MAX_EXPLORER_WIDTH = 420;

interface Directory {
  children: FileEntry[] | null;
  loading: boolean;
}

function changeColor(status: string): string {
  if (status.includes("D")) {
    return "text-destructive";
  }
  if (status === "??" || status.includes("A")) {
    return "text-success";
  }
  return "text-warning";
}

function FileTree({
  entries,
  directories,
  active,
  onOpen,
  onToggle,
  depth = 0,
}: {
  entries: FileEntry[];
  directories: ReadonlyMap<string, Directory>;
  active: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  depth?: number;
}): React.JSX.Element {
  return (
    <ul>
      {entries.map((entry) => {
        const directory = directories.get(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              className="file-row"
              style={{ paddingInlineStart: 7 + depth * 12 }}
              title={entry.path}
              aria-current={active === entry.path ? "true" : undefined}
              aria-expanded={entry.directory ? Boolean(directory) : undefined}
              onClick={() => {
                if (entry.directory) {
                  onToggle(entry.path);
                } else {
                  onOpen(entry.path);
                }
              }}
            >
              <span className="text-muted-foreground grid size-3 shrink-0 place-items-center [&>svg]:size-3">
                {directory?.loading ? (
                  <Spinner />
                ) : entry.directory ? (
                  directory ? (
                    <ChevronDownIcon />
                  ) : (
                    <ChevronRightIcon />
                  )
                ) : null}
              </span>
              <FileIcon
                path={entry.name}
                directory={entry.directory}
                expanded={Boolean(directory)}
              />
              <span className="truncate">{entry.name}</span>
            </button>
            {directory?.children ? (
              <FileTree
                entries={directory.children}
                directories={directories}
                active={active}
                onOpen={onOpen}
                onToggle={onToggle}
                depth={depth + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function EditorPanel({
  cwd,
  dark,
  expanded,
  canExpand,
  onExpand,
  onClose,
  onDirtyChange,
}: {
  cwd: string;
  dark: boolean;
  expanded: boolean;
  canExpand: boolean;
  onExpand: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [directories, setDirectories] = useState(
    () => new Map<string, Directory>(),
  );
  const directoryRequests = useRef(new Map<string, symbol>());
  const fileGroup = useRef<HTMLDivElement>(null);
  const fileDivider = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const [explorerWidth] = useState(() => {
    const stored = Number(localStorage.getItem(EXPLORER_WIDTH));
    return stored >= MIN_EXPLORER_WIDTH && stored <= MAX_EXPLORER_WIDTH
      ? stored
      : 184;
  });
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [follow, setFollow] = useState(true);
  const [view, setView] = useState<"files" | "changes">("changes");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const saveRequest = useRef<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const request = useRef(0);
  const alive = useRef(true);
  const refreshRequest = useRef(0);

  const readDirectory = useCallback(async (path: string, opening = false) => {
    const token = Symbol(path);
    directoryRequests.current.set(path, token);
    try {
      const children = await window.api.workspaceList(path);
      if (alive.current && directoryRequests.current.get(path) === token) {
        setDirectories((current) => {
          if (!current.has(path)) {
            return current;
          }
          return new Map(current).set(path, { children, loading: false });
        });
      }
    } catch (cause) {
      if (
        !alive.current ||
        directoryRequests.current.get(path) !== token ||
        !opening
      ) {
        return;
      }
      setDirectories((current) => {
        const next = new Map(current);
        next.delete(path);
        return next;
      });
      toast.error(errorText(cause));
    } finally {
      if (directoryRequests.current.get(path) === token) {
        directoryRequests.current.delete(path);
      }
    }
  }, []);

  const toggleDirectory = (path: string): void => {
    if (directories.has(path)) {
      directoryRequests.current.delete(path);
      setDirectories((current) => {
        const next = new Map(current);
        next.delete(path);
        return next;
      });
    } else {
      setDirectories((current) =>
        new Map(current).set(path, { children: null, loading: true }),
      );
      void readDirectory(path, true);
    }
  };
  const directoriesRef = useRef(directories);
  useEffect(() => {
    directoriesRef.current = directories;
  }, [directories]);

  const refresh = useCallback(async () => {
    const token = ++refreshRequest.current;
    for (const [path, directory] of directoriesRef.current) {
      if (!directory.loading) {
        void readDirectory(path);
      }
    }
    try {
      const [files, state] = await Promise.all([
        window.api.workspaceList(),
        window.api.workspaceSnapshot(),
      ]);
      if (!alive.current || token !== refreshRequest.current) {
        return;
      }
      setEntries(files);
      setSnapshot(state);
      setError(null);
    } catch (cause) {
      if (alive.current && token === refreshRequest.current) {
        setError(errorText(cause));
      }
    }
  }, [readDirectory]);

  const open = useCallback(async (path: string) => {
    const token = ++request.current;
    if (tabsRef.current.some((tab) => tab.file.path === path)) {
      setLoading(false);
      setError(null);
      setActive(path);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const file = await window.api.workspaceRead(path);
      if (token !== request.current || !alive.current) {
        return;
      }
      setTabs((current) =>
        current.some((tab) => tab.file.path === file.path)
          ? current
          : [...current, { file, value: file.content, conflict: false }],
      );
      setActive(file.path);
    } catch (cause) {
      if (token === request.current) {
        setError(errorText(cause));
      }
    } finally {
      if (token === request.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(refresh);
    const off = window.api.onEvent((event) => {
      if (event.type !== "workspace_changed" || event.data.cwd !== cwd) {
        return;
      }
      void refresh();
      for (const tab of tabsRef.current) {
        void window.api
          .workspaceRead(tab.file.path)
          .then((file) => {
            if (!alive.current) {
              return;
            }
            setTabs((current) =>
              current.map((item) => {
                if (
                  item.file.path !== file.path ||
                  item.file.revision !== tab.file.revision ||
                  item.file.revision === file.revision
                ) {
                  return item;
                }
                const dirty = item.value !== item.file.content;
                return dirty
                  ? { ...item, conflict: true }
                  : { file, value: file.content, conflict: false };
              }),
            );
          })
          .catch(() => {
            if (alive.current) {
              setTabs((current) =>
                current.map((item) =>
                  item.file.path === tab.file.path
                    ? { ...item, conflict: true }
                    : item,
                ),
              );
            }
          });
      }
    });
    return () => {
      alive.current = false;
      request.current++;
      refreshRequest.current++;
      off();
    };
  }, [cwd, refresh]);

  useEffect(() => {
    if (!follow || tabs.some((tab) => tab.value !== tab.file.content)) {
      return;
    }
    const off = window.api.onEvent((event) => {
      if (
        event.type === "tool_use" &&
        ["EditFile", "WriteFile", "ReadFile"].includes(event.data.toolName)
      ) {
        const path = event.data.args.file_path ?? event.data.args.notebook_path;
        if (typeof path === "string") {
          const relative = path.startsWith(`${cwd}/`)
            ? path.slice(cwd.length + 1)
            : path;
          if (!relative.startsWith("/")) {
            void open(relative);
          }
        }
      }
      if (
        event.type === "workspace_changed" &&
        event.data.cwd === cwd &&
        event.data.path &&
        tabsRef.current.length === 0
      ) {
        void open(event.data.path);
      }
    });
    return off;
  }, [follow, tabs, cwd, open]);

  const dirty = tabs.some((tab) => tab.value !== tab.file.content);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const tab = tabs.find((item) => item.file.path === active);
  useEffect(() => {
    tabList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);
  const save = useCallback(async () => {
    const current = tabsRef.current.find((item) => item.file.path === active);
    if (
      !current ||
      current.value === current.file.content ||
      current.conflict ||
      current.file.deleted ||
      saveRequest.current
    ) {
      return;
    }
    saveRequest.current = current.file.path;
    setSaving(current.file.path);
    try {
      const file = await window.api.workspaceSave(
        current.file.path,
        current.value,
        current.file.revision,
      );
      setTabs((items) =>
        items.map((item) =>
          item.file.path === file.path
            ? { ...item, file, conflict: false }
            : item,
        ),
      );
      toast.success("File saved");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      saveRequest.current = null;
      setSaving(null);
    }
  }, [active]);

  const closeTab = (path: string): void => {
    if (saveRequest.current === path) {
      return;
    }
    setTabs((current) => current.filter((item) => item.file.path !== path));
    if (active === path) {
      const index = tabs.findIndex((item) => item.file.path === path);
      setActive((tabs[index + 1] ?? tabs[index - 1])?.file.path ?? null);
    }
    setClosing(null);
  };

  const openFromExplorer = (path: string): void => {
    setFollow(false);
    void open(path);
  };

  const crumbs = tab?.file.path.split("/") ?? [];
  const name = folderName(cwd);

  return (
    <section
      className="editor-workspace flex h-full min-w-0 flex-col"
      aria-label="Files"
    >
      <FileIconDefinitions />
      <div className="editor-heading">
        <FilesIcon className="text-accent-foreground size-4 shrink-0" />
        <h2 className="text-xs font-semibold">Files</h2>
        <div className="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Refresh files"
            aria-label="Refresh files"
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCwIcon />
          </Button>
          {canExpand ? (
            <Button
              variant="ghost"
              size="icon-sm"
              title={expanded ? "Restore split" : "Expand editor"}
              aria-label={expanded ? "Restore split" : "Expand editor"}
              onClick={onExpand}
            >
              {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Close workspace (keep drafts)"
            aria-label="Close workspace"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <Group
        className="min-h-0 flex-1"
        orientation="horizontal"
        elementRef={fileGroup}
        onLayoutChanged={(layout, meta) => {
          if (
            !meta.isUserInteraction ||
            !fileGroup.current ||
            !fileDivider.current
          ) {
            return;
          }
          const available =
            fileGroup.current.clientWidth - fileDivider.current.offsetWidth;
          const width = (available * layout["file-explorer"]) / 100;
          localStorage.setItem(EXPLORER_WIDTH, String(Math.round(width)));
        }}
      >
        <Panel
          id="file-explorer"
          className="min-w-0"
          defaultSize={explorerWidth}
          minSize={MIN_EXPLORER_WIDTH}
          maxSize={MAX_EXPLORER_WIDTH}
          groupResizeBehavior="preserve-pixel-size"
        >
          <nav
            className="file-explorer @container/explorer"
            aria-label="Project files"
          >
            <div className="explorer-project" title={cwd}>
              <FileIcon path={name} root />
              <span className="truncate">{name}</span>
            </div>
            <div
              className="explorer-views"
              aria-label="File views"
              role="group"
            >
              <button
                type="button"
                aria-pressed={view === "changes"}
                onClick={() => {
                  setView("changes");
                }}
              >
                Changes
                {snapshot?.changes.length ? (
                  <span className="tabular-nums">
                    {snapshot.changes.length}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-pressed={view === "files"}
                onClick={() => {
                  setView("files");
                }}
              >
                Files
              </button>
            </div>
            <div className="file-list">
              {view === "files" ? (
                entries.length ? (
                  <FileTree
                    entries={entries}
                    directories={directories}
                    active={active}
                    onOpen={openFromExplorer}
                    onToggle={toggleDirectory}
                  />
                ) : (
                  <p className="explorer-empty">No files</p>
                )
              ) : snapshot?.changes.length ? (
                <ul>
                  {snapshot.changes.map((change) => (
                    <li key={change.path}>
                      <button
                        type="button"
                        className="file-row"
                        title={change.path}
                        aria-current={
                          active === change.path ? "true" : undefined
                        }
                        onClick={() => {
                          openFromExplorer(change.path);
                        }}
                      >
                        <FileIcon path={change.path} />
                        <span className="truncate">
                          {folderName(change.path)}
                        </span>
                        <span
                          className={`ml-auto shrink-0 font-mono text-[10px] font-semibold ${changeColor(change.status)}`}
                        >
                          {change.status}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="explorer-empty">No changes</p>
              )}
            </div>
            <div className="explorer-footer">
              {snapshot?.branch ? (
                <span
                  className="flex min-w-0 items-center gap-1.5"
                  title={snapshot.branch}
                >
                  <GitBranchIcon className="size-3 shrink-0" />
                  <span className="truncate">{snapshot.branch}</span>
                </span>
              ) : null}
              <button
                type="button"
                className="explorer-follow"
                onClick={() => {
                  setFollow((current) => !current);
                }}
                aria-pressed={follow}
                title="Follow agent changes"
                aria-label="Follow agent changes"
              >
                <RadioIcon className="size-3.5 shrink-0" />
                <span className="hidden @min-[155px]/explorer:inline">
                  {follow ? "Following agent" : "Follow agent"}
                </span>
              </button>
            </div>
          </nav>
        </Panel>
        <Separator
          elementRef={fileDivider}
          aria-label="Resize file explorer"
          className="workspace-divider"
        />
        <Panel
          id="file-editor"
          minSize={178}
          className="@container/editor flex min-w-0 flex-col overflow-hidden"
        >
          {tabs.length ? (
            <div
              ref={tabList}
              className="editor-tabs"
              role="tablist"
              aria-label="Open files"
            >
              {tabs.map((item) => (
                <div
                  className="editor-tab"
                  data-active={active === item.file.path}
                  key={item.file.path}
                >
                  <button
                    type="button"
                    className="editor-tab-label"
                    role="tab"
                    aria-selected={active === item.file.path}
                    onClick={() => {
                      void open(item.file.path);
                    }}
                    title={item.file.path}
                  >
                    <FileIcon path={item.file.path} />
                    <span className="truncate">
                      {folderName(item.file.path)}
                    </span>
                    {item.value !== item.file.content ? (
                      <span
                        className="bg-primary size-1.5 shrink-0 rounded-full"
                        role="img"
                        aria-label="Unsaved changes"
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="editor-tab-close"
                    aria-label={`Close ${item.file.path}`}
                    title={`Close ${item.file.path}`}
                    disabled={saving === item.file.path}
                    onClick={() => {
                      if (item.value !== item.file.content) {
                        setClosing(item.file.path);
                      } else {
                        closeTab(item.file.path);
                      }
                    }}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {tab ? (
            <div className="editor-actions">
              <ol
                className="editor-path"
                aria-label="File path"
                title={tab.file.path}
              >
                {crumbs.map((part, index) => (
                  <li
                    key={index}
                    className="last:text-foreground flex min-w-0 items-center gap-1"
                  >
                    {index > 0 ? (
                      <ChevronRightIcon className="size-3 shrink-0" />
                    ) : null}
                    <span className="truncate">{part}</span>
                  </li>
                ))}
              </ol>
              <Button
                variant={diff ? "secondary" : "ghost"}
                size="sm"
                onClick={() => {
                  setDiff((value) => !value);
                }}
                aria-pressed={diff}
                aria-label="Compare changes"
                title="Compare changes"
              >
                <FileDiffIcon />
                <span className="@max-[340px]/editor:hidden">Compare</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Save"
                title="Save (Ctrl or ⌘ S)"
                disabled={
                  Boolean(saving) ||
                  tab.value === tab.file.content ||
                  tab.conflict ||
                  tab.file.deleted
                }
                onClick={() => {
                  void save();
                }}
              >
                <SaveIcon />
                <span className="@max-[340px]/editor:hidden">
                  {saving === tab.file.path ? "Saving" : "Save"}
                </span>
              </Button>
            </div>
          ) : null}
          {tab?.conflict ? (
            <div
              role="alert"
              className="text-warning bg-[color-mix(in_srgb,var(--warning)_9%,var(--card))] px-3 py-2.5 text-[11px] leading-[1.8] [&_button]:ml-2 [&_button]:underline"
            >
              The file changed and your draft was preserved.
              <button
                onClick={() => {
                  void window.api
                    .workspaceRead(tab.file.path)
                    .then((file) => {
                      setTabs((items) =>
                        items.map((item) =>
                          item.file.path === file.path
                            ? {
                                ...item,
                                file: { ...file, baseline: file.content },
                                conflict: false,
                              }
                            : item,
                        ),
                      );
                      setDiff(true);
                    })
                    .catch((cause: unknown) => toast.error(errorText(cause)));
                }}
              >
                Compare with disk
              </button>
              <button
                onClick={() => {
                  void window.api
                    .workspaceRead(tab.file.path)
                    .then((file) => {
                      setTabs((items) =>
                        items.map((item) =>
                          item.file.path === file.path
                            ? { file, value: file.content, conflict: false }
                            : item,
                        ),
                      );
                    })
                    .catch((cause: unknown) => toast.error(errorText(cause)));
                }}
              >
                Discard draft
              </button>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-destructive px-4 py-3 text-xs">
              {error}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1">
            {tab ? (
              <Suspense
                fallback={
                  <div className="editor-empty text-xs" role="status">
                    <Spinner aria-hidden="true" />
                    Loading editor…
                  </div>
                }
              >
                <MonacoSurface
                  path={tab.file.path}
                  openPaths={tabs.map((item) => item.file.path)}
                  readOnly={tab.file.deleted}
                  value={tab.value}
                  baseline={tab.conflict ? tab.file.content : tab.file.baseline}
                  diff={diff}
                  dark={dark}
                  onChange={(path, value) => {
                    setTabs((items) =>
                      items.map((item) =>
                        item.file.path === path ? { ...item, value } : item,
                      ),
                    );
                  }}
                  onSave={() => {
                    void save();
                  }}
                />
              </Suspense>
            ) : (
              <div className="editor-empty">
                <span className="editor-empty-icon" aria-hidden="true">
                  <FileCode2Icon className="size-6" />
                </span>
                <p className="text-sm font-medium">No file open</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-accent-foreground"
                  onClick={() => {
                    setView("files");
                  }}
                >
                  <PanelLeftIcon /> Browse files
                </Button>
              </div>
            )}
            {loading ? (
              <div
                className="bg-card text-muted-foreground absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                role="status"
              >
                <Spinner aria-hidden="true" /> Opening file…
              </div>
            ) : null}
          </div>
        </Panel>
      </Group>
      <Dialog
        open={closing !== null}
        onOpenChange={(value) => {
          if (!value) {
            setClosing(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Close unsaved file?</DialogTitle>
          <DialogDescription>
            The draft has not been written to disk. Closing will discard these
            changes.
          </DialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setClosing(null);
              }}
            >
              Keep draft
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (closing) {
                  closeTab(closing);
                }
              }}
            >
              Discard and close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
