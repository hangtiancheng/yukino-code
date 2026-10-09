import { icons } from "./icons";
import type { MessageKey } from "./i18n";

export const REPO_URL = "https://github.com/hangtiancheng/yukino-code";
export const NPM_URL = "https://www.npmjs.com/package/@yukino.js/yukino";
export const DOCS_URL = `${REPO_URL}/tree/main/apps/yukino#readme`;
export const VERSION = `v${__YUKINO_VERSION__}`;

export type InstallMethodId = "curl" | "powershell" | "npm" | "pnpm";

export interface InstallMethod {
  id: InstallMethodId;
  label: string;
  command: string;
}

export const INSTALL_METHODS: InstallMethod[] = [
  {
    id: "curl",
    label: "curl",
    command:
      "curl -fsSL https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.sh | bash",
  },
  {
    id: "powershell",
    label: "PowerShell",
    command:
      "irm https://raw.githubusercontent.com/hangtiancheng/yukino-code/main/install.ps1 | iex",
  },
  { id: "npm", label: "npm", command: "npm i -g @yukino.js/yukino" },
  { id: "pnpm", label: "pnpm", command: "pnpm add -g @yukino.js/yukino" },
];

export type QuickCommandId = "tui" | "print" | "remote";

export interface QuickCommand {
  id: QuickCommandId;
  command: string;
  tone: "brand" | "accent" | "neutral";
}

export const QUICK_COMMANDS: QuickCommand[] = [
  { id: "tui", command: "yukino", tone: "brand" },
  {
    id: "print",
    command: 'yukino -p "fix the failing tests" --output-format stream-json',
    tone: "accent",
  },
  { id: "remote", command: "yukino --remote :18888", tone: "neutral" },
];

export type NavLinkId =
  | "features"
  | "modes"
  | "workflow"
  | "tools"
  | "providers"
  | "safety"
  | "agents"
  | "install";

export interface NavLink {
  id: NavLinkId;
  href: string;
}

export const navLinks: NavLink[] = [
  { id: "features", href: "#features" },
  { id: "modes", href: "#modes" },
  { id: "workflow", href: "#workflow" },
  { id: "tools", href: "#tools" },
  { id: "providers", href: "#providers" },
  { id: "safety", href: "#safety" },
  { id: "agents", href: "#agents" },
  { id: "install", href: "#install" },
];

export type StatId = "protocols" | "tools" | "modes" | "context";

export interface Stat {
  id: StatId;
  value: string;
}

export const stats: Stat[] = [
  { id: "protocols", value: "3" },
  { id: "tools", value: "33" },
  { id: "modes", value: "6" },
  { id: "context", value: "1M" },
];

export type FeatureId =
  | "multiProvider"
  | "terminalUi"
  | "toolbelt"
  | "safety"
  | "memory"
  | "sessions"
  | "skills"
  | "multiAgent"
  | "mcp"
  | "planMode"
  | "codeReview"
  | "rewind"
  | "background"
  | "hooks"
  | "ide"
  | "observability"
  | "acp"
  | "library"
  | "goals"
  | "webSearch";

export interface Feature {
  id: FeatureId;
  icon: string;
  span?: "wide";
  accent?: "brand" | "accent" | "neutral";
  decor?: "providers" | "tools" | "sandbox" | "teammates" | "obs";
}

export const features: Feature[] = [
  {
    id: "multiProvider",
    icon: icons.network,
    span: "wide",
    accent: "brand",
    decor: "providers",
  },
  { id: "terminalUi", icon: icons.squareTerminal, accent: "accent" },
  { id: "toolbelt", icon: icons.wrench, accent: "neutral", decor: "tools" },
  {
    id: "safety",
    icon: icons.shieldCheck,
    span: "wide",
    accent: "brand",
    decor: "sandbox",
  },
  { id: "memory", icon: icons.brainCircuit, accent: "accent" },
  { id: "sessions", icon: icons.hardDrive, accent: "neutral" },
  { id: "skills", icon: icons.sparkles, accent: "brand" },
  {
    id: "multiAgent",
    icon: icons.users,
    span: "wide",
    accent: "accent",
    decor: "teammates",
  },
  { id: "mcp", icon: icons.cable, accent: "neutral" },
  { id: "planMode", icon: icons.listTree, accent: "brand" },
  { id: "codeReview", icon: icons.pencilRuler, accent: "accent" },
  { id: "rewind", icon: icons.history, accent: "neutral" },
  { id: "background", icon: icons.server, accent: "brand" },
  { id: "hooks", icon: icons.zap, accent: "accent" },
  { id: "ide", icon: icons.monitor, accent: "neutral" },
  {
    id: "observability",
    icon: icons.command,
    span: "wide",
    accent: "brand",
    decor: "obs",
  },
  { id: "acp", icon: icons.handshake, accent: "accent" },
  { id: "library", icon: icons.blocks, accent: "neutral" },
  { id: "goals", icon: icons.target, accent: "brand" },
  { id: "webSearch", icon: icons.globe, accent: "accent" },
];

export interface ObsBadge {
  id: "otel" | "langfuse" | "sentry";
  name: string;
}

export const observabilityList: ObsBadge[] = [
  { id: "otel", name: "OpenTelemetry" },
  { id: "langfuse", name: "Langfuse" },
  { id: "sentry", name: "Sentry" },
];

export type RunModeId = "tui" | "print" | "remote" | "teammate" | "acp" | "a2a";

export interface RunMode {
  id: RunModeId;
  icon: string;
  command: string;
  default?: boolean;
}

export const runModes: RunMode[] = [
  { id: "tui", icon: icons.squareTerminal, command: "yukino", default: true },
  {
    id: "print",
    icon: icons.fileText,
    command: 'yukino -p "…" --output-format stream-json',
  },
  { id: "remote", icon: icons.monitor, command: "yukino --remote :18888" },
  {
    id: "teammate",
    icon: icons.users,
    command: 'yukino --teammate --team-name audit --task "…"',
  },
  { id: "acp", icon: icons.plug, command: "yukino --acp" },
  { id: "a2a", icon: icons.network, command: "yukino --a2a" },
];

export type ToolGroup =
  "Files" | "Shell" | "Search" | "Orchestrate" | "Teams" | "Integrate";

export interface ToolItem {
  name: string;
  icon: string;
  group: ToolGroup;
}

export const tools: ToolItem[] = [
  { name: "ReadFile", icon: icons.fileCode, group: "Files" },
  { name: "WriteFile", icon: icons.fileCode, group: "Files" },
  { name: "EditFile", icon: icons.pencilRuler, group: "Files" },
  { name: "Bash", icon: icons.squareTerminal, group: "Shell" },
  { name: "PowerShell", icon: icons.squareTerminal, group: "Shell" },
  { name: "Glob", icon: icons.folderTree, group: "Search" },
  { name: "Grep", icon: icons.search, group: "Search" },
  { name: "WebSearch", icon: icons.globe, group: "Search" },
  { name: "WebFetch", icon: icons.globe, group: "Search" },
  { name: "LSP", icon: icons.braces, group: "Search" },
  { name: "ToolSearch", icon: icons.search, group: "Search" },
  { name: "Agent", icon: icons.bot, group: "Orchestrate" },
  { name: "Goal", icon: icons.target, group: "Orchestrate" },
  { name: "AskUserQuestion", icon: icons.users, group: "Orchestrate" },
  { name: "TodoWrite", icon: icons.listChecks, group: "Orchestrate" },
  { name: "TaskOutput", icon: icons.activity, group: "Orchestrate" },
  { name: "EnterWorktree", icon: icons.gitBranch, group: "Orchestrate" },
  { name: "ExitWorktree", icon: icons.gitBranch, group: "Orchestrate" },
  { name: "ExitPlanMode", icon: icons.listTree, group: "Orchestrate" },
  { name: "SyntheticOutput", icon: icons.fileText, group: "Orchestrate" },
  { name: "TeamCreate", icon: icons.users, group: "Teams" },
  { name: "SendMessage", icon: icons.inbox, group: "Teams" },
  { name: "ListTeams", icon: icons.users, group: "Teams" },
  { name: "TeamDelete", icon: icons.users, group: "Teams" },
  { name: "TaskCreate", icon: icons.blocks, group: "Teams" },
  { name: "TaskUpdate", icon: icons.blocks, group: "Teams" },
  { name: "TaskGet", icon: icons.blocks, group: "Teams" },
  { name: "TaskList", icon: icons.blocks, group: "Teams" },
  { name: "TaskStop", icon: icons.x, group: "Teams" },
  { name: "McpCall", icon: icons.plug, group: "Integrate" },
  { name: "LoadSkill", icon: icons.sparkles, group: "Integrate" },
  { name: "InstallSkill", icon: icons.download, group: "Integrate" },
  { name: "ComputerUse", icon: icons.mousePointerClick, group: "Integrate" },
];

export type PermissionModeId =
  "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface PermissionMode {
  id: PermissionModeId;
  name: string;
  mode: string;
  icon: string;
}

export const permissionModes: PermissionMode[] = [
  { id: "default", name: "default", mode: "default", icon: icons.shieldCheck },
  {
    id: "acceptEdits",
    name: "acceptEdits",
    mode: "acceptEdits",
    icon: icons.zap,
  },
  { id: "plan", name: "plan", mode: "plan", icon: icons.listTree },
  {
    id: "bypassPermissions",
    name: "bypassPermissions",
    mode: "bypassPermissions",
    icon: icons.shieldAlert,
  },
];

export const slashCommands = [
  { cmd: "/login", desc: "configure a provider" },
  { cmd: "/provider", desc: "switch provider" },
  { cmd: "/model", desc: "switch model" },
  { cmd: "/plan", desc: "read-only planning" },
  { cmd: "/goal", desc: "persistent goals" },
  { cmd: "/compact", desc: "shrink context" },
  { cmd: "/clear", desc: "reset the session" },
  { cmd: "/resume", desc: "continue a session" },
  { cmd: "/rewind", desc: "undo a turn" },
  { cmd: "/memory", desc: "inspect memories" },
  { cmd: "/skills", desc: "browse skills" },
  { cmd: "/skill", desc: "run a skill" },
  { cmd: "/worktree", desc: "isolate work" },
  { cmd: "/code-review", desc: "audit the diff" },
  { cmd: "/sandbox", desc: "toggle sandbox" },
  { cmd: "/mcp", desc: "manage MCP servers" },
  { cmd: "/thinking", desc: "reasoning depth" },
  { cmd: "/status", desc: "session health" },
  { cmd: "/help", desc: "all commands" },
];

export type WorkflowStepId = "connect" | "describe" | "approve" | "ship";

export interface WorkflowStep {
  step: string;
  id: WorkflowStepId;
  icon: string;
}

export const workflowSteps: WorkflowStep[] = [
  { step: "01", id: "connect", icon: icons.plug },
  { step: "02", id: "describe", icon: icons.terminal },
  { step: "03", id: "approve", icon: icons.shieldCheck },
  { step: "04", id: "ship", icon: icons.gitBranch },
];

export type ShortcutId =
  "ctrlC" | "ctrlO" | "downArrow" | "ctrlB" | "ctrlV" | "shiftTab";

export interface Shortcut {
  id: ShortcutId;
  term: string;
}

export const shortcuts: Shortcut[] = [
  { id: "ctrlC", term: "Ctrl+C" },
  { id: "ctrlO", term: "Ctrl+O" },
  { id: "downArrow", term: "↓" },
  { id: "ctrlB", term: "Ctrl+B" },
  { id: "ctrlV", term: "Ctrl+V" },
  { id: "shiftTab", term: "Shift+Tab" },
];

export type AgentCardId = "generalPurpose" | "plan" | "explore";

export interface AgentCard {
  name: string;
  id: AgentCardId;
  icon: string;
}

export const agentCards: AgentCard[] = [
  { name: "general-purpose", id: "generalPurpose", icon: icons.bot },
  { name: "plan", id: "plan", icon: icons.listTree },
  { name: "explore", id: "explore", icon: icons.search },
];

export const faqIds = [
  "providers",
  "planMode",
  "goal",
  "sandbox",
  "websearch",
  "data",
  "headless",
  "ide",
  "scrollback",
  "hooks",
  "teammates",
  "delegation",
  "skills",
  "memory",
  "telemetry",
  "acp",
  "a2a",
] as const;

export type FaqId = (typeof faqIds)[number];

export type ProtocolId = "anthropic" | "openai" | "openaiCompat";

export interface Protocol {
  id: ProtocolId;
  icon: string;
  name: string;
}

export const providerList: Protocol[] = [
  { id: "anthropic", icon: icons.sparkle, name: "anthropic" },
  { id: "openai", icon: icons.sparkle, name: "openai" },
  { id: "openaiCompat", icon: icons.sparkle, name: "openai-compat" },
];

export type FooterColumnId = "product" | "developers" | "resources";

export interface FooterLink {
  labelKey: MessageKey;
  href: string;
}

export interface FooterColumn {
  id: FooterColumnId;
  links: FooterLink[];
}

export const footerColumns: FooterColumn[] = [
  {
    id: "product",
    links: [
      { labelKey: "nav.features", href: "#features" },
      { labelKey: "nav.workflow", href: "#workflow" },
      { labelKey: "nav.tools", href: "#tools" },
      { labelKey: "nav.safety", href: "#safety" },
      { labelKey: "nav.agents", href: "#agents" },
      { labelKey: "nav.install", href: "#install" },
    ],
  },
  {
    id: "developers",
    links: [
      { labelKey: "footer.links.documentation", href: DOCS_URL },
      { labelKey: "footer.links.npmPackage", href: NPM_URL },
      { labelKey: "footer.links.github", href: REPO_URL },
    ],
  },
  {
    id: "resources",
    links: [
      { labelKey: "footer.links.releases", href: `${REPO_URL}/releases` },
      {
        labelKey: "footer.links.license",
        href: `${REPO_URL}/blob/main/LICENSE`,
      },
    ],
  },
];
