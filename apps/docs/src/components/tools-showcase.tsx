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

import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { slashCommands, tools } from "@/lib/content";
import type { ToolItem } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { chip, container, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

const GROUPS: Array<ToolItem["group"]> = [
  "Files",
  "Shell",
  "Search",
  "Orchestrate",
  "Teams",
  "Integrate",
];

function Marquee({ items, reverse }: { items: string[]; reverse?: boolean }) {
  const doubled = [...items, ...items];
  return (
    // Decorative: every name also appears in the grouped cards below, so skip
    // the duplicated (and animated) strip for assistive tech.
    <div
      aria-hidden="true"
      className="flex overflow-hidden mask-[linear-gradient(to_right,transparent,black_10%,black_90%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]"
    >
      <div
        className={cn(
          "flex w-max shrink-0 items-center gap-3 pr-3",
          reverse
            ? "animate-marquee-slow [animation-direction:reverse]"
            : "animate-marquee",
        )}
      >
        {doubled.map((name) => (
          <span className="border-brand-950/8 inline-flex items-center gap-2 rounded-xl border bg-white px-3.5 py-2 font-mono text-xs text-zinc-600 dark:border-white/8 dark:bg-white/3 dark:text-zinc-400">
            <span className="bg-brand-500/70 h-1.5 w-1.5 rounded-full" />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ToolsShowcase() {
  const names = tools.map((tool) => tool.name);
  const half = Math.ceil(names.length / 2);

  return (
    <Section id="tools" className="bg-brand-50/50 dark:bg-white/1.5">
      <SectionHeader
        eyebrow="Toolbelt"
        title={
          <>
            A real set of tools,{" "}
            <span className="text-brand-500">not just chat</span>
          </>
        }
        description="Read and write files, run shells, search the tree, fetch the web, spawn teammates and call MCP servers — each one permission-checked before it runs."
      />

      <docs-reveal delay={0.08} className="mt-12 space-y-3">
        <Marquee items={names.slice(0, half)} />
        <Marquee items={names.slice(half)} reverse />
      </docs-reveal>

      <div
        className={cn(
          container,
          "mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
        )}
      >
        {GROUPS.map((group, index) => (
          <docs-reveal delay={index * 0.05}>
            <div
              className={cn(
                "h-full rounded-2xl border bg-white p-5 dark:bg-white/2",
                line,
              )}
            >
              <h3 className={cn("text-sm font-semibold", heading)}>{group}</h3>
              <ul className="mt-4 space-y-2">
                {tools
                  .filter((tool) => tool.group === group)
                  .map((tool) => (
                    <li className="flex items-center gap-2">
                      {unsafeHTML(
                        icon(
                          tool.icon,
                          "text-brand-500 dark:text-brand-400 h-3.5 w-3.5 shrink-0",
                        ),
                      )}
                      <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {tool.name}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          </docs-reveal>
        ))}
      </div>

      <docs-reveal delay={0.1} className={cn(container, "mt-14")}>
        <div
          className={cn(
            "rounded-2xl border bg-white p-6 sm:p-8 dark:bg-white/2",
            line,
          )}
        >
          <div className="flex items-center gap-3">
            <span className="bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300 grid h-10 w-10 place-items-center rounded-xl">
              {unsafeHTML(icon(icons.command, "h-5 w-5"))}
            </span>
            <div>
              <h3 className={cn("text-base font-semibold", heading)}>
                Slash commands
              </h3>
              <p className={cn("text-sm", muted)}>
                Drive the session without leaving the prompt.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {slashCommands.map((command) => (
              <span className={cn(chip, "text-[11px]")}>{command}</span>
            ))}
          </div>
        </div>
      </docs-reveal>
    </Section>
  );
}
