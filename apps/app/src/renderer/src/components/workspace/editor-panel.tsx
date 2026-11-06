import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
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
  FolderIcon,
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
import { toast } from "sonner";

const MonacoSurface = lazy(() => import("./monaco-surface"));
interface Tab {
  file: FileSnapshot;
  value: string;
  conflict: boolean;
}
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function Tree({
  entries,
  active,
  onOpen,
  depth = 0,
}: {
  entries: FileEntry[];
  active: string | null;
  onOpen: (path: string) => void;
  depth?: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  useEffect(
    () =>
      window.api.onEvent((event) => {
        if (event.type !== "workspace_changed") {
          return;
        }
        for (const path of Object.keys(expanded)) {
          void window.api
            .workspaceList(path)
            .then((children) => {
              setExpanded((current) =>
                current[path] ? { ...current, [path]: children } : current,
              );
            })
            .catch(() => undefined);
        }
      }),
    [expanded],
  );
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            type="button"
            className={`flex min-h-7 w-full items-center gap-[5px] px-2.5 py-1 text-left text-[11px] [&>svg]:size-[13px] [&>svg]:shrink-0 ${active === entry.path ? "bg-accent text-accent-foreground hover:bg-accent" : "hover:bg-muted"}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            title={entry.path}
            onClick={() => {
              if (!entry.directory) {
                onOpen(entry.path);
                return;
              }
              if (expanded[entry.path]) {
                setExpanded((current) => {
                  return Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => key !== entry.path,
                    ),
                  );
                });
                return;
              }
              setLoading(entry.path);
              void window.api
                .workspaceList(entry.path)
                .then((children) => {
                  setExpanded((current) => ({
                    ...current,
                    [entry.path]: children,
                  }));
                })
                .catch((error: unknown) => toast.error(errorText(error)))
                .finally(() => {
                  setLoading(null);
                });
            }}
          >
            {loading === entry.path ? (
              <Spinner className="size-3" />
            ) : entry.directory ? (
              expanded[entry.path] ? (
                <ChevronDownIcon />
              ) : (
                <ChevronRightIcon />
              )
            ) : (
              <span className="w-3" />
            )}
            {entry.directory ? (
              <FolderIcon className="text-primary/70" />
            ) : (
              <FileCode2Icon className="text-muted-foreground" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {expanded[entry.path] ? (
            <Tree
              entries={expanded[entry.path]}
              active={active}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

export function EditorPanel({
  cwd,
  dark,
  expanded,
  onExpand,
  onClose,
  onDirtyChange,
}: {
  cwd: string;
  dark: boolean;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [entries, setEntries] = useState<FileEntry[]>([]);
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
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const request = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [files, state] = await Promise.all([
        window.api.workspaceList(),
        window.api.workspaceSnapshot(),
      ]);
      if (!alive.current) {
        return;
      }
      setEntries(files);
      setSnapshot(state);
      setError(null);
    } catch (cause) {
      if (alive.current) {
        setError(errorText(cause));
      }
    }
  }, []);

  const open = useCallback(async (path: string) => {
    const token = ++request.current;
    if (tabsRef.current.some((tab) => tab.file.path === path)) {
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
        ["Edit", "Write", "Read", "NotebookEdit"].includes(event.data.toolName)
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
  const save = useCallback(async () => {
    const current = tabsRef.current.find((item) => item.file.path === active);
    if (!current || current.value === current.file.content || saving) {
      return;
    }
    setSaving(true);
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
      toast.success("文件已保存");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  }, [active, saving]);

  const closeTab = (path: string): void => {
    setTabs((current) => current.filter((item) => item.file.path !== path));
    if (active === path) {
      setActive(
        tabs.find((item) => item.file.path !== path)?.file.path ?? null,
      );
    }
    setClosing(null);
  };

  return (
    <section
      className="bg-card flex h-full min-w-0 flex-col [&_::-webkit-scrollbar]:h-1.5 [&_::-webkit-scrollbar]:w-1.5 [&_::-webkit-scrollbar-thumb]:rounded-[6px] [&_::-webkit-scrollbar-thumb]:border [&_::-webkit-scrollbar-thumb]:border-transparent"
      aria-label="文件"
    >
      <div className="border-border flex h-11 shrink-0 items-center gap-[7px] border-b pr-2.5 pl-3.5">
        <FilesIcon className="text-accent-foreground size-4" />
        <strong className="text-[11px] font-[550]">文件</strong>
        <div className="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新文件"
            aria-label="刷新文件"
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={expanded ? "恢复分栏" : "展开编辑器"}
            aria-label={expanded ? "恢复分栏" : "展开编辑器"}
            onClick={onExpand}
          >
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="关闭工作区（保留草稿）"
            aria-label="关闭工作区"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          className="border-border flex w-40 min-w-[120px] shrink-0 flex-col border-r bg-[color-mix(in_srgb,var(--sidebar)_45%,var(--card))] max-[1200px]:w-[125px] max-[1000px]:w-[110px] max-[1000px]:min-w-[100px]"
          aria-label="项目文件"
        >
          <div className="border-border flex h-9 items-stretch gap-2.5 border-b px-2 text-[11px]">
            <button
              className={`border-b-2 ${
                view === "changes"
                  ? "border-b-accent-foreground text-foreground"
                  : "text-muted-foreground border-b-transparent"
              }`}
              onClick={() => {
                setView("changes");
              }}
            >
              变更{" "}
              <span className="text-muted-foreground ml-0.5 text-[9px]">
                {snapshot?.changes.length ?? 0}
              </span>
            </button>
            <button
              className={`border-b-2 ${
                view === "files"
                  ? "border-b-accent-foreground text-foreground"
                  : "text-muted-foreground border-b-transparent"
              }`}
              onClick={() => {
                setView("files");
              }}
            >
              文件
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {view === "files" ? (
              <Tree
                entries={entries}
                active={active}
                onOpen={(path) => {
                  setFollow(false);
                  void open(path);
                }}
              />
            ) : snapshot?.changes.length ? (
              snapshot.changes.map((change) => (
                <button
                  key={change.path}
                  className={`flex min-h-7 w-full items-center gap-[5px] px-2.5 py-1 text-left text-[11px] [&>svg]:size-[13px] [&>svg]:shrink-0 ${active === change.path ? "bg-accent text-accent-foreground hover:bg-accent" : "hover:bg-muted"}`}
                  title={change.path}
                  onClick={() => {
                    setFollow(false);
                    void open(change.path);
                  }}
                >
                  <FileDiffIcon />
                  <span className="truncate">
                    {change.path.split("/").pop()}
                  </span>
                  <span className="text-success ml-auto text-[10px]">
                    {change.status}
                  </span>
                </button>
              ))
            ) : (
              <p className="text-muted-foreground px-3 py-6 text-xs leading-6">
                暂无变更
              </p>
            )}
          </div>
          <button
            className={`border-border flex h-[31px] shrink-0 items-center gap-[5px] border-t px-2.5 text-[10px] ${
              follow ? "text-accent-foreground" : "text-muted-foreground"
            }`}
            onClick={() => {
              setFollow((current) => !current);
            }}
            aria-pressed={follow}
          >
            <RadioIcon className="size-3.5" />
            {follow ? "跟随 Agent" : "已暂停跟随"}
          </button>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className="border-border bg-muted flex h-9 min-h-9 overflow-x-auto border-b"
            role="tablist"
            aria-label="已打开文件"
          >
            {tabs.map((item) => (
              <div
                className={`border-border flex items-center border-t-2 border-r ${
                  active === item.file.path
                    ? "border-t-accent-foreground bg-card text-foreground"
                    : "text-muted-foreground border-t-transparent"
                }`}
                key={item.file.path}
              >
                <button
                  className="flex h-full max-w-[180px] items-center gap-1.5 px-[7px] pl-[11px] text-[11px] whitespace-nowrap"
                  role="tab"
                  aria-selected={active === item.file.path}
                  onClick={() => {
                    setActive(item.file.path);
                  }}
                  title={item.file.path}
                >
                  <FileCode2Icon className="size-3.5" />
                  {item.file.path.split("/").pop()}
                  {item.value !== item.file.content ? (
                    <span className="bg-primary size-1.5 rounded-full" />
                  ) : null}
                </button>
                <button
                  className="hover:bg-accent mr-[3px] rounded p-[5px]"
                  aria-label={`关闭 ${item.file.path}`}
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
          {tab ? (
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3 text-xs">
              <span
                title={tab.file.path}
                className="text-muted-foreground min-w-0 flex-1 truncate"
              >
                {tab.file.path}
              </span>
              <button
                className={`hover:text-accent-foreground inline-flex items-center justify-center gap-[5px] p-1 px-0.5 text-[11px] ${diff ? "text-accent-foreground" : ""}`}
                onClick={() => {
                  setDiff((value) => !value);
                }}
                aria-pressed={diff}
              >
                <FileDiffIcon className="size-3.5" />
                变更对比
              </button>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  saving ||
                  tab.value === tab.file.content ||
                  tab.conflict ||
                  tab.file.deleted
                }
                onClick={() => {
                  void save();
                }}
              >
                <SaveIcon />
                {saving ? "保存中" : "保存"}
              </Button>
            </div>
          ) : null}
          {tab?.conflict ? (
            <div
              role="alert"
              className="text-warning bg-[color-mix(in_srgb,var(--warning)_9%,var(--card))] px-3 py-2.5 text-[11px] leading-[1.8] [&_button]:ml-2 [&_button]:underline"
            >
              文件已变更，草稿已保留。
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
                对比磁盘
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
                放弃草稿
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
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-xs">
                    <Spinner />
                    正在加载编辑器…
                  </div>
                }
              >
                <MonacoSurface
                  path={tab.file.path}
                  readOnly={tab.file.deleted}
                  value={tab.value}
                  baseline={tab.conflict ? tab.file.content : tab.file.baseline}
                  diff={diff}
                  dark={dark}
                  onChange={(value) => {
                    setTabs((items) =>
                      items.map((item) =>
                        item.file.path === active ? { ...item, value } : item,
                      ),
                    );
                  }}
                  onSave={() => {
                    void save();
                  }}
                />
              </Suspense>
            ) : (
              <div className="[&_p]:text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-xs [&_p]:text-[11px] [&_p]:leading-[1.9] [&>strong]:text-sm [&>strong]:font-[550]">
                <div className="border-border bg-muted text-accent-foreground mb-1.5 grid h-[58px] w-[49px] rotate-[-5deg] place-items-center rounded-[10px] border [&_svg]:size-6">
                  <FileCode2Icon />
                </div>
                <button
                  className="text-accent-foreground hover:text-accent-foreground inline-flex items-center justify-center gap-[5px] p-1 px-0.5 text-[11px]"
                  onClick={() => {
                    setView("files");
                  }}
                >
                  打开文件 <ChevronRightIcon className="size-3.5" />
                </button>
              </div>
            )}
            {loading ? (
              <div className="bg-card absolute top-3 right-3 rounded p-2">
                <Spinner />
              </div>
            ) : null}
          </div>
          <div className="border-border text-muted-foreground flex border-t px-3 py-1.5 text-[10px]">
            <span>{snapshot?.branch ?? "本地项目"}</span>
            <span className="ml-auto">
              {tab
                ? `${tab.value.split("\n").length} 行 · UTF-8`
                : "Monaco Editor"}
            </span>
          </div>
        </div>
      </div>
      <Dialog
        open={closing !== null}
        onOpenChange={(value) => {
          if (!value) {
            setClosing(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>关闭未保存的文件？</DialogTitle>
          <DialogDescription>
            草稿尚未写入磁盘，关闭后将丢失这些修改。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setClosing(null);
              }}
            >
              保留草稿
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (closing) {
                  closeTab(closing);
                }
              }}
            >
              放弃并关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
