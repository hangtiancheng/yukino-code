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

import { LitElement, customElement, property } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { animate, stagger } from "motion";
import { cn } from "@/lib/cn";
import {
  INSTALL_METHODS,
  QUICK_COMMANDS,
  REPO_URL,
  VERSION,
  stats,
} from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { EASE, prefersReducedMotion } from "@/lib/motion";
import {
  container,
  focusRing,
  gradientText,
  gridPattern,
  heading,
  muted,
  primaryButton,
  secondaryButton,
} from "@/lib/styles";
import { CommandBar } from "./ui/command-box";
import { GithubIcon } from "./ui/github-icon";

@customElement("docs-hero")
export class HeroElement extends LitElement {
  @property() docsUrl = "";

  override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    const items = Array.from(
      this.querySelectorAll<HTMLElement>("[data-stagger]"),
    );
    if (prefersReducedMotion()) {
      for (const el of items) el.style.opacity = "1";
      return;
    }
    animate(
      items,
      { opacity: [0, 1], y: [24, 0] },
      { duration: 0.7, delay: stagger(0.08, { startDelay: 0.05 }), ease: EASE },
    );
  }

  override render() {
    const install = INSTALL_METHODS[0].command;

    return (
      <section
        id="top"
        className="relative overflow-hidden pt-32 pb-16 sm:pt-40 sm:pb-24"
      >
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <div
            className={cn(
              "absolute inset-0",
              gridPattern,
              "mask-[radial-gradient(ellipse_65%_55%_at_50%_0%,black,transparent)] [-webkit-mask-image:radial-gradient(ellipse_65%_55%_at_50%_0%,black,transparent)]",
            )}
          />
          <div className="animate-drift bg-brand-500/20 dark:bg-brand-600/25 absolute -top-52 left-1/2 h-136 w-5xl -translate-x-1/2 rounded-full blur-[130px]" />
          <div className="animate-floaty bg-accent-400/20 dark:bg-accent-500/15 absolute top-32 -right-40 h-104 w-104 rounded-full blur-[120px]" />
          <div className="animate-floaty bg-brand-400/15 absolute top-64 -left-32 h-88 w-88 rounded-full blur-[120px] [animation-delay:1.5s]" />
        </div>

        <div className={cn(container, "relative text-center")}>
          <div data-stagger className="flex justify-center opacity-0">
            <a
              href={this.docsUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "group border-brand-500/20 bg-brand-500/[0.07] text-brand-700 hover:border-brand-500/40 hover:bg-brand-500/12 dark:border-brand-300/20 dark:bg-brand-400/9 dark:text-brand-200 inline-flex flex-wrap items-center justify-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium backdrop-blur transition-colors sm:text-[13px]",
                focusRing,
              )}
            >
              {unsafeHTML(icon(icons.sparkles, "h-3.5 w-3.5"))}
              <span className="font-semibold">{VERSION} is out</span>
              <span className="opacity-80">
                — ACP, observability &amp; web fetch
              </span>
              <span className="inline-flex items-center gap-1 font-semibold">
                Read the docs
                {unsafeHTML(
                  icon(
                    icons.arrowRight,
                    "h-3 w-3 transition-transform group-hover:translate-x-0.5",
                  ),
                )}
              </span>
            </a>
          </div>

          <h1
            data-stagger
            className={cn(
              "mx-auto mt-8 max-w-4xl text-4xl leading-[1.05] font-semibold tracking-[-0.04em] text-balance opacity-0 sm:text-6xl md:text-7xl",
              heading,
            )}
          >
            The <span className={gradientText}>coding agent</span>
            <br className="hidden sm:block" /> that lives in your terminal
          </h1>

          <p
            data-stagger
            className={cn(
              "mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty opacity-0 sm:text-lg",
              muted,
            )}
          >
            Yukino connects to any LLM, edits files, runs commands and
            orchestrates multi-agent workflows — all from a single CLI that
            stays out of your way.
          </p>

          <div data-stagger className="mx-auto mt-9 max-w-xl opacity-0">
            <CommandBar command={install} leading="curl" />
          </div>

          <div
            data-stagger
            className="mt-6 flex flex-col items-center justify-center gap-3 opacity-0 sm:flex-row"
          >
            <a
              href="#install"
              className={cn(primaryButton, "w-full sm:w-auto", focusRing)}
            >
              Get started
              {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(secondaryButton, "w-full sm:w-auto", focusRing)}
            >
              <GithubIcon className="h-4 w-4" />
              Star on GitHub
              {unsafeHTML(icon(icons.star, "h-3.5 w-3.5 text-amber-400"))}
            </a>
          </div>

          <ul
            data-stagger
            className="mt-10 flex flex-wrap items-center justify-center gap-2 opacity-0"
          >
            {QUICK_COMMANDS.map((item) => (
              <li className="border-brand-950/8 flex items-center gap-2 rounded-full border bg-white/60 px-3 py-1.5 font-mono text-[11px] text-zinc-600 backdrop-blur sm:text-xs dark:border-white/8 dark:bg-white/3 dark:text-zinc-400">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    item.tone === "brand" && "bg-brand-500",
                    item.tone === "accent" && "bg-accent-400",
                    item.tone === "neutral" && "bg-zinc-400 dark:bg-zinc-600",
                  )}
                />
                <span className="text-zinc-400 dark:text-zinc-500">
                  {item.command}
                </span>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>

          <dl
            data-stagger
            className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-8 opacity-0 sm:grid-cols-4"
          >
            {stats.map((stat) => (
              <div className="flex flex-col items-center gap-1">
                <dt
                  className={cn(
                    "text-3xl font-semibold tracking-tight sm:text-4xl",
                    heading,
                  )}
                >
                  {stat.value}
                </dt>
                <dd className="text-xs font-medium tracking-[0.14em] text-zinc-400 uppercase dark:text-zinc-500">
                  {stat.label}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-hero": HeroElement;
  }
}
