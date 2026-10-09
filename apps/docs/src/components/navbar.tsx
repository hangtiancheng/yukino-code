import { LitElement, customElement, property, state } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { navLinks } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { LocaleController, t } from "@/lib/i18n";
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
  } catch {}
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
  } catch {}
}

@customElement("docs-navbar")
export class NavbarElement extends LitElement {
  @property() repoUrl = "";
  @state() private theme: Theme = readInitialTheme();
  @state() private scrolled = false;
  @state() private menu: "closed" | "opening" | "open" | "closing" = "closed";

  locale = new LocaleController(this);

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
        await animateIn(
          el,
          { height: [0, "auto"], opacity: [0, 1] },
          { duration: 0.25, ease: EASE },
        ).finished;
      }
      if (this.menu === "opening") this.menu = "open";
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
            ? cn(
                line,
                glass,
                "shadow-[0_1px_2px_rgb(60_64_67/0.16),0_8px_24px_-14px_rgb(60_64_67/0.3)]",
              )
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
            aria-label={t("nav.ariaHome")}
          >
            <Logo />
          </a>

          <div className="hidden items-center gap-0.5 lg:flex">
            {navLinks.map((link) => (
              <a
                href={link.href}
                className={cn(
                  "rounded-full px-3 py-2 text-sm font-medium transition-colors",
                  muted,
                  "hover:bg-brand-500/8 hover:text-[#202124] dark:hover:bg-white/8 dark:hover:text-[#e8eaed]",
                  focusRing,
                )}
              >
                {t(`nav.${link.id}`)}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void this.toggleTheme()}
              aria-label={
                this.theme === "dark"
                  ? t("nav.ariaThemeToLight")
                  : t("nav.ariaThemeToDark")
              }
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
              aria-label={t("nav.ariaGithub")}
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
              {t("common.getStarted")}
              {unsafeHTML(icon(icons.arrowRight, "h-4 w-4"))}
            </a>

            <button
              type="button"
              onClick={() => void this.toggleMenu()}
              aria-label={t("nav.ariaMenu")}
              aria-expanded={this.menu !== "closed"}
              className={cn(ghostButton, "h-9 w-9 px-0 lg:hidden", focusRing)}
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
              "border-t lg:hidden",
              this.menu !== "open" && "overflow-hidden",
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
                    "rounded-xl px-3 py-2.5 text-base font-medium transition-colors",
                    heading,
                    "hover:bg-brand-50/80 dark:hover:bg-white/8",
                  )}
                >
                  {t(`nav.${link.id}`)}
                </a>
              ))}
              <a
                href="#install"
                onClick={() => this.closeMenu()}
                className={cn(primaryButton, "mt-2 w-full")}
              >
                {t("common.getStarted")}
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
