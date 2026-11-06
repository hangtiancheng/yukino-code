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
              aria-label="搜索能力"
              placeholder="搜索工具与技能…"
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
                aria-label="重新加载技能"
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
                    <strong className="text-accent-foreground flex items-center text-xs font-medium">
                      /{skill.name}
                      {data.activeSkills.includes(skill.name) ? (
                        <span className="text-success ml-auto inline-flex items-center gap-[3px] text-[9px] [&_svg]:size-[11px]">
                          <CheckIcon />
                          已激活
                        </span>
                      ) : null}
                    </strong>
                    <span className="text-muted-foreground text-[10px] leading-[1.7]">
                      {skill.description}
                    </span>
                  </button>
                ))
            ) : (
              <p className="text-muted-foreground py-2 text-[11px]">暂无技能</p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <WrenchIcon />
              工具
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.tools.length}
              </span>
            </h3>
            <div className="[&_details]:border-border [&_details]:bg-background [&_p]:text-muted-foreground [&_summary>svg]:text-muted-foreground grid grid-cols-2 gap-2 max-[700px]:grid-cols-1 [&_details]:self-start [&_details]:overflow-hidden [&_details]:rounded-[7px] [&_details]:border [&_p]:max-h-[180px] [&_p]:overflow-y-auto [&_p]:px-2.5 [&_p]:pb-2.5 [&_p]:text-[10px] [&_p]:leading-[1.7] [&_p]:wrap-anywhere [&_p]:whitespace-pre-wrap [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:p-2.5 [&_summary]:text-[10px] [&_summary]:wrap-anywhere [&_summary>svg]:size-3 [&_summary>svg]:shrink-0">
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
                aria-label="重新连接 MCP"
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
                  className="border-border flex min-w-0 items-center gap-[9px] border-b py-2.5 text-[11px] [&_strong]:font-medium"
                  key={name}
                >
                  <span className="bg-success inline-block size-1.5 shrink-0 rounded-full" />
                  <strong>{name}</strong>
                  <span className="text-success ml-auto text-xs">已连接</span>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground py-2 text-[11px]">
                未连接 MCP
              </p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <DatabaseIcon />
              记忆
              <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                {data.memoryEnabled ? data.memories.length : "已关闭"}
              </span>
            </h3>
            {data.memories.length ? (
              data.memories.map((memory) => (
                <details
                  className="border-border [&>p]:text-muted-foreground [&_summary_span]:text-muted-foreground border-b pb-3 [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-2.5 [&_summary]:text-[11px] [&_summary_span]:ml-auto [&_summary_span]:text-[9px] [&_summary_strong]:font-medium [&>p]:mt-[7px] [&>p]:text-[10px]"
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
              <p className="text-muted-foreground py-2 text-[11px]">暂无记忆</p>
            )}
          </section>
          <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
            <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
              <ShieldCheckIcon />
              运行环境
            </h3>
            <div className="border-border flex min-w-0 items-center gap-[9px] border-b py-2.5 text-[11px] [&_strong]:font-medium">
              <ShieldCheckIcon className="text-muted-foreground size-4" />
              <span>沙箱</span>
              <ChoiceSelect
                label="沙箱模式"
                className="ml-auto"
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
                  { value: "off", label: "关闭" },
                  { value: "manual", label: "手动授权" },
                  { value: "auto", label: "沙箱内自动授权" },
                ]}
              />
            </div>
            <div className="border-border flex min-w-0 items-center gap-[9px] border-b py-2.5 text-[11px] [&_strong]:font-medium">
              <BrainCircuitIcon className="text-muted-foreground size-4" />
              <span>协调模式</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {data.coordinator ? "已启用" : "已关闭"}
              </span>
            </div>
            <div className="border-border flex min-w-0 items-center gap-[9px] border-b py-2.5 text-[11px] [&_strong]:font-medium">
              <FileCogIcon className="text-muted-foreground size-4" />
              <span>Hooks</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {data.hooks ? "已加载" : "未配置"}
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
              压缩上下文
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
