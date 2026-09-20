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

/**
 * Shared Tailwind utility recipes.
 *
 * Everything here is a plain string of Tailwind utilities — there are no custom
 * CSS classes or selectors. Keeping the long class lists in one place keeps the
 * components readable without introducing a parallel stylesheet.
 */

export const page =
  "selection:bg-brand-500/30 dark:selection:bg-brand-400/30 min-h-screen bg-[#fafbf8] font-sans text-zinc-600 antialiased dark:bg-[#0a0d09] dark:text-zinc-400";

export const heading = "text-brand-950 dark:text-brand-50";
export const muted = "text-zinc-600 dark:text-zinc-400";
export const faint = "text-zinc-400 dark:text-zinc-600";

export const line = "border-brand-950/8 dark:border-white/8";

export const container = "mx-auto w-full max-w-6xl px-5 sm:px-8";

export const card =
  "shadow-card rounded-2xl border border-brand-950/8 bg-white dark:border-white/8 dark:bg-white/2.5 dark:shadow-none";

export const cardHover =
  "hover:shadow-soft transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-500/35 dark:hover:border-white/20 dark:hover:bg-white/5";

export const glass = "bg-white/80 backdrop-blur-xl dark:bg-[#0a0d09]/80";

export const gradientText =
  "from-brand-600 via-brand-700 to-accent-600 dark:from-brand-300 dark:via-brand-400 dark:to-accent-300 bg-linear-to-r bg-clip-text text-transparent";

export const brandGradient =
  "from-brand-400 via-brand-500 to-accent-500 bg-linear-to-br";

export const gridPattern =
  "bg-[linear-gradient(to_right,rgba(29,35,24,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(29,35,24,0.05)_1px,transparent_1px)] bg-size-[56px_56px] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)]";

export const focusRing =
  "focus-visible:ring-brand-500 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none dark:focus-visible:ring-offset-[#0a0d09]";

export const eyebrow =
  "inline-flex items-center gap-2 rounded-full border border-brand-500/25 bg-brand-50/80 px-3 py-1 text-xs font-medium tracking-wide text-brand-700 dark:border-brand-300/15 dark:bg-white/3 dark:text-brand-200";

export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_rgba(85,101,71,0.65)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0 dark:bg-brand-300 dark:text-brand-950 dark:shadow-none dark:hover:bg-brand-200";

export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-full border border-brand-950/10 bg-white/70 px-5 py-2.5 text-sm font-semibold text-brand-950 backdrop-blur transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-500/40 hover:bg-brand-50/70 dark:border-white/10 dark:bg-white/3 dark:text-brand-100 dark:hover:border-white/20 dark:hover:bg-white/[0.07]";

export const ghostButton =
  "inline-flex items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-brand-500/10 hover:text-brand-950 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-white";

export const chip =
  "inline-flex items-center gap-1.5 rounded-lg border border-brand-950/8 bg-white px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:border-white/8 dark:bg-white/3 dark:text-zinc-300";
