import { LitElement, customElement, property, state } from "@yukino.js/lit-jsx";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { navLinks } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import {
  getLocale,
  type Locale,
  LocaleController,
  LOCALES,
  LOCALE_LABELS,
  setLocale,
  t,
} from "@/lib/i18n";
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

type LocaleTarget = "desktop" | "mobile" | "closed";

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
  @state() private localeMenu: LocaleTarget = "closed";

  private localeClosing = false;

  locale = new LocaleController(this);

  override createRenderRoot() {
    return this;
  }

  private onScroll = () => {
    this.scrolled = window.scrollY > 8;
    if (this.localeMenu !== "closed") void this.closeLocaleMenu();
  };

  private onDocPointerDown = (event: PointerEvent) => {
    if (this.localeMenu === "closed") return;
    const target = event.target as Element | null;
    if (target?.closest("[data-locale-root]")) return;
    void this.closeLocaleMenu();
  };

  private onDocKeyDown = (event: KeyboardEvent) => {
    if (this.localeMenu === "closed" || event.key !== "Escape") return;
    const which = this.localeMenu;
    void this.closeLocaleMenu().then(() => this.focusLocaleTrigger(which));
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("pointerdown", this.onDocPointerDown);
    document.addEventListener("keydown", this.onDocKeyDown);
    this.onScroll();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("pointerdown", this.onDocPointerDown);
    document.removeEventListener("keydown", this.onDocKeyDown);
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

  private async toggleLocaleMenu(which: "desktop" | "mobile") {
    if (this.localeMenu === which) {
      await this.closeLocaleMenu();
      this.focusLocaleTrigger(which);
      return;
    }
    this.localeMenu = which;
    await this.updateComplete;
    const popup = this.querySelector<HTMLElement>("[data-locale-popup]");
    if (popup) {
      animateIn(
        popup,
        { opacity: [0, 1], y: [-6, 0], scale: [0.96, 1] },
        { duration: 0.18, ease: EASE },
      );
      popup.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
  }

  private async closeLocaleMenu() {
    const which = this.localeMenu;
    if (which === "closed" || this.localeClosing) return;
    this.localeClosing = true;
    const popup = this.querySelector<HTMLElement>("[data-locale-popup]");
    try {
      if (popup) {
        await animateOut(
          popup,
          { opacity: 0, y: -6, scale: 0.96 },
          { duration: 0.15, ease: EASE },
        );
      }
    } catch {}
    this.localeClosing = false;
    if (this.localeMenu === which) this.localeMenu = "closed";
  }

  private focusLocaleTrigger(which: "desktop" | "mobile") {
    this.querySelector<HTMLElement>(
      `[data-locale-trigger="${which}"]`,
    )?.focus();
  }

  private selectLocale(locale: Locale, which: "desktop" | "mobile") {
    setLocale(locale);
    void this.closeLocaleMenu().then(() => this.focusLocaleTrigger(which));
  }

  private onLocalePopupKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const popup = event.currentTarget as HTMLElement;
    const options = Array.from(
      popup.querySelectorAll<HTMLElement>("[role='menuitemradio']"),
    );
    if (options.length === 0) return;
    const index = options.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    options[(index + delta + options.length) % options.length]?.focus();
  }

  private renderLocaleSwitcher(mobile: boolean) {
    const active = getLocale();
    const which = mobile ? "mobile" : "desktop";
    const open = this.localeMenu === which;
    return (
      <div
        data-locale-root=""
        className={cn("relative", mobile ? "w-full" : "hidden md:block")}
      >
        <button
          type="button"
          data-locale-trigger={which}
          onClick={() => void this.toggleLocaleMenu(which)}
          onKeydown={(event) => {
            if (
              !open &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              void this.toggleLocaleMenu(which);
            }
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={`locale-menu-${which}`}
          className={cn(
            "flex items-center gap-1.5 rounded-full border py-1.5 text-[12px] font-medium transition-colors",
            line,
            muted,
            "hover:border-brand-500/40 hover:bg-brand-50/70 hover:text-brand-700 dark:hover:border-brand-300/30 dark:hover:text-brand-200 dark:hover:bg-white/6",
            focusRing,
            mobile ? "w-full justify-between pr-4 pl-3.5" : "pr-2.5 pl-3",
          )}
        >
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="grid place-items-center text-[#9aa0a6] dark:text-[#9aa0a6]"
            >
              {unsafeHTML(icon(icons.languages, "h-4 w-4"))}
            </span>
            {LOCALE_LABELS[active]}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "grid place-items-center text-[#9aa0a6] transition-transform duration-200",
              open && "rotate-180",
            )}
          >
            {unsafeHTML(icon(icons.chevronDown, "h-3.5 w-3.5"))}
          </span>
        </button>

        {open ? (
          <div
            id={`locale-menu-${which}`}
            data-locale-popup=""
            role="menu"
            aria-label={t("common.language")}
            onKeydown={(event) => this.onLocalePopupKeyDown(event)}
            className={cn(
              "absolute top-full z-50 mt-2 overflow-hidden rounded-xl border bg-white p-1.5 dark:border-white/10 dark:bg-[#2d2f31]",
              "border-[#dadce0] shadow-[0_1px_3px_rgb(60_64_67/0.3),0_4px_8px_3px_rgb(60_64_67/0.15)]",
              mobile ? "inset-x-0" : "right-0 min-w-36",
            )}
          >
            {LOCALES.map((locale) => {
              const selected = locale === active;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => this.selectLocale(locale, which)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                    focusRing,
                    selected
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                      : cn(
                          muted,
                          "hover:bg-[#f1f3f4] hover:text-[#202124] dark:hover:bg-white/8 dark:hover:text-[#e8eaed]",
                        ),
                  )}
                >
                  {LOCALE_LABELS[locale]}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid w-3.5 place-items-center",
                      selected ? "text-brand-600 opacity-100" : "opacity-0",
                    )}
                  >
                    {unsafeHTML(icon(icons.check, "h-3.5 w-3.5"))}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
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
            {this.renderLocaleSwitcher(false)}

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
              <div className="mt-2">{this.renderLocaleSwitcher(true)}</div>
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
