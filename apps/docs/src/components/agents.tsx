/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { LitElement, customElement } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { agentCards } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { setupReveals } from "@/lib/motion";
import { card, container, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

const TEAM = [
  {
    name: "lead",
    model: "claude-sonnet-4",
    task: "coordinating",
    status: "lead" as const,
  },
  {
    name: "security-auditor",
    model: "claude-sonnet-4",
    task: "Auditing auth flows",
    status: "done" as const,
  },
  {
    name: "perf-auditor",
    model: "gpt-5-codex",
    task: "Tracing N+1 queries",
    status: "running" as const,
  },
  {
    name: "docs-writer",
    model: "claude-haiku-4",
    task: "Drafting the changelog",
    status: "running" as const,
  },
];

const MESSAGES = [
  { from: "lead", text: "audit src/payments for idempotency", tone: "to" },
  {
    from: "security-auditor",
    text: "found missing idempotency key → report",
    tone: "from",
  },
  {
    from: "perf-auditor",
    text: "2 N+1 queries in listInvoices()",
    tone: "from",
  },
];

@customElement("docs-agents")
export class AgentsElement extends LitElement {
  override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    setupReveals(this);
  }

  override render() {
    return (
      <Section id="agents" className="bg-brand-50/50 dark:bg-white/1.5">
        <SectionHeader
          eyebrow="Multi-agent"
          title={
            <>
              One lead, <span className="text-brand-500">a whole team</span>
            </>
          }
          description="Fork your own context, fire off background subagents, or coordinate a full team over file mailboxes — with risky work isolated in its own git worktree."
        />

        <div
          className={cn(
            container,
            "mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[1.05fr_1fr]",
          )}
        >
          <docs-reveal>
            <div className="flex h-full flex-col gap-4">
              {agentCards.map((agent, index) => (
                <div
                  className={cn(
                    "group flex items-start gap-4 rounded-2xl border p-5 transition-colors dark:bg-white/2",
                    line,
                    "hover:border-brand-500/40 hover:bg-brand-500/4",
                  )}
                >
                  <span className="bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300 grid h-11 w-11 shrink-0 place-items-center rounded-xl">
                    {unsafeHTML(icon(agent.icon, "h-5 w-5"))}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "font-mono text-sm font-semibold",
                          heading,
                        )}
                      >
                        {agent.name}
                      </span>
                      <span className="border-brand-950/8 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase dark:border-white/8 dark:text-zinc-400">
                        {agent.role}
                      </span>
                    </div>
                    <p className={cn("mt-1.5 text-sm leading-relaxed", muted)}>
                      {agent.description}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {agent.tools.map((tool) => (
                        <span className="bg-brand-500/10 rounded-md px-2 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-white/6 dark:text-zinc-400">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="hidden self-center text-xs text-zinc-400 sm:block">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
              ))}

              <div
                className={cn("rounded-2xl border p-5 dark:bg-white/2", line)}
              >
                <div className="flex items-center gap-3">
                  {unsafeHTML(icon(icons.workflow, "text-brand-500 h-5 w-5"))}
                  <h3 className={cn("text-sm font-semibold", heading)}>
                    Custom agents
                  </h3>
                </div>
                <p className={cn("mt-2 text-sm leading-relaxed", muted)}>
                  Define your own agents as Markdown files with YAML
                  front-matter in{" "}
                  <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    .yukino/agents/
                  </code>
                  . Pick the tools, model and permission mode each one gets.
                </p>
              </div>

              <div
                className={cn("rounded-2xl border p-5 dark:bg-white/2", line)}
              >
                <div className="flex items-center gap-3">
                  {unsafeHTML(icon(icons.network, "text-brand-500 h-5 w-5"))}
                  <h3 className={cn("text-sm font-semibold", heading)}>
                    Three ways to delegate
                  </h3>
                </div>
                <ul className="mt-3 space-y-2.5">
                  {[
                    {
                      icon: icons.gitBranch,
                      name: "fork",
                      detail:
                        "omit subagent_type — inherits your full conversation",
                    },
                    {
                      icon: icons.inbox,
                      name: "background",
                      detail:
                        "run_in_background=true — results arrive as a task notification",
                    },
                    {
                      icon: icons.users,
                      name: "team",
                      detail:
                        "persistent teammates with mailboxes and a shared task board",
                    },
                  ].map((mode) => (
                    <li className="flex items-start gap-2.5">
                      <span className="mt-0.5 shrink-0">
                        {unsafeHTML(
                          icon(
                            mode.icon,
                            "text-brand-500 dark:text-brand-400 h-3.5 w-3.5",
                          ),
                        )}
                      </span>
                      <span className={cn("text-sm leading-relaxed", muted)}>
                        <code className="font-mono text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          {mode.name}
                        </code>{" "}
                        — {mode.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </docs-reveal>

          <docs-reveal delay={0.12}>
            <div className={cn("overflow-hidden", card)}>
              <div
                className={cn(
                  "flex items-center justify-between gap-3 border-b px-5 py-4",
                  line,
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className="bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300 grid h-8 w-8 place-items-center rounded-lg">
                    {unsafeHTML(icon(icons.users, "h-4 w-4"))}
                  </span>
                  <div>
                    <p
                      className={cn("font-mono text-sm font-semibold", heading)}
                    >
                      team: payments-audit
                    </p>
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      {TEAM.length} members · in-process
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  live
                </span>
              </div>

              <ul className="space-y-1 px-3 py-4">
                {TEAM.map((member, index) => (
                  <li
                    data-reveal
                    data-reveal-x="-8"
                    data-reveal-delay={String(index * 0.08)}
                    className="hover:bg-brand-50/70 flex items-center gap-3 rounded-xl px-2.5 py-2.5 opacity-0 transition-colors dark:hover:bg-white/3"
                  >
                    <span
                      className={cn(
                        "ml-1 h-1.5 w-1.5 shrink-0 rounded-full",
                        member.status === "lead" && "bg-brand-500",
                        member.status === "done" && "bg-emerald-500",
                        member.status === "running" && "bg-amber-400",
                      )}
                    />
                    <span className="w-32 shrink-0 truncate font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200">
                      {member.name}
                    </span>
                    <span className="hidden flex-1 truncate text-[12px] text-zinc-400 sm:block dark:text-zinc-500">
                      {member.task}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-zinc-400 dark:text-zinc-600">
                      {member.model}
                    </span>
                    <span className="grid h-5 w-5 shrink-0 place-items-center">
                      {member.status === "running"
                        ? unsafeHTML(
                            icon(
                              icons.loaderCircle,
                              "animate-spin-slow h-3.5 w-3.5 text-amber-500",
                            ),
                          )
                        : unsafeHTML(
                            icon(icons.check, "h-3.5 w-3.5 text-emerald-500"),
                          )}
                    </span>
                  </li>
                ))}
              </ul>

              <div className={cn("border-t px-5 py-4", line)}>
                <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
                  {unsafeHTML(icon(icons.inbox, "h-3.5 w-3.5"))}
                  mailbox
                </div>
                <div className="mt-3 space-y-2">
                  {MESSAGES.map((message, index) => (
                    <div
                      data-reveal
                      data-reveal-y="6"
                      data-reveal-delay={String(index * 0.12)}
                      className={cn(
                        "flex items-start gap-2 rounded-lg border px-3 py-2 font-mono text-[11.5px] opacity-0",
                        message.tone === "to"
                          ? "border-brand-500/20 bg-brand-500/6 text-brand-700 dark:text-brand-300"
                          : cn(
                              line,
                              "bg-brand-50/50 text-zinc-600 dark:bg-white/2 dark:text-zinc-400",
                            ),
                      )}
                    >
                      {unsafeHTML(
                        icon(
                          icons.arrowRight,
                          cn(
                            "mt-0.5 h-3 w-3 shrink-0",
                            message.tone === "to"
                              ? "text-brand-500"
                              : "rotate-180 text-emerald-500",
                          ),
                        ),
                      )}
                      <span className="font-semibold">{message.from}:</span>
                      <span className="min-w-0 flex-1">{message.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div
                className={cn(
                  "bg-brand-50/50 flex items-center justify-between gap-3 border-t px-5 py-3 text-[11px] text-zinc-400 dark:bg-white/2 dark:text-zinc-500",
                  line,
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  {unsafeHTML(icon(icons.gitBranch, "h-3.5 w-3.5"))}2 worktrees
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {unsafeHTML(icon(icons.inbox, "h-3.5 w-3.5"))}2 mailboxes
                </span>
                <span className="font-mono">Ctrl+T teams</span>
              </div>
            </div>
          </docs-reveal>
        </div>
      </Section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-agents": AgentsElement;
  }
}
