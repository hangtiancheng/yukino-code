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

import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { cn } from "@/lib/cn";
import { INSTALL_METHODS, VERSION, footerColumns } from "@/lib/content";
import { icon } from "@/lib/icon";
import { icons } from "@/lib/icons";
import { container, focusRing, ghostButton, heading, line } from "@/lib/styles";
import { GithubIcon } from "./ui/github-icon";
import { Logo } from "./ui/logo";
import "./ui/command-box";

export function Footer({
  repoUrl,
  npmUrl,
}: {
  repoUrl: string;
  npmUrl: string;
}) {
  const install = INSTALL_METHODS[0].command;

  return (
    <footer className={cn("relative border-t", line)}>
      <div className={cn(container, "py-14 sm:py-16")}>
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-6">
          <div className="col-span-2 lg:col-span-3">
            <a
              href="#top"
              className={cn("inline-flex rounded-xl", focusRing)}
              aria-label="Yukino home"
            >
              <Logo />
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              A terminal-based AI coding agent with multi-provider models,
              sandboxed tools and multi-agent teams.
            </p>
            <div
              className={cn(
                "mt-6 flex max-w-sm items-center gap-2 rounded-xl border bg-white/70 px-3 py-2 dark:bg-white/2",
                line,
              )}
            >
              <span className="text-brand-500 font-mono text-xs select-none">
                $
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {install}
              </code>
              <docs-copy-button value={install} buttonClass="h-7 w-7" />
            </div>
            <div className="mt-5 flex items-center gap-2">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub"
                className={cn(ghostButton, "h-9 w-9 px-0", focusRing)}
              >
                <GithubIcon className="h-4.5 w-4.5" />
              </a>
              <a
                href={npmUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="npm"
                className={cn(
                  ghostButton,
                  "h-9 px-3 font-mono text-xs",
                  focusRing,
                )}
              >
                npm
              </a>
            </div>
          </div>

          {footerColumns.map((column) => (
            <div>
              <h3
                className={cn(
                  "text-xs font-semibold tracking-[0.14em] uppercase",
                  heading,
                )}
              >
                {column.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li>
                    <a
                      href={link.href}
                      target={
                        link.href.startsWith("http") ? "_blank" : undefined
                      }
                      rel={
                        link.href.startsWith("http") ? "noreferrer" : undefined
                      }
                      className="group hover:text-brand-800 inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors dark:text-zinc-400 dark:hover:text-white"
                    >
                      {link.label}
                      {link.href.startsWith("http") ? (
                        <span className="opacity-0 transition-opacity group-hover:opacity-100">
                          {unsafeHTML(icon(icons.arrowUpRight, "h-3 w-3"))}
                        </span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div
          className={cn(
            "mt-12 flex flex-col items-start justify-between gap-4 border-t pt-6 text-xs text-zinc-400 sm:flex-row sm:items-center dark:text-zinc-500",
            line,
          )}
        >
          <p>
            © {new Date().getFullYear()} Yukino. Released under the MIT License.
          </p>
          <p className="inline-flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Built for the terminal · {VERSION}
          </p>
        </div>
      </div>
    </footer>
  );
}
