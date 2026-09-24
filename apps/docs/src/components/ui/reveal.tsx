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

import { LitElement, customElement, html, property } from "@yukino.js/lit-jsx";
import { animate } from "motion";
import { EASE, onceInView, prefersReducedMotion } from "@/lib/motion";

@customElement("docs-reveal")
export class RevealElement extends LitElement {
  @property({ type: Number }) delay = 0;
  @property({ type: Number }) distance = 22;

  private stopReveal?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    if (prefersReducedMotion()) return;
    this.style.opacity = "0";
    this.style.transform = `translateY(${this.distance}px)`;
  }

  override firstUpdated() {
    if (prefersReducedMotion()) return;
    this.stopReveal = onceInView(
      this,
      () => {
        animate(
          this,
          { opacity: [0, 1], y: [this.distance, 0] },
          { duration: 0.65, delay: this.delay, ease: EASE },
        );
      },
      "-70px",
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopReveal?.();
  }

  override render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-reveal": RevealElement;
  }
}
