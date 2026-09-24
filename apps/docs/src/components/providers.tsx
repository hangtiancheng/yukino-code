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
import { t } from "@/lib/i18n";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { container, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

const PROTOCOLS = [
  {
    id: "anthropic",
    icon: icons.blocks,
    name: "anthropic",
    base: "api.anthropic.com",
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai",
    icon: icons.terminal,
    name: "openai",
    base: "api.openai.com",
    env: "OPENAI_API_KEY",
  },
  {
    id: "openaiCompat",
    icon: icons.slidersHorizontal,
    name: "openai-compat",
    base: "your-gateway",
    env: "OPENAI_API_KEY",
  },
] as const;

const YAML: Array<
  Array<{ text: string; tone?: "key" | "str" | "comment" | "num" }>
> = [
  [{ text: "providers:" }],
  [{ text: "  - name: " }, { text: "anthropic", tone: "str" }],
  [{ text: "    protocol: " }, { text: "anthropic", tone: "str" }],
  [
    { text: "    base_url: " },
    { text: "https://api.anthropic.com", tone: "str" },
  ],
  [{ text: "    model: " }, { text: "claude-sonnet-4", tone: "str" }],
  [{ text: "    thinking: " }, { text: "high", tone: "str" }],
  [{ text: "    # api_key falls back to $ANTHROPIC_API_KEY", tone: "comment" }],
  [],
  [{ text: "permission_mode: " }, { text: "default", tone: "str" }],
  [],
  [{ text: "sandbox:" }],
  [{ text: "  enabled: " }, { text: "true", tone: "num" }],
  [{ text: "  auto_allow: " }, { text: "false", tone: "num" }],
];

export function Providers() {
  return (
    <Section id="providers" className="bg-brand-50/50 dark:bg-white/1.5">
      <SectionHeader
        eyebrow={t("providers.eyebrow")}
        title={
          <>
            {t("providers.titleA")}{" "}
            <span className="text-brand-500">
              {t("providers.titleHighlight")}
            </span>
          </>
        }
        description={t("providers.description")}
      />

      <div
        className={cn(container, "mt-14 grid grid-cols-1 gap-6 lg:grid-cols-2")}
      >
        <docs-reveal>
          <div className="flex flex-col gap-4">
            {PROTOCOLS.map((protocol) => (
              <div
                className={cn(
                  "flex items-start gap-4 rounded-2xl border bg-white p-5 dark:bg-white/2",
                  line,
                )}
              >
                <span className="bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300 grid h-11 w-11 shrink-0 place-items-center rounded-xl">
                  {unsafeHTML(icon(protocol.icon, "h-5 w-5"))}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn("font-mono text-sm font-semibold", heading)}
                    >
                      {protocol.name}
                    </span>
                    <span className="bg-brand-500/10 rounded-md px-2 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-white/6 dark:text-zinc-400">
                      {protocol.base}
                    </span>
                  </div>
                  <p className={cn("mt-1.5 text-sm leading-relaxed", muted)}>
                    {t(`providers.protocols.${protocol.id}.note`)}
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                    {unsafeHTML(icon(icons.keyRound, "h-3 w-3"))}
                    {protocol.env}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </docs-reveal>

        <docs-reveal delay={0.1}>
          <div
            className={cn(
              "shadow-card bg-brand-50/70 overflow-hidden rounded-2xl border",
              "border-brand-950/10 dark:border-white/10 dark:bg-[#1e1f20] dark:shadow-none",
            )}
          >
            <div className="border-brand-950/10 flex items-center justify-between border-b px-5 py-3 dark:border-white/8">
              <span className="inline-flex items-center gap-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="bg-brand-500 h-2 w-2 rounded-full" />
                ~/.yukino/config.yaml
              </span>
              <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
                yaml
              </span>
            </div>
            <pre className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.75]">
              <code>
                {YAML.map((lineItems, lineIndex) => (
                  <div className="flex min-h-[1.4em]">
                    <span className="mr-4 w-6 shrink-0 text-right text-zinc-300 select-none dark:text-zinc-700">
                      {lineIndex + 1}
                    </span>
                    <span>
                      {lineItems.length === 0 ? (
                        <span>&nbsp;</span>
                      ) : (
                        lineItems.map((token) => (
                          <span
                            className={cn(
                              "text-zinc-800 dark:text-zinc-200",
                              token.tone === "comment" &&
                                "text-zinc-400 italic dark:text-zinc-500",
                              token.tone === "str" &&
                                "text-accent-700 dark:text-accent-300",
                              token.tone === "num" &&
                                "text-g-yellow dark:text-[#fdd663]",
                              token.tone === "key" &&
                                "text-brand-700 dark:text-brand-300",
                            )}
                          >
                            {token.text}
                          </span>
                        ))
                      )}
                    </span>
                  </div>
                ))}
              </code>
            </pre>
          </div>
        </docs-reveal>
      </div>
    </Section>
  );
}
