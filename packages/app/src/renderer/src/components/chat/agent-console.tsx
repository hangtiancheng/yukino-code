import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";
import type { AgentControl, AgentState } from "@shared/agent-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MCPServerConfig, Money } from "@yukino.js/yukino";
import {
  DownloadIcon,
  GitBranchIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="bg-background/60 space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function formatAmount(amount: Money | null): string {
  return amount?.currency && amount.amount !== null
    ? `${amount.currency} ${amount.amount.toPrecision(4)}`
    : "Unknown";
}

export function AgentConsole({
  page,
  streaming,
  dirty,
}: {
  page: "session" | "controls" | "mcp";
  streaming: boolean;
  dirty: boolean;
}): React.JSX.Element {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ["agent-state"],
    queryFn: () => window.api.getAgentState(),
    refetchInterval: 1500,
  });
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState(false);
  const [summaryFocus, setSummaryFocus] = useState("");
  const [compactionFocus, setCompactionFocus] = useState("");
  const [format, setFormat] = useState<"jsonl" | "html">("jsonl");
  const [scope, setScope] = useState<"active" | "tree">("tree");
  const [redact, setRedact] = useState(true);
  const [serverName, setServerName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [address, setAddress] = useState("");
  const [uri, setUri] = useState("");
  const [resourceServer, setResourceServer] = useState("");
  const [result, setResult] = useState<unknown>();
  const [resourcePage, setResourcePage] = useState<{
    server: string;
    templates?: boolean;
  } | null>(null);
  const [advanced, setAdvanced] = useState("");
  const mutation = useMutation({
    mutationFn: (action: AgentControl) => window.api.controlAgent(action),
    onSuccess: (value, action) => {
      if (action.type === "mcp_resources" || action.type === "mcp_read") {
        setResult(value);
        setResourcePage(
          action.type === "mcp_resources"
            ? { server: action.server, templates: action.templates }
            : null,
        );
      }
      void client.invalidateQueries({ queryKey: ["agent-state"] });
      void client.invalidateQueries({ queryKey: ["runtime"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const transfer = useMutation({
    mutationFn: (action: "import" | "export" | "diagnostics") =>
      window.api.transferSession(action, { format, scope, redact }),
    onSuccess: (saved) => {
      if (saved) {
        toast.success("Session transfer completed");
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = mutation.isPending || transfer.isPending;
  const idleOnly = busy || streaming || Boolean(state.data?.busy);
  const act = (action: AgentControl): void => {
    mutation.mutate(action);
  };
  if (state.error) {
    return (
      <p role="alert" className="text-destructive">
        {state.error.message}
      </p>
    );
  }
  const data = state.data;
  if (!data) {
    return (
      <p className="text-muted-foreground text-xs">Loading agent controls…</p>
    );
  }
  const queue = data.queue;
  const branchSummary = summary && (summaryFocus.trim() || true);
  return (
    <div className="space-y-5 text-xs">
      {page === "session" ? (
        <>
          <Section title="Session details">
            <p className="text-muted-foreground font-mono break-all">
              {data.sessionId}
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Session name"
                placeholder={data.metadata.name || "Session name"}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Button
                size="sm"
                disabled={idleOnly || !name.trim()}
                onClick={() => {
                  act({
                    type: "metadata",
                    metadata: { ...data.metadata, name: name.trim() },
                  });
                }}
              >
                Rename
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="Session tags"
                placeholder={
                  data.metadata.tags?.join(", ") || "Tags, separated by commas"
                }
                value={tags}
                onChange={(event) => {
                  setTags(event.target.value);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly}
                onClick={() => {
                  act({
                    type: "metadata",
                    metadata: {
                      ...data.metadata,
                      tags: tags
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  });
                }}
              >
                Save tags
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly || dirty}
                onClick={() => {
                  act({ type: "clone" });
                }}
              >
                <GitBranchIcon /> Clone session
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={idleOnly}
                onClick={() => {
                  act({
                    type: "metadata",
                    metadata: {
                      ...data.metadata,
                      archived: !data.metadata.archived,
                    },
                  });
                }}
              >
                {data.metadata.archived ? "Unarchive" : "Archive"}
              </Button>
            </div>
          </Section>
          <Section title="Import & export">
            <div className="grid grid-cols-2 gap-2">
              <ChoiceSelect
                label="Export format"
                value={format}
                onValueChange={setFormat}
                options={[
                  { value: "jsonl", label: "JSONL · portable session" },
                  { value: "html", label: "HTML · readable transcript" },
                ]}
              />
              <ChoiceSelect
                label="Export scope"
                value={scope}
                onValueChange={setScope}
                options={[
                  { value: "tree", label: "All branches" },
                  { value: "active", label: "Active branch" },
                ]}
              />
            </div>
            <label className="flex items-center justify-between gap-2">
              Redact sensitive content
              <Switch checked={redact} onCheckedChange={setRedact} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={idleOnly}
                onClick={() => {
                  transfer.mutate("export");
                }}
              >
                <DownloadIcon /> Export
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly || dirty}
                onClick={() => {
                  transfer.mutate("import");
                }}
              >
                <UploadIcon /> Import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={idleOnly}
                onClick={() => {
                  transfer.mutate("diagnostics");
                }}
              >
                Save diagnostics
              </Button>
            </div>
          </Section>
          <Section title="Conversation branches">
            {dirty ? (
              <p className="text-warning">
                Save editor drafts before changing branches.
              </p>
            ) : null}
            <label className="flex items-center justify-between gap-3">
              Summarize the branch being left
              <Switch checked={summary} onCheckedChange={setSummary} />
            </label>
            {summary ? (
              <Input
                aria-label="Branch summary focus"
                placeholder="What should the summary preserve? (optional)"
                value={summaryFocus}
                onChange={(event) => {
                  setSummaryFocus(event.target.value);
                }}
              />
            ) : null}
            <Input
              aria-label="Entry label"
              placeholder="Optional label for a conversation entry"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={idleOnly || dirty}
              onClick={() => {
                act({
                  type: "navigate",
                  entryId: null,
                  summary: branchSummary,
                });
              }}
            >
              Return to start
            </Button>
            <div className="space-y-2">
              {data.entries
                .filter((entry) => entry.text || entry.label)
                .map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-lg border p-3 ${entry.active ? "border-primary/30 bg-accent/30" : "bg-muted/40"}`}
                  >
                    <p className="mb-1 flex items-center gap-2 font-medium">
                      <GitBranchIcon className="size-3" />
                      {entry.role}
                      {entry.active ? (
                        <span className="text-primary">Active branch</span>
                      ) : null}
                      {entry.label ? (
                        <span className="bg-secondary rounded px-1.5 py-0.5">
                          {entry.label}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground mb-2 line-clamp-3 whitespace-pre-wrap">
                      {entry.text}
                    </p>
                    <p
                      className="text-muted-foreground mb-2 truncate font-mono text-[10px]"
                      title={entry.parentId ?? "Root"}
                    >
                      {entry.id} ← {entry.parentId ?? "Root"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={idleOnly || dirty}
                        onClick={() => {
                          act({
                            type: "navigate",
                            entryId: entry.id,
                            summary: branchSummary,
                          });
                        }}
                      >
                        Navigate
                      </Button>
                      {entry.role === "user" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={idleOnly || dirty}
                          onClick={() => {
                            act({ type: "fork", entryId: entry.id });
                          }}
                        >
                          Fork here
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={idleOnly}
                        onClick={() => {
                          act({
                            type: "label",
                            entryId: entry.id,
                            label: label.trim() || null,
                          });
                        }}
                      >
                        {label.trim() ? "Set label" : "Clear label"}
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          </Section>
        </>
      ) : null}
      {page === "controls" ? (
        <>
          <Section title="Execution controls">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={idleOnly}
                onClick={() => {
                  act({ type: "reload" });
                }}
              >
                <RefreshCwIcon /> Reload all resources
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly}
                onClick={() => {
                  act({
                    type: "compact",
                    instructions: compactionFocus.trim() || undefined,
                  });
                }}
              >
                Compact context
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !data.retry}
                onClick={() => {
                  act({ type: "abort_retry" });
                }}
              >
                Abort retry
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !data.codeMode.activeToolCallIds.length}
                onClick={() => {
                  act({ type: "stop_code" });
                }}
              >
                Stop Code Mode
              </Button>
            </div>
            <p className="text-muted-foreground">
              {data.retry
                ? `Retry pending: ${data.retry.reason}`
                : "No pending retry"}{" "}
              · {data.codeMode.activeToolCallIds.length} Code Mode calls
            </p>
            <div className="flex flex-wrap gap-2">
              {(["foreground", "background", "queue", "all"] as const).map(
                (value) => (
                  <Button
                    key={value}
                    size="xs"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => {
                      act({ type: "abort", scope: value });
                    }}
                  >
                    Stop {value}
                  </Button>
                ),
              )}
            </div>
            <label className="flex items-center justify-between">
              Automatic retry
              <Switch
                checked={data.preferences.values.auto_retry}
                disabled={busy}
                onCheckedChange={(enabled) => {
                  act({ type: "auto_retry", enabled });
                }}
              />
            </label>
            <label className="flex items-center justify-between">
              Automatic compaction
              <Switch
                checked={data.preferences.values.auto_compaction}
                disabled={busy}
                onCheckedChange={(enabled) => {
                  act({ type: "auto_compaction", enabled });
                }}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly}
                onClick={() => {
                  act({ type: "cycle_model", direction: 1 });
                }}
              >
                Next configured model
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly}
                onClick={() => {
                  act({ type: "cycle_thinking", direction: 1 });
                }}
              >
                Next thinking level
              </Button>
            </div>
            <Input
              aria-label="Compaction instructions"
              placeholder="What should compaction preserve? (optional)"
              value={compactionFocus}
              onChange={(event) => {
                setCompactionFocus(event.target.value);
              }}
            />
          </Section>
          <Section title={`Message queue · ${queue.length}`}>
            {(["steer", "followUp"] as const).map((kind) => (
              <div key={kind} className="flex items-center gap-2">
                <span className="w-20 shrink-0">
                  {kind === "steer" ? "Steering" : "Follow-up"}
                </span>
                <ChoiceSelect
                  label={`${kind} queue mode`}
                  value={
                    kind === "steer"
                      ? data.queueModes.steering
                      : data.queueModes.followUp
                  }
                  disabled={busy}
                  onValueChange={(mode: "all" | "one-at-a-time") => {
                    act({ type: "queue_mode", kind, mode });
                  }}
                  options={[
                    { value: "all", label: "All at once" },
                    { value: "one-at-a-time", label: "One at a time" },
                  ]}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    act({ type: "clear_queue", kind });
                  }}
                >
                  Clear
                </Button>
              </div>
            ))}
            {queue.length ? (
              queue.map((entry) => (
                <div className="bg-muted rounded-lg p-3" key={entry.id}>
                  <span className="text-primary">
                    {entry.kind} · {entry.state}
                  </span>
                  <p className="mt-1 whitespace-pre-wrap">
                    {entry.text || `${entry.attachmentCount} image attachments`}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground">No queued messages</p>
            )}
          </Section>
          <Section title="Usage & cache">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Requests" value={String(data.stats.requests)} />
              <Metric label="Attempts" value={String(data.stats.attempts)} />
              <Metric
                label="Input tokens"
                value={String(data.stats.usage.inputTokens ?? "Unknown")}
              />
              <Metric
                label="Output tokens"
                value={String(data.stats.usage.outputTokens ?? "Unknown")}
              />
              <Metric
                label="Cache read tokens"
                value={
                  data.stats.usage.cacheReadInputTokens?.toLocaleString() ??
                  "Unknown"
                }
              />
              <Metric
                label="Cache write tokens"
                value={
                  data.stats.usage.cacheCreationInputTokens?.toLocaleString() ??
                  "Unknown"
                }
              />
            </div>
            <p>
              Estimated cost:{" "}
              {Object.entries(data.stats.estimated)
                .map(
                  ([currency, value]) =>
                    `${currency} ${value.amount === null ? "Unknown" : value.amount.toPrecision(5)}`,
                )
                .join(" · ") || "Unknown"}
            </p>
            <p className="text-muted-foreground">
              Cache: {data.status.cache.policy.mode} · Warming:{" "}
              {data.status.cache.warming.state}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  act({ type: "warming", enabled: false });
                }}
              >
                Pause warming
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  act({ type: "warming", enabled: true });
                }}
              >
                Resume warming
              </Button>
            </div>
          </Section>
          <Section title="Recent request attempts">
            {!data.attempts.length ? (
              <p className="text-muted-foreground">
                No model requests in this session
              </p>
            ) : null}
            <ul className="divide-border divide-y">
              {data.attempts.map((attempt) => (
                <li key={attempt.attemptId} className="py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-medium"
                      title={attempt.model}
                    >
                      {attempt.model}
                    </span>
                    <RuntimeStatus status={attempt.outcome} />
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums">
                    <span className="capitalize">
                      {attempt.purpose.replaceAll("_", " ")} · Attempt{" "}
                      {attempt.attempt}
                    </span>
                    <time dateTime={new Date(attempt.startedAt).toISOString()}>
                      {new Date(attempt.startedAt).toLocaleTimeString()}
                    </time>
                    {attempt.endedAt !== undefined ? (
                      <span>
                        {((attempt.endedAt - attempt.startedAt) / 1000).toFixed(
                          1,
                        )}{" "}
                        s
                      </span>
                    ) : null}
                    {attempt.usage ? (
                      <span>
                        {attempt.usage.inputTokens?.toLocaleString() ?? "—"} in
                        / {attempt.usage.outputTokens?.toLocaleString() ?? "—"}{" "}
                        out
                      </span>
                    ) : null}
                    <span>Estimate {formatAmount(attempt.estimate)}</span>
                    {attempt.providerAmount ? (
                      <span>
                        Reported {formatAmount(attempt.providerAmount)}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Project trust & configuration sources">
            <p className="text-muted-foreground">
              Revoking trust unloads project extensions and resources.
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={idleOnly}
              onClick={() => {
                act({ type: "revoke_trust" });
              }}
            >
              Revoke project trust
            </Button>
            <div className="space-y-2">
              {data.sources.map((source) => (
                <div
                  className="flex min-w-0 flex-wrap justify-between gap-1 border-b py-2"
                  key={source.field}
                >
                  <span className="font-mono">{source.field}</span>
                  <span className="text-muted-foreground break-all">
                    {source.scope}
                    {source.path ? ` · ${source.path}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        </>
      ) : null}
      {page === "mcp" ? (
        <>
          <Section title="MCP servers">
            {data.mcp.servers.length ? (
              data.mcp.servers.map((server) => (
                <div
                  key={server.name}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{server.name}</strong>
                    <span className="text-muted-foreground">
                      {server.state} · {server.source.scope} · {server.tools}{" "}
                      tools
                    </span>
                  </div>
                  {server.diagnostic ? (
                    <p className="text-warning">{server.diagnostic.message}</p>
                  ) : null}
                  <ChoiceSelect
                    label={`${server.name} exposure`}
                    value={server.exposure}
                    disabled={idleOnly}
                    onValueChange={(
                      exposure: "direct" | "deferred" | "codemode" | "hidden",
                    ) => {
                      act({
                        type: "mcp_exposure",
                        server: server.name,
                        exposure,
                      });
                    }}
                    options={[
                      { value: "direct", label: "Direct tools" },
                      { value: "deferred", label: "Discover on demand" },
                      { value: "codemode", label: "Code Mode" },
                      { value: "hidden", label: "Hidden" },
                    ]}
                  />
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["mcp_connect", "Connect"],
                        ["mcp_disconnect", "Disconnect"],
                        ["mcp_reload", "Reload"],
                        ["mcp_login", "Sign in"],
                        ["mcp_logout", "Sign out"],
                        ["mcp_remove", "Remove"],
                      ] as const
                    ).map(([type, title]) => (
                      <Button
                        key={type}
                        variant="outline"
                        size="xs"
                        disabled={idleOnly}
                        onClick={() => {
                          act({ type, server: server.name });
                        }}
                      >
                        {title}
                      </Button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground">No servers registered</p>
            )}
          </Section>
          <Section title="Register an MCP server">
            <Input
              aria-label="MCP server name"
              placeholder="Server name"
              value={serverName}
              onChange={(event) => {
                setServerName(event.target.value);
              }}
            />
            <ChoiceSelect
              label="MCP transport"
              value={transport}
              onValueChange={setTransport}
              options={[
                { value: "stdio", label: "Local command" },
                { value: "http", label: "HTTP server" },
              ]}
            />
            <Input
              aria-label="MCP address"
              placeholder={
                transport === "stdio"
                  ? "Executable path"
                  : "https://example.com/mcp"
              }
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
            <Textarea
              aria-label="MCP advanced configuration"
              placeholder='Optional configuration JSON: {"args":[],"env":{},"tool_exposure":[]}'
              value={advanced}
              onChange={(event) => {
                setAdvanced(event.target.value);
              }}
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              disabled={idleOnly || !serverName.trim() || !address.trim()}
              onClick={() => {
                try {
                  const config: MCPServerConfig = {
                    ...(advanced.trim()
                      ? z
                          .record(z.string(), z.unknown())
                          .parse(JSON.parse(advanced))
                      : {}),
                    name: serverName.trim(),
                    ...(transport === "stdio"
                      ? { command: address.trim() }
                      : { url: address.trim() }),
                  };
                  act(
                    data.mcp.servers.some(
                      (server) => server.name === config.name,
                    )
                      ? { type: "mcp_reload", server: config.name, config }
                      : { type: "mcp_register", config },
                  );
                } catch (error) {
                  toast.error(String(error));
                }
              }}
            >
              {data.mcp.servers.some(
                (server) => server.name === serverName.trim(),
              )
                ? "Update server"
                : "Register server"}
            </Button>
          </Section>
          <Section title="MCP resources">
            <Input
              aria-label="Resource server"
              placeholder="Server name"
              value={resourceServer}
              onChange={(event) => {
                setResourceServer(event.target.value);
              }}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly || !resourceServer}
                onClick={() => {
                  act({ type: "mcp_resources", server: resourceServer });
                }}
              >
                List resources
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly || !resourceServer}
                onClick={() => {
                  act({
                    type: "mcp_resources",
                    server: resourceServer,
                    templates: true,
                  });
                }}
              >
                List templates
              </Button>
            </div>
            <Input
              aria-label="Resource URI"
              placeholder="Resource URI"
              value={uri}
              onChange={(event) => {
                setUri(event.target.value);
              }}
            />
            <Button
              size="sm"
              disabled={idleOnly || !resourceServer || !uri}
              onClick={() => {
                act({ type: "mcp_read", server: resourceServer, uri });
              }}
            >
              Read resource
            </Button>
            {resourcePage &&
            result &&
            typeof result === "object" &&
            "nextCursor" in result &&
            typeof result.nextCursor === "string" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={idleOnly}
                onClick={() => {
                  act({
                    type: "mcp_resources",
                    ...resourcePage,
                    cursor: result.nextCursor as string,
                  });
                }}
              >
                Next resource page
              </Button>
            ) : null}
            {result !== undefined ? (
              <pre className="bg-muted max-h-80 overflow-auto rounded-lg p-3 break-all whitespace-pre-wrap">
                {JSON.stringify(result, null, 2)}
              </pre>
            ) : null}
          </Section>
        </>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="bg-muted rounded-lg p-3">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export type { AgentState };
