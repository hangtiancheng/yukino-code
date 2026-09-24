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
import { faqIds } from "@/lib/content";
import { LocaleController, t } from "@/lib/i18n";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { animateIn, animateOut, EASE } from "@/lib/motion";
import {
  container,
  focusRing,
  gradientText,
  heading,
  line,
  muted,
} from "@/lib/styles";
import { Section } from "./ui/section";

@customElement("docs-faq")
export class FaqElement extends LitElement {
  @state() private openIndex: number | null = 0;

  private generation = 0;

  locale = new LocaleController(this);

  override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    if (this.openIndex === null) return;
    const el = this.querySelector<HTMLElement>(
      `[data-answer="${this.openIndex}"]`,
    );
    if (el) {
      animateIn(
        el,
        { height: [0, "auto"], opacity: [0, 1] },
        { duration: 0.28, ease: EASE },
      );
    }
  }

  private async toggle(index: number) {
    const generation = ++this.generation;
    if (this.openIndex === index) {
      const el = this.querySelector<HTMLElement>(`[data-answer="${index}"]`);
      if (el) {
        await animateOut(
          el,
          { height: 0, opacity: 0 },
          { duration: 0.28, ease: EASE },
        );
      }
      if (generation === this.generation && this.openIndex === index) {
        this.openIndex = null;
      }
      return;
    }

    const previous = this.openIndex;
    if (previous !== null) {
      const old = this.querySelector<HTMLElement>(
        `[data-answer="${previous}"]`,
      );
      if (old) {
        await animateOut(
          old,
          { height: 0, opacity: 0 },
          { duration: 0.2, ease: EASE },
        );
      }
      if (generation !== this.generation) return;
    }

    this.openIndex = index;
    await this.updateComplete;
    if (generation !== this.generation) return;
    const el = this.querySelector<HTMLElement>(`[data-answer="${index}"]`);
    if (el) {
      animateIn(
        el,
        { height: [0, "auto"], opacity: [0, 1] },
        { duration: 0.28, ease: EASE },
      );
    }
  }

  override render() {
    return (
      <Section id="faq">
        <div
          className={cn(
            container,
            "grid grid-cols-1 gap-12 lg:grid-cols-[0.85fr_1.15fr]",
          )}
        >
          <div className="lg:sticky lg:top-28 lg:self-start">
            <docs-reveal>
              <span className="border-brand-500/25 bg-brand-50/80 text-brand-700 dark:border-brand-300/15 dark:text-brand-200 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tracking-wide dark:bg-white/3">
                {t("faq.eyebrow")}
              </span>
              <h2
                className={cn(
                  "mt-5 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl",
                  heading,
                )}
              >
                {t("faq.titleA")}
                <br />
                <span className={gradientText}>{t("faq.titleHighlight")}</span>
              </h2>
              <p
                className={cn(
                  "mt-5 text-sm leading-relaxed sm:text-base",
                  muted,
                )}
              >
                {t("faq.bodyA")}{" "}
                <code className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
                  /help
                </code>{" "}
                {t("faq.bodyB")}
              </p>
            </docs-reveal>
          </div>

          <div className="space-y-3">
            {faqIds.map((id, index) => {
              const isOpen = this.openIndex === index;
              return (
                <docs-reveal delay={index * 0.05}>
                  <div
                    className={cn(
                      "overflow-hidden rounded-2xl border transition-colors",
                      isOpen
                        ? "border-brand-500/30 bg-brand-500/4"
                        : cn("bg-white dark:bg-white/2", line),
                    )}
                  >
                    <button
                      type="button"
                      id={`faq-q-${index}`}
                      onClick={() => void this.toggle(index)}
                      aria-expanded={isOpen}
                      aria-controls={`faq-a-${index}`}
                      className={cn(
                        "flex w-full items-center justify-between gap-4 px-5 py-4 text-left",
                        focusRing,
                      )}
                    >
                      <span
                        className={cn("text-[15px] font-semibold", heading)}
                      >
                        {t(`faq.items.${id}.question`)}
                      </span>
                      <span
                        className={cn(
                          "grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors",
                          isOpen
                            ? "bg-brand-500 text-white"
                            : "bg-brand-500/10 text-zinc-500 dark:bg-white/6 dark:text-zinc-400",
                        )}
                      >
                        {unsafeHTML(
                          isOpen
                            ? icon(icons.minus, "h-3.5 w-3.5")
                            : icon(icons.plus, "h-3.5 w-3.5"),
                        )}
                      </span>
                    </button>
                    {isOpen ? (
                      <div
                        data-answer={String(index)}
                        id={`faq-a-${index}`}
                        role="region"
                        aria-labelledby={`faq-q-${index}`}
                        className="overflow-hidden opacity-0"
                      >
                        <p
                          className={cn(
                            "px-5 pb-5 text-sm leading-relaxed",
                            muted,
                          )}
                        >
                          {t(`faq.items.${id}.answer`)}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </docs-reveal>
              );
            })}
          </div>
        </div>
      </Section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-faq": FaqElement;
  }
}
