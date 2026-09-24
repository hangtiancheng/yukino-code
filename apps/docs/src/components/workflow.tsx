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
import { workflowSteps } from "@/lib/content";
import { icon } from "@/lib/icon";
import { container, gradientText, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

export function Workflow() {
  return (
    <Section id="workflow">
      <SectionHeader
        eyebrow="Workflow"
        title={
          <>
            From prompt to <span className={gradientText}>ship</span>
          </>
        }
        description="No new mental model to learn. Describe the task, review what matters, and keep a rewind button for everything else."
      />

      <div className={cn(container, "mt-16")}>
        <div className="relative grid grid-cols-1 gap-y-10 sm:grid-cols-2 sm:gap-x-8 lg:grid-cols-4">
          <div
            className="via-brand-500/40 pointer-events-none absolute inset-x-0 top-6 hidden h-px bg-linear-to-r from-transparent to-transparent lg:block"
            aria-hidden="true"
          />
          {workflowSteps.map((step, index) => (
            <docs-reveal delay={index * 0.08} className="relative">
              <div className="flex flex-col">
                <div className="flex items-center gap-3">
                  <span className="shadow-soft border-brand-950/8 relative grid h-12 w-12 place-items-center rounded-2xl border bg-white dark:border-white/8 dark:bg-[#0e110c] dark:shadow-none">
                    {unsafeHTML(
                      icon(
                        step.icon,
                        "text-brand-500 dark:text-brand-400 h-5 w-5",
                      ),
                    )}
                    <span className="bg-brand-700 dark:bg-brand-300 dark:text-brand-950 absolute -top-2 -right-2 grid h-6 w-6 place-items-center rounded-full font-mono text-[10px] font-semibold text-white">
                      {step.step}
                    </span>
                  </span>
                </div>
                <h3
                  className={cn(
                    "mt-5 text-base font-semibold tracking-[-0.02em]",
                    heading,
                  )}
                >
                  {step.title}
                </h3>
                <p className={cn("mt-2 text-sm leading-relaxed", muted)}>
                  {step.description}
                </p>
              </div>
            </docs-reveal>
          ))}
        </div>

        <docs-reveal delay={0.12} className="mt-14">
          <div
            className={cn(
              "bg-brand-50/60 grid grid-cols-1 gap-6 rounded-2xl border p-6 sm:grid-cols-3 sm:p-8 dark:bg-white/2",
              line,
            )}
          >
            <div className="sm:col-span-1">
              <p className={cn("text-sm font-semibold", heading)}>
                Built to be interrupted
              </p>
              <p className={cn("mt-2 text-sm leading-relaxed", muted)}>
                Ctrl+C clears the prompt or stops a stream. Checkpoints let you
                rewind a turn, fork a session, or hand the thread to a teammate.
              </p>
            </div>
            <dl className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-3">
              {[
                { term: "Ctrl+O", detail: "Toggle full tool output" },
                { term: "Shift+Tab", detail: "Cycle permission modes" },
                { term: "Ctrl+T", detail: "Open the teams overlay" },
              ].map((item) => (
                <div
                  className={cn(
                    "rounded-xl border bg-white px-4 py-3 dark:bg-white/2",
                    line,
                  )}
                >
                  <dt className="text-brand-600 dark:text-brand-300 font-mono text-xs font-semibold">
                    {item.term}
                  </dt>
                  <dd className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {item.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </docs-reveal>
      </div>
    </Section>
  );
}
