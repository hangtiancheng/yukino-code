import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { runModes } from "@/lib/content";
import { icon } from "@/lib/icon";
import { t } from "@/lib/i18n";
import { card, cardHover, container, heading, line, muted } from "@/lib/styles";
import { Section, SectionHeader } from "./ui/section";

export function Modes() {
  return (
    <Section id="modes" className="bg-brand-50/50 dark:bg-white/1.5">
      <SectionHeader
        eyebrow={t("modes.eyebrow")}
        title={
          <>
            {t("modes.titleA")}
            <br className="hidden sm:block" /> {t("modes.titleHighlight")}
          </>
        }
        description={t("modes.description")}
      />

      <div
        className={cn(
          container,
          "mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {runModes.map((mode, index) => (
          <docs-reveal
            delay={(index % 3) * 0.06}
            className={cn(mode.wide && "lg:col-span-2")}
          >
            <div
              className={cn(
                "group relative h-full overflow-hidden p-6 sm:p-7",
                card,
                cardHover,
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <span
                  className={cn(
                    "grid h-11 w-11 place-items-center rounded-xl",
                    mode.wide
                      ? "bg-brand-500/12 text-brand-600 dark:bg-brand-400/12 dark:text-brand-300"
                      : "bg-[#f1f3f4] text-[#3c4043] dark:bg-white/[0.06] dark:text-[#e8eaed]",
                  )}
                >
                  {unsafeHTML(icon(mode.icon, "h-5 w-5"))}
                </span>
                {mode.wide ? (
                  <span className="border-brand-950/8 bg-brand-50/60 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-zinc-600 dark:border-white/8 dark:bg-white/3 dark:text-zinc-400">
                    <span className="bg-brand-500 h-1.5 w-1.5 rounded-full" />
                    {t("modes.defaultChip")}
                  </span>
                ) : null}
              </div>

              <h3
                className={cn(
                  "mt-5 text-lg font-semibold tracking-[-0.02em]",
                  heading,
                )}
              >
                {t(`modes.items.${mode.id}.tagline`)}
              </h3>

              <code
                className={cn(
                  "border-brand-950/8 bg-brand-50/60 mt-3 inline-flex max-w-full items-center gap-1.5 overflow-x-auto rounded-lg border px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap text-zinc-600 dark:border-white/8 dark:bg-white/3 dark:text-zinc-400",
                )}
              >
                <span className="text-brand-500">$</span>
                {mode.command}
              </code>

              <p className={cn("mt-3 text-sm leading-relaxed", muted)}>
                {t(`modes.items.${mode.id}.description`)}
              </p>

              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 h-px",
                  line,
                )}
              />
            </div>
          </docs-reveal>
        ))}
      </div>
    </Section>
  );
}
