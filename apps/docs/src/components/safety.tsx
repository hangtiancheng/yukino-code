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
import { animate, stagger } from "motion";
import { cn } from "@/lib/cn";
import { permissionModes } from "@/lib/content";
import type { PermissionModeId } from "@/lib/content";
import { LocaleController, t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { animateIn, animateOut, EASE } from "@/lib/motion";
import { card, container, focusRing, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

const MODE_ICON: Record<string, string> = {
  default: icons.lock,
  acceptEdits: icons.wrench,
  plan: icons.listTree,
  bypassPermissions: icons.zap,
};

type RowTone = "allow" | "ask" | "deny" | "auto";

interface DialogRow {
  labelKey: MessageKey;
  value: string;
  tone: RowTone;
}

interface DialogView {
  chipKey: MessageKey;
  noteKey: MessageKey;
  title?: string;
  titleKey?: MessageKey;
  meta?: string;
  metaKey?: MessageKey;
  rows: DialogRow[];
}

const DIALOGS: Record<PermissionModeId, DialogView> = {
  default: {
    chipKey: "safety.dialogs.default.chip",
    noteKey: "safety.dialogs.default.note",
    title: "Bash",
    meta: "pnpm add drizzle-orm",
    rows: [
      {
        labelKey: "safety.dialogs.default.rows.allowOnce",
        value: "Enter",
        tone: "allow",
      },
      {
        labelKey: "safety.dialogs.default.rows.allowAlways",
        value: "A",
        tone: "auto",
      },
      {
        labelKey: "safety.dialogs.default.rows.deny",
        value: "Esc",
        tone: "deny",
      },
    ],
  },
  acceptEdits: {
    chipKey: "safety.dialogs.acceptEdits.chip",
    noteKey: "safety.dialogs.acceptEdits.note",
    title: "EditFile",
    meta: "src/db/schema.ts",
    rows: [
      {
        labelKey: "safety.dialogs.acceptEdits.rows.applied",
        value: "auto",
        tone: "auto",
      },
      {
        labelKey: "safety.dialogs.acceptEdits.rows.bashAsks",
        value: "ask",
        tone: "ask",
      },
      {
        labelKey: "safety.dialogs.acceptEdits.rows.denyWins",
        value: "deny",
        tone: "deny",
      },
    ],
  },
  plan: {
    chipKey: "safety.dialogs.plan.chip",
    noteKey: "safety.dialogs.plan.note",
    titleKey: "safety.dialogs.plan.title",
    metaKey: "safety.dialogs.plan.meta",
    rows: [
      {
        labelKey: "safety.dialogs.plan.rows.reads",
        value: "allow",
        tone: "allow",
      },
      {
        labelKey: "safety.dialogs.plan.rows.writes",
        value: "ask",
        tone: "ask",
      },
      {
        labelKey: "safety.dialogs.plan.rows.exit",
        value: "approve",
        tone: "auto",
      },
    ],
  },
  bypassPermissions: {
    chipKey: "safety.dialogs.bypassPermissions.chip",
    noteKey: "safety.dialogs.bypassPermissions.note",
    title: "Bash",
    meta: "pnpm test -- --coverage",
    rows: [
      {
        labelKey: "safety.dialogs.bypassPermissions.rows.noPrompts",
        value: "bypass",
        tone: "auto",
      },
      {
        labelKey: "safety.dialogs.bypassPermissions.rows.autonomy",
        value: "on",
        tone: "auto",
      },
      {
        labelKey: "safety.dialogs.bypassPermissions.rows.denyStill",
        value: "deny",
        tone: "deny",
      },
    ],
  },
};

const TONE: Record<RowTone, string> = {
  allow:
    "border-accent-500/25 bg-accent-500/10 text-accent-700 dark:text-accent-300",
  ask: "border-g-yellow/40 bg-g-yellow/10 text-[#b06000] dark:text-[#fdd663]",
  deny: "border-g-red/25 bg-g-red/10 text-g-red dark:text-[#f28b82]",
  auto: "border-brand-500/25 bg-brand-500/10 text-brand-700 dark:text-brand-300",
};

const SAFETY_FEATURES: Array<{
  id: "sandbox" | "rules" | "worktree";
  icon: string;
}> = [
  { id: "sandbox", icon: icons.shieldCheck },
  { id: "rules", icon: icons.shieldAlert },
  { id: "worktree", icon: icons.gitBranch },
];

@customElement("docs-safety")
export class SafetyElement extends LitElement {
  @state() private active: PermissionModeId = permissionModes[0].id;

  private swapping = false;

  locale = new LocaleController(this);

  override createRenderRoot() {
    return this;
  }

  private async selectMode(mode: PermissionModeId) {
    if (mode === this.active || this.swapping) return;
    this.swapping = true;
    const panel = this.querySelector<HTMLElement>("[data-dialog-panel]");
    if (panel) {
      await animateOut(
        panel,
        { opacity: 0, y: -10 },
        { duration: 0.2, ease: EASE },
      );
    }
    this.active = mode;
    await this.updateComplete;
    const next = this.querySelector<HTMLElement>("[data-dialog-panel]");
    if (next) {
      next.style.opacity = "0";
      animateIn(
        next,
        { opacity: [0, 1], y: [14, 0] },
        { duration: 0.3, ease: EASE },
      );
      const rows = Array.from(
        next.querySelectorAll<HTMLElement>("[data-dialog-row]"),
      );
      animate(
        rows,
        { opacity: [0, 1], x: [-6, 0] },
        { duration: 0.3, delay: stagger(0.06), ease: EASE },
      );
    }
    this.swapping = false;
  }

  override render() {
    const view = DIALOGS[this.active] ?? DIALOGS.default;

    return (
      <Section id="safety">
        <SectionHeader
          eyebrow={t("safety.eyebrow")}
          title={
            <>
              {t("safety.titleA")}{" "}
              <span className="text-brand-500">
                {t("safety.titleHighlight")}
              </span>{" "}
              {t("safety.titleB")}
            </>
          }
          description={t("safety.description")}
        />

        <div
          className={cn(
            container,
            "mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.05fr]",
          )}
        >
          <docs-reveal>
            <div className="flex flex-col gap-3">
              {permissionModes.map((mode) => {
                const selected = mode.id === this.active;
                return (
                  <button
                    type="button"
                    onClick={() => void this.selectMode(mode.id)}
                    className={cn(
                      "group relative overflow-hidden rounded-2xl border p-5 text-left transition-all duration-300",
                      focusRing,
                      selected
                        ? "border-brand-500/40 bg-brand-500/6 shadow-glow"
                        : cn(
                            line,
                            "hover:border-brand-500/30 bg-white dark:bg-white/2 dark:hover:border-white/20",
                          ),
                    )}
                  >
                    <div className="flex items-start gap-4">
                      <span
                        className={cn(
                          "grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors",
                          selected
                            ? "bg-brand-500 text-white"
                            : "bg-brand-500/10 text-zinc-500 dark:bg-white/6 dark:text-zinc-400",
                        )}
                      >
                        {unsafeHTML(
                          icon(MODE_ICON[mode.id] ?? icons.lock, "h-5 w-5"),
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "font-mono text-sm font-semibold",
                              heading,
                            )}
                          >
                            {mode.name}
                          </span>
                          {selected ? (
                            <span className="bg-brand-500/15 text-brand-600 dark:text-brand-300 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
                              {t("common.selected")}
                            </span>
                          ) : null}
                        </div>
                        <p
                          className={cn("mt-1 text-sm leading-relaxed", muted)}
                        >
                          {t(`safety.modes.${mode.id}.description`)}
                        </p>
                        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-600">
                          {t(`safety.modes.${mode.id}.detail`)}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </docs-reveal>

          <docs-reveal delay={0.1}>
            <div className={cn("sticky top-24 overflow-hidden p-1", card)}>
              <div className="bg-brand-50 rounded-[0.9rem] p-1.5 dark:bg-black/40">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="bg-g-blue h-2.5 w-2.5 rounded-full" />
                  <span className="bg-g-red h-2.5 w-2.5 rounded-full" />
                  <span className="bg-g-yellow h-2.5 w-2.5 rounded-full" />
                  <span className="ml-2 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                    {t("safety.dialogChrome")}
                  </span>
                </div>

                <div
                  data-dialog-panel
                  className="rounded-xl bg-white p-5 dark:bg-[#1e1f20]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="border-brand-950/10 bg-brand-50/70 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium text-zinc-600 dark:border-white/10 dark:bg-white/4 dark:text-zinc-300">
                      <span className="bg-brand-500 dark:bg-brand-400 h-1.5 w-1.5 rounded-full" />
                      {t(view.chipKey)}
                    </span>
                    <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                      {view.titleKey ? t(view.titleKey) : view.title}
                    </span>
                  </div>

                  <div className="border-brand-950/10 bg-brand-50/70 mt-5 rounded-lg border px-3.5 py-3 font-mono text-[12.5px] text-zinc-700 dark:border-white/10 dark:bg-black/40 dark:text-zinc-200">
                    <span className="text-brand-600 dark:text-brand-400">
                      ${" "}
                    </span>
                    {view.metaKey ? t(view.metaKey) : view.meta}
                  </div>

                  <ul className="mt-4 space-y-2">
                    {view.rows.map((row) => (
                      <li
                        data-dialog-row
                        className="border-brand-950/10 bg-brand-50/50 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 dark:border-white/6 dark:bg-white/2"
                      >
                        <span className="text-[13px] text-zinc-600 dark:text-zinc-300">
                          {t(row.labelKey)}
                        </span>
                        <span
                          className={cn(
                            "rounded-md border px-2 py-0.5 font-mono text-[11px]",
                            TONE[row.tone],
                          )}
                        >
                          {row.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className={cn("px-4 py-3 text-center text-xs", muted)}>
                {t(view.noteKey)}
              </p>
            </div>
          </docs-reveal>
        </div>

        <div
          className={cn(
            container,
            "mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3",
          )}
        >
          {SAFETY_FEATURES.map((feature, index) => (
            <docs-reveal delay={index * 0.06}>
              <div
                className={cn(
                  "h-full rounded-2xl border p-5 dark:bg-white/2",
                  line,
                )}
              >
                {unsafeHTML(
                  icon(
                    feature.icon,
                    "text-brand-500 dark:text-brand-400 h-5 w-5",
                  ),
                )}
                <h3 className={cn("mt-4 text-sm font-semibold", heading)}>
                  {t(`safety.features.${feature.id}.title`)}
                </h3>
                <p className={cn("mt-2 text-sm leading-relaxed", muted)}>
                  {t(`safety.features.${feature.id}.body`)}
                </p>
              </div>
            </docs-reveal>
          ))}
        </div>

        <docs-reveal delay={0.1} className={cn(container, "mt-4")}>
          <div
            className={cn(
              "bg-brand-50/60 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 rounded-2xl border px-6 py-5 text-sm dark:bg-white/2",
              line,
            )}
          >
            <span className="inline-flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              {unsafeHTML(icon(icons.hardDrive, "h-4 w-4 text-zinc-400"))}
              {t("safety.localNoteA")}
              <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                .yukino/
              </code>
            </span>
            <span className="inline-flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              {unsafeHTML(icon(icons.shieldCheck, "h-4 w-4 text-accent-600"))}
              {t("safety.localNoteB")}
            </span>
          </div>
        </docs-reveal>
      </Section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-safety": SafetyElement;
  }
}
