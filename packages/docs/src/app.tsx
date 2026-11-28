import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { Modes } from "./components/modes";
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
        <Modes />
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
