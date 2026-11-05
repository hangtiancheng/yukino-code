import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
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
import { toast } from "sonner";

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
    <div className="runtime-stack">
      {page === "capabilities" ? (
        <>
          <div className="runtime-search">
            <SearchIcon />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              aria-label="搜索能力"
              placeholder="搜索工具与技能…"
            />
          </div>
          <section className="runtime-section">
            <h3 className="runtime-heading">
              <SparklesIcon />
              Skills<span className="runtime-count">{data.skills.length}</span>
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
                    className="runtime-skill"
                    key={skill.name}
                    disabled={disabled}
                    onClick={() => {
                      onPrompt(`/${skill.name}`);
                    }}
                  >
                    <strong>
                      /{skill.name}
                      {data.activeSkills.includes(skill.name) ? (
                        <span className="skill-active">
                          <CheckIcon />
                          已激活
                        </span>
                      ) : null}
                    </strong>
                    <span>{skill.description}</span>
                  </button>
                ))
            ) : (
              <p className="runtime-empty">暂无技能</p>
            )}
          </section>
          <section className="runtime-section">
            <h3 className="runtime-heading">
              <WrenchIcon />
              工具<span className="runtime-count">{data.tools.length}</span>
            </h3>
            <div className="tool-grid">
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
          <section className="runtime-section">
            <h3 className="runtime-heading">
              <PlugIcon />
              MCP<span className="runtime-count">{data.mcpServers.length}</span>
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
                <div className="runtime-row" key={name}>
                  <span className="status-dot" />
                  <strong>{name}</strong>
                  <span className="text-success ml-auto text-xs">已连接</span>
                </div>
              ))
            ) : (
              <p className="runtime-empty">未连接 MCP</p>
            )}
          </section>
          <section className="runtime-section">
            <h3 className="runtime-heading">
              <DatabaseIcon />
              记忆
              <span className="runtime-count">
                {data.memoryEnabled ? data.memories.length : "已关闭"}
              </span>
            </h3>
            {data.memories.length ? (
              data.memories.map((memory) => (
                <details className="memory-detail" key={memory.name}>
                  <summary>
                    <strong>{memory.name}</strong>
                    <span>{memory.type}</span>
                  </summary>
                  <p>{memory.description}</p>
                  <pre className="runtime-output">{memory.content}</pre>
                </details>
              ))
            ) : (
              <p className="runtime-empty">暂无记忆</p>
            )}
          </section>
          <section className="runtime-section">
            <h3 className="runtime-heading">
              <ShieldCheckIcon />
              运行环境
            </h3>
            <div className="runtime-row">
              <ShieldCheckIcon className="text-muted-foreground size-4" />
              <span>沙箱</span>
              <select
                aria-label="沙箱模式"
                className="native-select ml-auto"
                disabled={disabled || busy}
                value={
                  !data.sandbox.enabled
                    ? "off"
                    : data.sandbox.autoAllow
                      ? "auto"
                      : "manual"
                }
                onChange={(event) => {
                  onAction({
                    type: "sandbox",
                    mode: event.target.value as "auto" | "manual" | "off",
                  });
                }}
              >
                <option value="off">关闭</option>
                <option value="manual">手动授权</option>
                <option value="auto">沙箱内自动授权</option>
              </select>
            </div>
            <div className="runtime-row">
              <BrainCircuitIcon className="text-muted-foreground size-4" />
              <span>协调模式</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {data.coordinator ? "已启用" : "已关闭"}
              </span>
            </div>
            <div className="runtime-row">
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void window.api
                  .openConfig()
                  .catch((cause: unknown) => toast.error(String(cause)));
              }}
            >
              <FileCogIcon />
              打开配置
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
