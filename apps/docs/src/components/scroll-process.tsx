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
import { scrollInfo, springValue } from "motion";
import { cn } from "@/lib/cn";
import { LocaleController, t } from "@/lib/i18n";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { animateIn, animateOut } from "@/lib/motion";
import { focusRing } from "@/lib/styles";

@customElement("docs-scroll-progress")
export class ScrollProgressElement extends LitElement {
  @state() private button: "hidden" | "entering" | "shown" | "leaving" =
    "hidden";

  private stopScroll?: () => void;

  locale = new LocaleController(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    const progress = springValue<number>(0, {
      stiffness: 140,
      damping: 24,
      mass: 0.3,
    });
    progress.on("change", (value) => {
      const bar = this.querySelector<HTMLElement>("[data-progress-bar]");
      if (bar) bar.style.scale = `${value} 1`;
    });
    this.stopScroll = scrollInfo(({ y }) => {
      progress.set(y.progress);
      const shouldShow = window.scrollY > 800;
      if (shouldShow && this.button === "hidden") void this.showButton();
      if (!shouldShow && this.button === "shown") void this.hideButton();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopScroll?.();
  }

  private async showButton() {
    this.button = "entering";
    await this.updateComplete;
    const el = this.querySelector<HTMLElement>("[data-back-top]");
    if (el) {
      animateIn(
        el,
        { opacity: [0, 1], y: [12, 0], scale: [0.9, 1] },
        { duration: 0.22 },
      );
    }
    this.button = "shown";
  }

  private async hideButton() {
    this.button = "leaving";
    const el = this.querySelector<HTMLElement>("[data-back-top]");
    if (el) {
      await animateOut(
        el,
        { opacity: 0, y: 12, scale: 0.9 },
        { duration: 0.22 },
      );
    }
    if (this.button === "leaving") this.button = "hidden";
  }

  override render() {
    return (
      <>
        <div
          data-progress-bar
          className="fixed inset-x-0 top-0 z-60 h-0.5 origin-left scale-x-0 bg-linear-to-r from-[#4285f4] via-[#9b72cb] to-[#d96570]"
          aria-hidden="true"
        />
        {this.button !== "hidden" ? (
          <button
            data-back-top
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label={t("common.backToTop")}
            className={cn(
              "shadow-soft hover:text-brand-600 dark:hover:text-brand-300 border-brand-950/8 fixed right-4 bottom-4 z-50 grid h-11 w-11 place-items-center rounded-full border bg-white/85 text-zinc-700 opacity-0 backdrop-blur transition-colors sm:right-6 sm:bottom-6 dark:border-white/10 dark:bg-white/6 dark:text-zinc-200",
              focusRing,
            )}
          >
            {unsafeHTML(icon(icons.arrowUp, "h-4 w-4"))}
          </button>
        ) : null}
      </>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-scroll-progress": ScrollProgressElement;
  }
}
