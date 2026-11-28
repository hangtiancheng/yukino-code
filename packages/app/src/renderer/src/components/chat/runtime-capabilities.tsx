import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ChoiceSelect } from "@renderer/components/ui/select";
import type { RuntimeAction, RuntimeSnapshot } from "@shared/workspace-types";
import {
  BrainCircuitIcon,
  CheckIcon,
  DatabaseIcon,
  FileCogIcon,
  PlugIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

export function RuntimeCapabilities({
  data,
  page,
  disabled,
  busy,
  onAction,
  onPrompt,
}: {
  data: RuntimeSnapshot;
  page: "capabilities" | "context";
  disabled: boolean;
  busy: boolean;
  onAction: (action: RuntimeAction) => void;
  onPrompt: (value: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const matches = (text: string): boolean =>
    text.toLowerCase().includes(search.toLowerCase());
  return (
    <div className="flex flex-col gap-[22px]">
      {page === "capabilities" ? (
        <>
          <div className="text-muted-foreground flex items-center gap-2 [&>svg]:size-[15px]">
            <SearchIcon />
            <Input
              className="text-[11px] md:text-[11px]"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              aria-label="Search capabilities"
              placeholder="Search tools and skills…"
            />
          </div>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <SparklesIcon />
              Skills
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.skills.length}
              </span>
              <Button
                className="ml-auto"
                size="icon-sm"
                variant="ghost"
                disabled={disabled || busy}
                aria-label="Reload skills"
                onClick={() => {
                  onAction({ type: "reload_skills" });
                }}
              >
                <RefreshCwIcon />
              </Button>
            </h3>
            {data.skills.length ? (
              data.skills
                .filter((skill) =>
                  matches(`${skill.name} ${skill.description}`),
                )
                .map((skill) => (
                  <button
                    className="border-border hover:bg-background flex w-full flex-col gap-[5px] rounded-[9px] border p-3 text-left transition-colors"
                    key={skill.name}
                    disabled={disabled}
                    onClick={() => {
                      onPrompt(`/${skill.name}`);
                    }}
                  >
                    <strong className="text-accent-foreground flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium">
                      <span className="min-w-0 flex-1 wrap-anywhere">
                        /{skill.name}
                      </span>
                      {data.activeSkills.includes(skill.name) ? (
                        <span className="text-success ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] [&_svg]:size-3">
                          <CheckIcon />
                          Active
                        </span>
                      ) : null}
                    </strong>
                    <span className="text-muted-foreground text-[10px] leading-[1.7]">
                      {skill.description}
                    </span>
                  </button>
                ))
            ) : (
              <p className="text-muted-foreground py-2 text-[11px]">
                No skills
              </p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <WrenchIcon />
              Tools
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.tools.length}
              </span>
            </h3>
            <div className="[&_details]:border-border [&_details]:bg-background [&_p]:text-muted-foreground [&_summary>svg]:text-muted-foreground grid grid-cols-2 gap-2 @max-[400px]/workbench:grid-cols-1 [&_details]:min-w-0 [&_details]:self-start [&_details]:overflow-hidden [&_details]:rounded-lg [&_details]:border [&_p]:max-h-45 [&_p]:overflow-y-auto [&_p]:px-3 [&_p]:pb-3 [&_p]:text-[11px] [&_p]:leading-relaxed [&_p]:wrap-anywhere [&_p]:whitespace-pre-wrap [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-2 [&_summary]:p-3 [&_summary]:text-[11px] [&_summary]:wrap-anywhere [&_summary>svg]:size-3 [&_summary>svg]:shrink-0">
              {data.tools
                .filter((name) =>
                  matches(`${name} ${data.toolDescriptions[name]}`),
                )
                .map((name) => (
                  <details key={name}>
                    <summary>
                      <WrenchIcon />
                      {name}
                    </summary>
                    <p>{data.toolDescriptions[name]}</p>
                  </details>
                ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <PlugIcon />
              MCP
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.mcpServers.length}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Reconnect MCP"
                disabled={disabled || busy}
                onClick={() => {
                  onAction({ type: "reload_mcp" });
                }}
              >
                <RefreshCwIcon />
              </Button>
            </h3>
            {data.mcpServers.length ? (
              data.mcpServers.map((name) => (
                <div
                  className="border-border flex min-w-0 items-center gap-2.5 border-b py-3 text-xs"
                  key={name}
                >
                  <span className="bg-success inline-block size-1.5 shrink-0 rounded-full" />
                  <strong
                    className="min-w-0 flex-1 truncate font-medium"
                    title={name}
                  >
                    {name}
                  </strong>
                  <span className="text-success ml-auto shrink-0 text-[11px]">
                    Connected
                  </span>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground py-2 text-[11px]">
                No MCP servers connected
              </p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <DatabaseIcon />
              Memory
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.memoryEnabled ? data.memories.length : "Off"}
              </span>
            </h3>
            {data.memories.length ? (
              data.memories.map((memory) => (
                <details
                  className="border-border [&>p]:text-muted-foreground [&_summary_span]:text-muted-foreground min-w-0 border-b pb-3 [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-2.5 [&_summary]:text-xs [&_summary_span]:ml-auto [&_summary_span]:shrink-0 [&_summary_span]:text-[10px] [&_summary_strong]:min-w-0 [&_summary_strong]:flex-1 [&_summary_strong]:font-medium [&>p]:mt-2 [&>p]:text-[11px] [&>p]:leading-relaxed"
                  key={memory.name}
                >
                  <summary>
                    <strong>{memory.name}</strong>
                    <span>{memory.type}</span>
                  </summary>
                  <p>{memory.description}</p>
                  <pre className="border-border bg-background mt-2.5 max-h-[260px] overflow-auto rounded-[7px] border p-3 font-mono text-[10px] leading-[1.7] wrap-anywhere whitespace-pre-wrap">
                    {memory.content}
                  </pre>
                </details>
              ))
            ) : (
              <p className="text-muted-foreground py-2 text-[11px]">
                No memories
              </p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <ShieldCheckIcon />
              Runtime environment
            </h3>
            <div className="border-border flex min-w-0 flex-wrap items-center gap-2.5 border-b py-3 text-xs">
              <ShieldCheckIcon className="text-muted-foreground size-4 shrink-0" />
              <span>Sandbox</span>
              <ChoiceSelect
                label="Sandbox mode"
                className="ml-auto max-w-full text-xs"
                disabled={disabled || busy}
                value={
                  !data.sandbox.enabled
                    ? "off"
                    : data.sandbox.autoAllow
                      ? "auto"
                      : "manual"
                }
                onValueChange={(mode) => {
                  onAction({ type: "sandbox", mode });
                }}
                options={[
                  { value: "off", label: "Off" },
                  { value: "manual", label: "Ask first" },
                  { value: "auto", label: "Auto-allow" },
                ]}
              />
            </div>
            <div className="border-border flex min-w-0 flex-wrap items-center gap-2.5 border-b py-3 text-xs">
              <BrainCircuitIcon className="text-muted-foreground size-4 shrink-0" />
              <span>Coordinator</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {data.coordinator ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="border-border flex min-w-0 flex-wrap items-center gap-2.5 border-b py-3 text-xs">
              <FileCogIcon className="text-muted-foreground size-4 shrink-0" />
              <span>Hooks</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {data.hooks ? "Loaded" : "Not configured"}
              </span>
            </div>
          </section>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onPrompt("/compact");
              }}
            >
              <BrainCircuitIcon />
              Compact context
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
