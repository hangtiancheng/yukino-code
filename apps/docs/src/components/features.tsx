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
import {
  agentCards,
  features,
  observabilityList,
  permissionModes,
  providerList,
  tools,
} from "@/lib/content";
import type { Feature, ObsBadge } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import type { MessageKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import {
  card,
  cardHover,
  chip,
  container,
  heading,
  line,
  muted,
} from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

function SpotlightCard({
  children,
  className,
}: {
  children?: unknown;
  className?: string;
}) {
  const onMove = (event: MouseEvent) => {
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  return (
    <div
      onMouseMove={onMove}
      className={cn(
        "group relative overflow-hidden",
        card,
        cardHover,
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(260px_circle_at_var(--spot-x,50%)_var(--spot-y,50%),rgba(66,133,244,0.13),transparent_70%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

const ACCENT_TILE: Record<NonNullable<Feature["accent"]>, string> = {
  brand:
    "bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300",
  accent:
    "bg-accent-500/12 text-accent-600 dark:bg-accent-400/12 dark:text-accent-300",
  neutral:
    "bg-[#f1f3f4] text-[#3c4043] dark:bg-white/[0.06] dark:text-[#e8eaed]",
};

const OBS_DETAIL_KEY: Record<ObsBadge["id"], MessageKey> = {
  otel: "common.obsOtel",
  langfuse: "common.obsLangfuse",
  sentry: "common.obsSentry",
};

function Decor({ kind }: { kind: NonNullable<Feature["decor"]> }) {
  if (kind === "providers") {
    return (
      <div className="mt-6 flex flex-wrap gap-2">
        {providerList.map((provider) => (
          <span
            className={cn(
              "border-brand-950/8 bg-brand-50/60 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 dark:border-white/8 dark:bg-white/3 dark:text-zinc-400",
            )}
          >
            <span className="bg-brand-500 h-1.5 w-1.5 rounded-full" />
            {provider.name}
          </span>
        ))}
      </div>
    );
  }

  if (kind === "tools") {
    return (
      <div className="mt-6 flex flex-wrap gap-2">
        {tools.slice(0, 6).map((tool) => (
          <span className={chip}>
            {unsafeHTML(icon(tool.icon, "text-brand-500 h-3 w-3"))}
            {tool.name}
          </span>
        ))}
        <span className={chip}>+{tools.length - 6}</span>
      </div>
    );
  }

  if (kind === "sandbox") {
    return (
      <div className="mt-6 flex flex-wrap gap-2">
        {permissionModes.map((mode) => (
          <span className={chip}>
            {unsafeHTML(icon(icons.shieldCheck, "text-brand-500 h-3 w-3"))}
            {mode.mode}
          </span>
        ))}
      </div>
    );
  }

  if (kind === "obs") {
    return (
      <div className="mt-6 flex flex-wrap gap-2">
        {observabilityList.map((backend) => (
          <span
            className={cn(
              "border-brand-950/8 bg-brand-50/60 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 dark:border-white/8 dark:bg-white/3 dark:text-zinc-400",
            )}
          >
            <span className="bg-brand-500 h-1.5 w-1.5 rounded-full" />
            {backend.name}
            <span className="text-zinc-400 dark:text-zinc-500">
              {t(OBS_DETAIL_KEY[backend.id])}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {agentCards.map((agent) => (
        <span className="border-brand-950/8 inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 dark:border-white/8 dark:bg-white/3 dark:text-zinc-300">
          {unsafeHTML(icon(agent.icon, "text-brand-500 h-3 w-3"))}
          {agent.name}
        </span>
      ))}
      <span className="border-brand-950/8 inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 dark:border-white/8 dark:bg-white/3 dark:text-zinc-300">
        {unsafeHTML(icon(icons.bot, "text-accent-500 h-3 w-3"))}
        {t("features.teammates")}
      </span>
    </div>
  );
}

export function Features() {
  return (
    <Section id="features">
      <SectionHeader
        eyebrow={t("features.eyebrow")}
        title={
          <>
            {t("features.titleA")}
            <br className="hidden sm:block" /> {t("features.titleB")}
          </>
        }
        description={t("features.description")}
      />

      <div
        className={cn(
          container,
          "mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {features.map((feature, index) => (
          <docs-reveal
            delay={(index % 3) * 0.06}
            className={cn(feature.span === "wide" && "lg:col-span-2")}
          >
            <SpotlightCard className="h-full p-6 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <span
                  className={cn(
                    "grid h-11 w-11 place-items-center rounded-xl",
                    ACCENT_TILE[feature.accent ?? "brand"],
                  )}
                >
                  {unsafeHTML(icon(feature.icon, "h-5 w-5"))}
                </span>
                <span className="opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  {unsafeHTML(
                    icon(
                      icons.sparkle,
                      "h-4 w-4 text-brand-400/60 dark:text-zinc-600",
                    ),
                  )}
                </span>
              </div>
              <h3
                className={cn(
                  "mt-5 text-lg font-semibold tracking-[-0.02em]",
                  heading,
                )}
              >
                {t(`features.items.${feature.id}.title`)}
              </h3>
              <p className={cn("mt-2.5 text-sm leading-relaxed", muted)}>
                {t(`features.items.${feature.id}.description`)}
              </p>
              {feature.decor ? <Decor kind={feature.decor} /> : null}
            </SpotlightCard>
          </docs-reveal>
        ))}
      </div>

      <docs-reveal delay={0.1} className={cn(container, "mt-4")}>
        <div
          className={cn(
            "bg-brand-50/60 flex flex-col items-start justify-between gap-4 rounded-2xl border px-6 py-5 sm:flex-row sm:items-center dark:bg-white/2",
            line,
          )}
        >
          <div className="flex items-center gap-3">
            <span className="bg-brand-700 dark:bg-brand-300 dark:text-brand-950 grid h-9 w-9 place-items-center rounded-lg text-white">
              {unsafeHTML(icon(icons.sparkle, "h-4 w-4"))}
            </span>
            <p className={cn("text-sm", muted)}>{t("features.footnote")}</p>
          </div>
          <a
            href="#tools"
            className="text-brand-600 hover:text-brand-500 dark:text-brand-300 dark:hover:text-brand-200 text-sm font-semibold transition-colors"
          >
            {t("features.exploreTools")}
          </a>
        </div>
      </docs-reveal>
    </Section>
  );
}
