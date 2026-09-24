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
import {
  DOCS_URL,
  INSTALL_METHODS,
  QUICK_COMMANDS,
  REPO_URL,
  VERSION,
} from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { animateIn, animateOut, EASE } from "@/lib/motion";
import {
  container,
  focusRing,
  gradientText,
  gridPattern,
  heading,
  line,
  primaryButton,
  secondaryButton,
} from "@/lib/styles";
import { GithubIcon } from "./ui/github-icon";
import { Section, SectionHeader } from "./ui/section";
import "./ui/command-box";

@customElement("docs-install")
export class InstallElement extends LitElement {
  @state() private active: (typeof INSTALL_METHODS)[number]["id"] = "curl";

  private swapping = false;

  override createRenderRoot() {
    return this;
  }

  private async selectMethod(id: (typeof INSTALL_METHODS)[number]["id"]) {
    if (id === this.active || this.swapping) return;
    this.swapping = true;
    const panel = this.querySelector<HTMLElement>("[data-command-panel]");
    if (panel) {
      await animateOut(
        panel,
        { opacity: 0, y: -6 },
        { duration: 0.18, ease: EASE },
      );
    }
    this.active = id;
    await this.updateComplete;
    const next = this.querySelector<HTMLElement>("[data-command-panel]");
    if (next) {
      next.style.opacity = "0";
      animateIn(
        next,
        { opacity: [0, 1], y: [8, 0] },
        { duration: 0.25, ease: EASE },
      );
    }
    this.swapping = false;
  }

  override render() {
    const method =
      INSTALL_METHODS.find((item) => item.id === this.active) ??
      INSTALL_METHODS[0];

    return (
      <Section id="install" className="overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <div className={cn("absolute inset-0", gridPattern, "opacity-60")} />
          <div className="bg-brand-500/15 dark:bg-brand-600/20 absolute top-10 left-1/2 h-104 w-208 -translate-x-1/2 rounded-full blur-[130px]" />
        </div>

        <SectionHeader
          eyebrow="Install"
          title={
            <>
              Up and running in{" "}
              <span className={gradientText}>one command</span>
            </>
          }
          description="Requires Node.js 20 or newer. The installer picks the latest release; npm and pnpm work just as well."
        />

        <docs-reveal delay={0.08} className={cn(container, "relative mt-12")}>
          <div
            className={cn(
              "mx-auto max-w-3xl rounded-3xl p-6 sm:p-8",
              "shadow-card border bg-white/80 backdrop-blur-xl dark:bg-white/3 dark:shadow-none",
              line,
            )}
          >
            <div className="flex flex-wrap gap-2">
              {INSTALL_METHODS.map((item) => {
                const selected = item.id === this.active;
                return (
                  <button
                    type="button"
                    onClick={() => void this.selectMethod(item.id)}
                    className={cn(
                      "relative rounded-full px-4 py-2 text-sm font-medium transition-colors",
                      focusRing,
                      selected
                        ? "bg-brand-600 dark:bg-brand-300 dark:text-brand-950 text-white"
                        : "hover:bg-brand-500/10 hover:text-brand-900 text-zinc-500 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-white",
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
              <span className="ml-auto hidden self-center text-xs text-zinc-400 sm:block dark:text-zinc-500">
                {method.hint}
              </span>
            </div>

            <div className="mt-5">
              <div
                data-command-panel
                className="border-brand-950/10 bg-brand-50/70 flex items-center gap-3 rounded-2xl border p-4 dark:border-white/10 dark:bg-[#0c0f0a]"
              >
                <span className="text-brand-600 dark:text-brand-400 hidden font-mono text-sm select-none sm:block">
                  $
                </span>
                <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-zinc-700 dark:text-zinc-100">
                  {method.command}
                </code>
                <docs-copy-button
                  value={method.command}
                  buttonClass="hover:bg-brand-500/15 hover:text-brand-950 dark:hover:bg-white/10 dark:hover:text-white"
                />
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {QUICK_COMMANDS.map((item) => (
                <div
                  className={cn(
                    "rounded-xl border bg-white/70 px-4 py-3 dark:bg-white/2",
                    line,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        item.tone === "brand" && "bg-brand-500",
                        item.tone === "accent" && "bg-accent-400",
                        item.tone === "neutral" &&
                          "bg-zinc-400 dark:bg-zinc-600",
                      )}
                    />
                    <span className={cn("text-xs font-semibold", heading)}>
                      {item.label}
                    </span>
                  </div>
                  <code className="mt-2 block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    {item.command}
                  </code>
                </div>
              ))}
            </div>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                href={`${REPO_URL}#installation`}
                target="_blank"
                rel="noreferrer"
                className={cn(primaryButton, "w-full sm:w-auto", focusRing)}
              >
                {unsafeHTML(icon(icons.download, "h-4 w-4"))}
                Install Yukino
              </a>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className={cn(secondaryButton, "w-full sm:w-auto", focusRing)}
              >
                Read the docs
                {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className={cn(secondaryButton, "w-full sm:w-auto", focusRing)}
              >
                <GithubIcon className="h-4 w-4" />
                GitHub
                {unsafeHTML(icon(icons.star, "h-3.5 w-3.5 text-amber-400"))}
              </a>
            </div>

            <ul className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-400 dark:text-zinc-500">
              <li className="inline-flex items-center gap-1.5">
                {unsafeHTML(icon(icons.check, "h-3.5 w-3.5 text-emerald-500"))}
                Node.js 20+
              </li>
              <li className="inline-flex items-center gap-1.5">
                {unsafeHTML(icon(icons.check, "h-3.5 w-3.5 text-emerald-500"))}
                macOS, Linux &amp; Windows
              </li>
              <li className="inline-flex items-center gap-1.5">
                {unsafeHTML(icon(icons.check, "h-3.5 w-3.5 text-emerald-500"))}
                MIT licensed · {VERSION}
              </li>
            </ul>
          </div>
        </docs-reveal>

        <docs-reveal delay={0.12} className={cn(container, "relative mt-16")}>
          <div className="border-brand-500/15 bg-brand-50 relative overflow-hidden rounded-3xl border px-6 py-12 text-center sm:px-12 sm:py-16 dark:border-transparent dark:bg-white/4">
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
            >
              <div className="bg-brand-500/20 dark:bg-brand-500/25 absolute -top-24 left-1/2 h-72 w-160 -translate-x-1/2 rounded-full blur-[110px]" />
              <div className="bg-accent-500/15 dark:bg-accent-500/20 absolute right-0 -bottom-24 h-64 w-64 rounded-full blur-[110px]" />
            </div>
            <div className="relative">
              <h2
                className={cn(
                  "text-3xl font-semibold tracking-[-0.03em] sm:text-4xl",
                  heading,
                )}
              >
                Give Yukino a real task
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm text-zinc-600 sm:text-base dark:text-zinc-400">
                Point it at your repository, describe what you want, and watch
                it plan, edit and verify — with you in control of every write.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a
                  href="#top"
                  className={cn(primaryButton, "w-full sm:w-auto", focusRing)}
                >
                  Get started
                  {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
                </a>
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(secondaryButton, "w-full sm:w-auto", focusRing)}
                >
                  View documentation
                </a>
              </div>
            </div>
          </div>
        </docs-reveal>
      </Section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-install": InstallElement;
  }
}
