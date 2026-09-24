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

import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// GitHub Pages serves project sites from /<repo>/, so production builds default
// to the yukino-code base path. Override with DOCS_BASE (e.g. for a custom
// domain or a root-level user/org page).
const DEFAULT_BASE = "/yukino-code/";

// The site advertises the CLI's version; read it from the sibling package at
// config time so it can never go stale.
const yukinoPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../yukino/package.json", import.meta.url)),
    "utf-8",
  ),
) as { version: string };

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: process.env.DOCS_BASE ?? (command === "build" ? DEFAULT_BASE : "/"),
  define: {
    __YUKINO_VERSION__: JSON.stringify(yukinoPackage.version),
  },
  plugins: [tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
