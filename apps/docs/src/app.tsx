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

import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { Providers } from "./components/providers";
import { ToolsShowcase } from "./components/tools-showcase";
import { Workflow } from "./components/workflow";
import "./components/agents";
import "./components/faq";
import "./components/hero";
import "./components/install";
import "./components/navbar";
import "./components/safety";
import "./components/scroll-process";
import "./components/terminal-showcase";
import { cn } from "./lib/cn";
import { DOCS_URL, NPM_URL, REPO_URL } from "./lib/content";
import { page } from "./lib/styles";

export function App() {
  return (
    <div className={cn(page)}>
      <docs-scroll-progress />
      <docs-navbar repoUrl={REPO_URL} />
      <main>
        <docs-hero docsUrl={DOCS_URL} />
        <docs-terminal-showcase />
        <Features />
        <Workflow />
        <ToolsShowcase />
        <Providers />
        <docs-safety />
        <docs-agents />
        <docs-install />
        <docs-faq />
      </main>
      <Footer repoUrl={REPO_URL} npmUrl={NPM_URL} />
    </div>
  );
}
