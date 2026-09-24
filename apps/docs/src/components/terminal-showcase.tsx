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

import { LitElement, customElement, state } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { VERSION } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import {
  animateIn,
  animateOut,
  EASE,
  flipTo,
  prefersReducedMotion,
  setupReveals,
  sleep,
} from "@/lib/motion";
import {
  container,
  focusRing,
  gradientText,
  gridPattern,
  heading,
  line,
  muted,
} from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

type Step =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; arg: string }
  | { kind: "answer"; text: string };

type VisibleStep = Step & { live?: boolean };

interface Scene {
  prompt: string;
  steps: Step[];
  model: string;
  tokens: string;
  elapsed: string;
}

const SCENES: Scene[] = [
  {
    prompt: "Refactor token verification into a single helper",
    model: "claude-sonnet-4",
    tokens: "18.4k",
    elapsed: "6.1s",
    steps: [
      {
        kind: "thinking",
        text: "Scanning the auth module and every call site…",
      },
      { kind: "tool", name: "Grep", arg: '"verifyToken" · src' },
      { kind: "tool", name: "ReadFile", arg: "src/auth/session.ts" },
      { kind: "tool", name: "EditFile", arg: "src/auth/session.ts" },
      { kind: "tool", name: "Bash", arg: "pnpm test" },
      {
        kind: "answer",
        text: "Moved verification into a single verifyToken() helper, updated 4 call sites, and all 12 tests pass.",
      },
    ],
  },
  {
    prompt: "Where is the rate limiter configured?",
    model: "gpt-5-codex",
    tokens: "9.2k",
    elapsed: "3.4s",
    steps: [
      {
        kind: "thinking",
        text: "Locating the rate-limit middleware and its config…",
      },
      { kind: "tool", name: "Glob", arg: "src/**/*.ts" },
      { kind: "tool", name: "Grep", arg: '"rateLimit" · include *.ts' },
      { kind: "tool", name: "ReadFile", arg: "src/middleware/rate-limit.ts" },
      {
        kind: "answer",
        text: "In src/middleware/rate-limit.ts — a sliding-window limiter backed by Redis, capped at 100 req/min per route.",
      },
    ],
  },
  {
    prompt: "Add a persisted dark mode toggle to settings",
    model: "claude-opus-4",
    tokens: "27.8k",
    elapsed: "9.7s",
    steps: [
      {
        kind: "thinking",
        text: "Reading the settings page and the theme provider…",
      },
      { kind: "tool", name: "ReadFile", arg: "src/settings/Appearance.tsx" },
      { kind: "tool", name: "EditFile", arg: "src/settings/Appearance.tsx" },
      { kind: "tool", name: "EditFile", arg: "src/theme/provider.tsx" },
      { kind: "tool", name: "Bash", arg: "pnpm typecheck" },
      {
        kind: "answer",
        text: "Added a persisted dark mode toggle wired into the existing provider. Typecheck is clean.",
      },
    ],
  },
  {
    prompt: "Audit the payments module in parallel",
    model: "claude-sonnet-4",
    tokens: "41.3k",
    elapsed: "22.6s",
    steps: [
      {
        kind: "thinking",
        text: "Spawning two teammates in isolated worktrees…",
      },
      { kind: "tool", name: "EnterWorktree", arg: "payments-audit" },
      { kind: "tool", name: "SpawnTeammate", arg: "security-auditor" },
      { kind: "tool", name: "SpawnTeammate", arg: "perf-auditor" },
      {
        kind: "answer",
        text: "Both auditors finished. 3 issues found — one critical (missing idempotency key). Full report attached.",
      },
    ],
  },
];

const TOOL_ICONS: Record<string, string> = {
  Grep: icons.search,
  Glob: icons.folderTree,
  ReadFile: icons.fileCode,
  EditFile: icons.pencilRuler,
  Bash: icons.terminal,
  EnterWorktree: icons.gitBranch,
  SpawnTeammate: icons.network,
};

const TABS = [
  { id: "terminal", label: "Terminal", icon: icons.squareTerminal },
  { id: "browser", label: "Browser UI", icon: icons.monitor },
  { id: "print", label: "Print mode", icon: icons.arrowRight },
] as const;

type TabId = (typeof TABS)[number]["id"];

const PRINT_LINES = [
  {
    text: 'yukino -p "fix the failing test" --output-format stream-json',
    tone: "cmd",
  },
  {
    text: '{"type":"stream_text","text":"Reading the test file…"}',
    tone: "text",
  },
  {
    text: '{"type":"tool_use","tool":"ReadFile","args":{"file_path":"test/api.test.ts"}}',
    tone: "tool",
  },
  { text: '{"type":"tool_result","isError":false,"output":"…"}', tone: "ok" },
  {
    text: '{"type":"tool_use","tool":"EditFile","args":{"file_path":"src/api.ts"}}',
    tone: "tool",
  },
  {
    text: '{"type":"stream_text","text":"Fixed the off-by-one in pagination."}',
    tone: "text",
  },
  {
    text: '{"type":"usage","input_tokens":8421,"output_tokens":512}',
    tone: "muted",
  },
  { text: '{"type":"loop_complete","stopReason":"end_turn"}', tone: "ok" },
] as const;

@customElement("docs-terminal-showcase")
export class TerminalShowcaseElement extends LitElement {
  @state() private tab: TabId = "terminal";
  @state() private sceneIndex = 0;
  @state() private visible: VisibleStep[] = SCENES[0].steps.map((step) => ({
    ...step,
  }));
  @state() private typing: string | null = null;

  private generation = 0;
  private swapping = false;
  private looping = false;
  private started = false;
  private visibility?: IntersectionObserver;

  override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    this.positionPill();
    setupReveals(this);
    // The scene loop types and auto-advances forever; only run it while the
    // section is actually on screen. First paint already shows a finished
    // session, so entering the view (re)starts the loop.
    this.visibility = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const first = !this.started;
          this.started = true;
          this.startLoop(first);
        } else {
          this.stopLoop();
        }
      },
      { threshold: 0.15 },
    );
    this.visibility.observe(this);
  }

  override updated() {
    setupReveals(this);
    const scroller = this.querySelector<HTMLElement>("[data-terminal-scroll]");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.generation++;
    this.looping = false;
    this.visibility?.disconnect();
  }

  private startLoop(first: boolean) {
    if (this.looping || prefersReducedMotion()) return;
    this.looping = true;
    const generation = this.generation;
    // On first sight hold the finished session briefly, then animate; on
    // re-entry replay the current scene right away.
    const hold = first ? 3800 : 400;
    const next = first ? 1 : this.sceneIndex;
    void sleep(hold).then(() => {
      if (generation === this.generation && this.looping)
        this.selectScene(next);
    });
  }

  private stopLoop() {
    this.looping = false;
    this.generation++;
  }

  private selectScene(index: number) {
    const generation = ++this.generation;
    this.sceneIndex = index;
    void this.runScene(generation);
  }

  private async runScene(generation: number) {
    const scene = SCENES[this.sceneIndex];
    if (prefersReducedMotion()) {
      // No typing, no step-by-step reveal, no autoplay: show the finished
      // session immediately. Scene dots still switch scenes instantly.
      this.typing = null;
      this.visible = scene.steps.map((step) => ({ ...step }));
      return;
    }
    this.visible = [];
    this.typing = "";
    await sleep(320);
    if (generation !== this.generation) return;

    for (let i = 1; i <= scene.prompt.length; i++) {
      this.typing = scene.prompt.slice(0, i);
      await sleep(30);
      if (generation !== this.generation) return;
    }
    this.typing = null;
    await sleep(460);
    if (generation !== this.generation) return;

    for (let index = 0; index < scene.steps.length; index++) {
      const step = scene.steps[index];
      this.visible = [...this.visible, { ...step, live: step.kind === "tool" }];
      await this.updateComplete;
      if (generation !== this.generation) return;
      this.animateLastRow();
      await sleep(step.kind === "tool" ? 720 : 1050);
      if (generation !== this.generation) return;
      const current = [...this.visible];
      const last = current[current.length - 1];
      current[current.length - 1] = { ...last, live: false };
      this.visible = current;
      await sleep(160);
      if (generation !== this.generation) return;
    }

    await sleep(4200);
    if (generation !== this.generation) return;
    this.selectScene((this.sceneIndex + 1) % SCENES.length);
  }

  private animateLastRow() {
    const rows = this.querySelectorAll<HTMLElement>("[data-step-row]");
    const row = rows[rows.length - 1];
    if (row) {
      // Pre-hide inline, not with a class: batch-rendered rows (the initial
      // finished session, and everything under reduced motion) are never
      // animated in and must stay visible.
      row.style.opacity = "0";
      animateIn(row, { opacity: [0, 1], y: [6, 0] }, { duration: 0.4 });
    }
  }

  private positionPill(withFlip = false) {
    const list = this.querySelector<HTMLElement>("[data-tab-list]");
    const pill = this.querySelector<HTMLElement>("[data-tab-pill]");
    const activeButton = list?.querySelector<HTMLElement>(
      `[data-tab="${this.tab}"]`,
    );
    if (!list || !pill || !activeButton) return;
    const first = pill.getBoundingClientRect();
    pill.style.left = `${activeButton.offsetLeft}px`;
    pill.style.width = `${activeButton.offsetWidth}px`;
    if (withFlip) flipTo(pill, first);
  }

  private async selectTab(id: TabId) {
    if (id === this.tab || this.swapping) return;
    this.swapping = true;
    const panel = this.querySelector<HTMLElement>("[data-tab-panel]");
    if (panel) {
      await animateOut(
        panel,
        { opacity: 0, y: -12 },
        { duration: 0.2, ease: EASE },
      );
    }
    this.tab = id;
    await this.updateComplete;
    this.positionPill(true);
    const next = this.querySelector<HTMLElement>("[data-tab-panel]");
    if (next) {
      next.style.opacity = "0";
      animateIn(
        next,
        { opacity: [0, 1], y: [16, 0] },
        { duration: 0.35, ease: EASE },
      );
    }
    this.swapping = false;
  }

  private renderToolRow(step: Extract<VisibleStep, { kind: "tool" }>) {
    const iconName = TOOL_ICONS[step.name] ?? icons.wrench;
    return (
      <div
        data-step-row
        className="flex items-center gap-2.5 pl-5 font-mono text-[12.5px] sm:text-[13px]"
      >
        <span
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-md",
            step.live
              ? "bg-brand-500/15 text-brand-600 dark:bg-brand-400/15 dark:text-brand-300"
              : "bg-emerald-500/12 text-emerald-600 dark:bg-emerald-400/12 dark:text-emerald-400",
          )}
        >
          {step.live
            ? unsafeHTML(icon(icons.loaderCircle, "animate-spin-slow h-3 w-3"))
            : unsafeHTML(icon(icons.check, "h-3 w-3"))}
        </span>
        {unsafeHTML(
          icon(
            iconName,
            "h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500",
          ),
        )}
        <span className="font-semibold text-zinc-800 dark:text-zinc-200">
          {step.name}
        </span>
        <span className="truncate text-zinc-400 dark:text-zinc-500">
          {step.arg}
        </span>
      </div>
    );
  }

  private renderTerminalPanel() {
    const scene = SCENES[this.sceneIndex];
    return (
      <div className="relative">
        <div
          className={cn(
            "shadow-card overflow-hidden rounded-2xl border bg-white dark:bg-[#0c0f0a] dark:shadow-none",
            line,
          )}
        >
          {/* window chrome */}
          <div
            className={cn(
              "bg-brand-50/70 flex items-center gap-3 border-b px-4 py-3 dark:bg-white/2",
              line,
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            <div className="flex flex-1 items-center justify-center gap-2 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
              {unsafeHTML(icon(icons.terminal, "h-3 w-3"))}
              yukino — ~/acme-api
            </div>
            <div className="hidden items-center gap-1.5 sm:flex">
              {SCENES.map((_, index) => (
                <button
                  type="button"
                  aria-label={`Scene ${index + 1}`}
                  onClick={() => this.selectScene(index)}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    index === this.sceneIndex
                      ? "bg-brand-500 w-5"
                      : "w-1.5 bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-600",
                  )}
                />
              ))}
            </div>
          </div>

          {/* body */}
          <div
            data-terminal-scroll
            className="h-84 overflow-hidden px-4 py-5 font-mono text-[12.5px] leading-relaxed sm:h-92 sm:px-5 sm:text-[13px]"
          >
            <div className="mb-4 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-600">
              <span className="bg-brand-500/10 inline-flex h-4 items-center rounded px-1.5 text-zinc-500 dark:bg-white/6 dark:text-zinc-400">
                yukino
              </span>
              <span>{VERSION}</span>
              <span>·</span>
              <span>model {scene.model}</span>
              <span>·</span>
              <span className="text-emerald-500">● ready</span>
            </div>

            <div className="flex items-start gap-2">
              <span className="text-brand-500 dark:text-brand-400 pt-0.5 select-none">
                ›
              </span>
              <span className="text-brand-950 dark:text-zinc-100">
                {this.typing !== null ? this.typing : scene.prompt}
                {this.typing !== null ? (
                  <span className="animate-blink bg-brand-500 dark:bg-brand-400 ml-0.5 inline-block h-[1.05em] w-1.75 translate-y-0.5" />
                ) : null}
              </span>
            </div>

            <div className="mt-4 space-y-2.5">
              {this.visible.map((step) => {
                if (step.kind === "thinking") {
                  return (
                    <p
                      data-step-row
                      className="flex gap-2 pl-5 text-[12px] text-zinc-400 italic dark:text-zinc-500"
                    >
                      <span className="text-amber-400 not-italic">✻</span>
                      {step.text}
                    </p>
                  );
                }
                if (step.kind === "tool") {
                  return this.renderToolRow(step);
                }
                return (
                  <p
                    data-step-row
                    className="flex gap-2 pl-5 text-zinc-700 dark:text-zinc-300"
                  >
                    <span className="text-brand-500 dark:text-brand-400">
                      ●
                    </span>
                    <span className="font-sans text-[13px] leading-relaxed sm:text-sm">
                      {step.text}
                    </span>
                  </p>
                );
              })}
            </div>
          </div>

          {/* status bar */}
          <div
            className={cn(
              "bg-brand-50/70 flex items-center justify-between gap-3 border-t px-4 py-2.5 font-mono text-[11px] text-zinc-400 dark:bg-white/2 dark:text-zinc-500",
              line,
            )}
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-emerald-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                acceptEdits
              </span>
              <span>sandbox on</span>
            </div>
            <div className="flex items-center gap-3">
              <span>{scene.tokens} tokens</span>
              <span>{scene.elapsed}</span>
              <span className="hidden sm:inline">
                Ctrl+O output · Shift+Tab mode
              </span>
            </div>
          </div>
        </div>

        <p className={cn("mt-4 text-center text-xs", muted)}>
          Illustrative session. Run <span className="font-mono">yukino</span>{" "}
          for the real thing.
        </p>
      </div>
    );
  }

  private renderBrowserPanel() {
    return (
      <div
        className={cn(
          "shadow-card overflow-hidden rounded-2xl border bg-white dark:bg-[#0c0f0a] dark:shadow-none",
          line,
        )}
      >
        <div
          className={cn(
            "bg-brand-50/70 flex items-center gap-3 border-b px-4 py-3 dark:bg-white/2",
            line,
          )}
        >
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="border-brand-950/10 flex flex-1 items-center gap-2 rounded-lg border bg-white px-3 py-1.5 font-mono text-[11px] text-zinc-400 dark:border-white/10 dark:bg-white/3 dark:text-zinc-500">
            <span className="text-emerald-500">●</span>
            http://127.0.0.1:18888
          </div>
        </div>
        <div className="h-84 space-y-4 overflow-hidden px-6 py-6 sm:h-92">
          <div
            data-reveal
            data-reveal-y="12"
            className="bg-brand-600 dark:bg-brand-500 ml-auto max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm text-white opacity-0"
          >
            Wire up the retry logic and show me the diff
          </div>
          <div
            data-reveal
            data-reveal-y="12"
            data-reveal-delay="0.15"
            className="max-w-[85%] space-y-3 opacity-0"
          >
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="bg-brand-500/15 text-brand-500 grid h-5 w-5 place-items-center rounded-md">
                {unsafeHTML(icon(icons.check, "h-3 w-3"))}
              </span>
              EditFile · src/net/retry.ts
            </div>
            <div className="border-brand-950/10 overflow-hidden rounded-xl border font-mono text-xs dark:border-white/10">
              <div className="bg-red-500/10 px-3 py-1 text-red-600 dark:text-red-400">
                - await fetch(url, opts)
              </div>
              <div className="bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:text-emerald-400">
                + await retry(() =&gt; fetch(url, opts), {"{ attempts: 3 }"})
              </div>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Wrapped the request in a 3-attempt exponential backoff. Approve to
              write it?
            </p>
          </div>
        </div>
      </div>
    );
  }

  private renderPrintPanel() {
    return (
      <div
        className={cn(
          "shadow-card bg-brand-50/70 overflow-hidden rounded-2xl border dark:bg-[#0c0f0a] dark:shadow-none",
          "border-brand-950/10 dark:border-white/10",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-3 border-b bg-white/60 px-4 py-3 dark:bg-white/2",
            "border-brand-950/10 dark:border-white/8",
          )}
        >
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="flex flex-1 items-center justify-center font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
            ci — stream-json
          </div>
        </div>
        <div className="h-84 space-y-2 overflow-hidden px-5 py-5 font-mono text-[11.5px] leading-relaxed sm:h-92 sm:text-[12.5px]">
          {PRINT_LINES.map((item, index) => (
            <div
              data-reveal
              data-reveal-x="-6"
              data-reveal-y="0"
              data-reveal-delay={String(index * 0.06)}
              className={cn(
                "truncate opacity-0",
                item.tone === "cmd" && "text-brand-950 dark:text-zinc-100",
                item.tone === "text" && "text-sky-700 dark:text-sky-300/90",
                item.tone === "tool" && "text-brand-700 dark:text-brand-300",
                item.tone === "ok" && "text-emerald-600 dark:text-emerald-400",
                item.tone === "muted" && "text-zinc-400 dark:text-zinc-500",
              )}
            >
              {item.tone === "cmd" ? (
                <span className="text-brand-600 dark:text-brand-400">$ </span>
              ) : null}
              {item.text}
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2 text-zinc-400 dark:text-zinc-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            exit 0 · 0.9s
          </div>
        </div>
      </div>
    );
  }

  override render() {
    return (
      <Section id="showcase" className="overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <div
            className={cn(
              "absolute inset-0",
              gridPattern,
              "mask-[radial-gradient(ellipse_60%_50%_at_50%_50%,black,transparent)] [-webkit-mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,black,transparent)]",
            )}
          />
        </div>

        <SectionHeader
          eyebrow="See it work"
          title={
            <>
              One agent, <span className={gradientText}>every surface</span>
            </>
          }
          description="The same engine drives the terminal UI, a browser session over WebSocket, and a scriptable print mode for CI."
        />

        <docs-reveal delay={0.1} className={cn(container, "relative mt-12")}>
          <div className="mb-6 flex justify-center">
            <div className="max-w-full overflow-x-auto">
              <div
                data-tab-list
                className={cn(
                  "relative inline-flex items-center gap-1 rounded-full border bg-white/70 p-1 backdrop-blur dark:bg-white/3",
                  line,
                )}
                role="tablist"
                aria-label="Interface"
              >
                <span
                  data-tab-pill
                  className="bg-brand-500/12 absolute top-1 bottom-1 rounded-full shadow-sm dark:bg-white/8"
                  aria-hidden="true"
                />
                {TABS.map((item) => {
                  const selected = item.id === this.tab;
                  return (
                    <button
                      data-tab={item.id}
                      id={`showcase-tab-${item.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="showcase-panel"
                      onClick={() => void this.selectTab(item.id)}
                      className={cn(
                        "relative inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-4",
                        focusRing,
                        selected
                          ? cn(heading)
                          : "hover:text-brand-900 text-zinc-500 dark:text-zinc-500 dark:hover:text-zinc-200",
                      )}
                    >
                      {unsafeHTML(icon(item.icon, "relative h-3.5 w-3.5"))}
                      <span className="relative">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div
            data-tab-panel
            id="showcase-panel"
            role="tabpanel"
            aria-labelledby={`showcase-tab-${this.tab}`}
          >
            {this.tab === "terminal" ? this.renderTerminalPanel() : null}
            {this.tab === "browser" ? this.renderBrowserPanel() : null}
            {this.tab === "print" ? this.renderPrintPanel() : null}
          </div>
        </docs-reveal>
      </Section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-terminal-showcase": TerminalShowcaseElement;
  }
}
