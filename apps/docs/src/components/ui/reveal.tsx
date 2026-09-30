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
