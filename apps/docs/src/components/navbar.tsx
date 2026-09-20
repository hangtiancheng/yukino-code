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
import { navLinks } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { animateIn, animateOut, EASE } from "@/lib/motion";
import {
  container,
  focusRing,
  ghostButton,
  glass,
  heading,
  line,
  muted,
  primaryButton,
} from "@/lib/styles";
import { GithubIcon } from "./ui/github-icon";
import { Logo } from "./ui/logo";

type Theme = "light" | "dark";

const STORAGE_KEY = "yukino-theme";

function readInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

@customElement("docs-navbar")
export class NavbarElement extends LitElement {
  @property() repoUrl = "";
  @state() private theme: Theme = readInitialTheme();
  @state() private scrolled = false;
  @state() private menu: "closed" | "opening" | "open" | "closing" = "closed";

  override createRenderRoot() {
    return this;
  }

  private onScroll = () => {
    this.scrolled = window.scrollY > 8;
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("scroll", this.onScroll, { passive: true });
    this.onScroll();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("scroll", this.onScroll);
    document.body.style.overflow = "";
  }

  private async toggleTheme() {
    const current = this.querySelector<HTMLElement>("[data-theme-icon]");
    if (current) {
      await animateOut(
        current,
        { opacity: 0, rotate: 90, scale: 0.6 },
        { duration: 0.15 },
      );
    }
    this.theme = this.theme === "dark" ? "light" : "dark";
    applyTheme(this.theme);
    await this.updateComplete;
    const next = this.querySelector<HTMLElement>("[data-theme-icon]");
    if (next) {
      animateIn(
        next,
        { opacity: [0, 1], rotate: [-90, 0], scale: [0.6, 1] },
        { duration: 0.2 },
      );
    }
  }

  private async toggleMenu() {
    if (this.menu === "closed") {
      this.menu = "opening";
      document.body.style.overflow = "hidden";
      await this.updateComplete;
      const el = this.querySelector<HTMLElement>("[data-mobile-menu]");
      if (el) {
        animateIn(
          el,
          { height: [0, "auto"], opacity: [0, 1] },
          { duration: 0.25, ease: EASE },
        );
      }
      this.menu = "open";
    } else if (this.menu === "open") {
      this.menu = "closing";
      document.body.style.overflow = "";
      const el = this.querySelector<HTMLElement>("[data-mobile-menu]");
      if (el) {
        await animateOut(
          el,
          { height: 0, opacity: 0 },
          { duration: 0.25, ease: EASE },
        );
      }
      if (this.menu === "closing") this.menu = "closed";
    }
  }

  private closeMenu() {
    if (this.menu === "open") void this.toggleMenu();
  }

  override render() {
    return (
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 border-b transition-all duration-300",
          this.scrolled
            ? cn(line, glass, "shadow-[0_1px_20px_-12px_rgba(29,35,24,0.35)]")
            : "border-transparent",
        )}
      >
        <nav
          className={cn(
            container,
            "flex h-16 items-center justify-between gap-4",
          )}
        >
          <a
            href="#top"
            className={cn("rounded-xl", focusRing)}
            aria-label="Yukino home"
          >
            <Logo />
          </a>

          <div className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => (
              <a
                href={link.href}
                className={cn(
                  "rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
                  muted,
                  "hover:bg-brand-500/10 hover:text-brand-950 dark:hover:bg-white/6 dark:hover:text-white",
                  focusRing,
                )}
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void this.toggleTheme()}
              aria-label={`Switch to ${this.theme === "dark" ? "light" : "dark"} mode`}
              className={cn(ghostButton, "h-9 w-9 px-0", focusRing)}
            >
              <span data-theme-icon className="grid place-items-center">
                {unsafeHTML(
                  this.theme === "dark"
                    ? icon(icons.sun, "h-4 w-4")
                    : icon(icons.moon, "h-4 w-4"),
                )}
              </span>
            </button>

            <a
              href={this.repoUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Yukino on GitHub"
              className={cn(ghostButton, "h-9 w-9 px-0", focusRing)}
            >
              <GithubIcon className="h-4.5 w-4.5" />
            </a>

            <a
              href="#install"
              className={cn(
                primaryButton,
                "hidden h-9 px-4 sm:inline-flex",
                focusRing,
              )}
            >
              Get started
              {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
            </a>

            <button
              type="button"
              onClick={() => void this.toggleMenu()}
              aria-label="Toggle menu"
              aria-expanded={this.menu !== "closed"}
              className={cn(ghostButton, "h-9 w-9 px-0 md:hidden", focusRing)}
            >
              {unsafeHTML(
                this.menu !== "closed"
                  ? icon(icons.x, "h-5 w-5")
                  : icon(icons.menu, "h-5 w-5"),
              )}
            </button>
          </div>
        </nav>

        {this.menu !== "closed" ? (
          <div
            data-mobile-menu
            className={cn(
              "overflow-hidden border-t md:hidden",
              line,
              glass,
              this.menu === "opening" ? "opacity-0" : undefined,
            )}
          >
            <div className={cn(container, "flex flex-col gap-1 py-4")}>
              {navLinks.map((link) => (
                <a
                  href={link.href}
                  onClick={() => this.closeMenu()}
                  className={cn(
                    "rounded-xl px-3 py-2.5 text-base font-medium",
                    heading,
                    "hover:bg-brand-500/10 dark:hover:bg-white/6",
                  )}
                >
                  {link.label}
                </a>
              ))}
              <a
                href="#install"
                onClick={() => this.closeMenu()}
                className={cn(primaryButton, "mt-2 w-full")}
              >
                Get started
                {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
              </a>
            </div>
          </div>
        ) : null}
      </header>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-navbar": NavbarElement;
  }
}
