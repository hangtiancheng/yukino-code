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

import { LitElement, customElement, property, state } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { focusRing } from "@/lib/styles";

@customElement("docs-copy-button")
export class CopyButtonElement extends LitElement {
  @property() value = "";
  @property() label = "Copy";
  @property() buttonClass?: string;
  @state() private copied = false;

  private timer: number | null = null;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer !== null) window.clearTimeout(this.timer);
  }

  private async copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this.value);
      } else {
        const el = document.createElement("textarea");
        el.value = this.value;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        // Deprecated execCommand() fallback — only reached when the async
        // Clipboard API is unavailable (handled above).
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      this.copied = true;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.copied = false;
      }, 1900);
    } catch {
      /* clipboard unavailable */
    }
  }

  override render() {
    return (
      <button
        type="button"
        onClick={() => void this.copy()}
        aria-label={this.copied ? "Copied" : this.label}
        className={cn(
          "group hover:bg-brand-500/10 hover:text-brand-950 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white",
          focusRing,
          this.buttonClass,
        )}
      >
        {this.copied
          ? unsafeHTML(icon(icons.check, "h-4 w-4 text-emerald-500"))
          : unsafeHTML(
              icon(
                icons.copy,
                "h-4 w-4 transition-transform group-hover:scale-105",
              ),
            )}
      </button>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-copy-button": CopyButtonElement;
  }
}

export function CommandBar({
  command,
  leading,
  className,
}: {
  command: string;
  leading?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shadow-soft border-brand-950/10 flex items-center gap-2 rounded-2xl border bg-white/85 p-1.5 pl-2 backdrop-blur dark:border-white/10 dark:bg-white/4 dark:shadow-none",
        className,
      )}
    >
      {leading ? (
        <span className="bg-brand-700 dark:bg-brand-300 dark:text-brand-950 hidden shrink-0 items-center rounded-xl px-3.5 py-2 text-xs font-semibold text-white sm:inline-flex">
          {leading}
        </span>
      ) : null}
      <code className="flex-1 truncate px-1 font-mono text-[13px] text-zinc-700 dark:text-zinc-300">
        {command}
      </code>
      <docs-copy-button value={command} />
    </div>
  );
}
