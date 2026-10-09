import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";

import type { ChatMessage } from "./chat.js";
import { plainTerminalLine, plainTerminalText } from "./terminal-text.js";
import type { ToolBlockInfo } from "./tool-display.js";

import type { UserBashResult } from "@/conversation/index.js";
import type { ConversationManager } from "@/conversation/index.js";
import {
  saveMessage,
  rebuildFromSession,
  type SessionMessage,
} from "@/session/index.js";
import { spillDir } from "@/tool-result/index.js";
import type { BashTool } from "@/tools/bash.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

interface Options {
  execute: (
    command: string,
    signal: AbortSignal,
    onOutput: (output: string) => void,
    excludeFromContext: boolean,
  ) => Promise<ToolResult>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onStart: (text: string) => void;
  onSettled: () => void;
  onResult?: (result: UserBashResult) => void;
}

export function parseUserBashCommand(
  text: string,
): { command: string; excludeFromContext: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) {
    return null;
  }
  const excludeFromContext = trimmed.startsWith("!!");
  return {
    command: trimmed.slice(excludeFromContext ? 2 : 1).trim(),
    excludeFromContext,
  };
}

export async function executeUserBash(
  tool: BashTool,
  context: Pick<ToolContext, "cwd" | "sessionId" | "abortSignal" | "onOutput">,
  command: string,
  excludeFromContext: boolean,
): Promise<ToolResult> {
  const result = await tool.execute(
    {
      ...context,
      ...(excludeFromContext
        ? { taskManager: null, shellTimeoutDisabled: true }
        : {}),
    },
    { command },
  );
  const output = plainTerminalText(result.output);
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= 50 * 1024 && output.split("\n").length <= 2000) {
    return { ...result, output };
  }
  const path = join(
    context.sessionId ? spillDir(context.sessionId) : tmpdir(),
    `user-bash-${randomUUID()}.txt`,
  );
  let start = Math.max(0, bytes.length - 50 * 1024);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++;
  }
  const tail = bytes
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(-2000)
    .join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    return {
      output: `[Output truncated; could not save full output: ${asErrorString(error)}]\n${tail}`,
      isError: true,
    };
  }
  return {
    ...result,
    output: `[Output truncated; showing tail. Full output: ${path}]\n${tail}`,
  };
}

export function userBashContext(result: UserBashResult): string {
  return `User executed Bash (${result.status}):\n$ ${result.command}\n\n${result.output}`;
}

export function userBashCard(result: UserBashResult): ChatMessage {
  return {
    role: "turn_summary",
    content: "",
    toolSummary: [
      {
        toolName: "Bash",
        argsSummary: plainTerminalLine(result.command),
        output: result.output,
        isError: result.isError,
        elapsed: result.elapsed,
        status: result.status,
        progress: result.excludeFromContext
          ? "User command · excluded in next model context"
          : "User command · included in next model context",
      },
    ],
  };
}

export function useUserBashHistory(options: {
  cwd: string;
  sessionId: RefObject<string>;
  conversation: ConversationManager;
  busy: boolean;
  onError: (error: unknown) => void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const pending = useRef<SessionMessage[]>([]);
  const [revision, setRevision] = useState(0);
  const record = useCallback((result: UserBashResult) => {
    pending.current.push({
      role: "user",
      content: userBashContext(result),
      timestamp: Math.floor(Date.now() / 1000),
      user_bash: result,
    });
    setRevision((value) => value + 1);
  }, []);
  const flush = useCallback((includeInConversation = true) => {
    const { cwd, sessionId, conversation, onError } = callbacks.current;
    for (const message of pending.current.splice(0)) {
      try {
        saveMessage(cwd, sessionId.current, message);
      } catch (error) {
        onError(error);
      }
      if (includeInConversation) {
        conversation.appendMessages(rebuildFromSession([message]));
      }
    }
  }, []);
  useEffect(() => {
    if (!options.busy) {
      flush();
    }
  }, [options.busy, revision, flush]);
  return { record, flush };
}

export function useUserBash(options: Options) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const controllerRef = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [tool, setTool] = useState<ToolBlockInfo | null>(null);
  const [backgroundAllowed, setBackgroundAllowed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const submit = useCallback((text: string): boolean | undefined => {
    const parsed = parseUserBashCommand(text);
    if (parsed === null) {
      return undefined;
    }
    const { command, excludeFromContext } = parsed;
    if (!command || controllerRef.current) {
      callbacks.current.setMessages((messages) => [
        ...messages,
        {
          role: "system",
          content: command
            ? "Warning: A user Bash command is already running. Press Esc to cancel it first."
            : `Warning: Enter a Bash command after ${excludeFromContext ? "!!" : "!"}.`,
        },
      ]);
      return false;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const started = Date.now();
    const argsSummary = plainTerminalLine(command);
    const progress = excludeFromContext
      ? "User command · excluded in next model context"
      : "User command · included in next model context";
    setBackgroundAllowed(!excludeFromContext);
    setTool({
      toolId: "user-bash",
      toolName: "Bash",
      args: { command: argsSummary },
      progress,
      loading: true,
    });

    pending.current = (async () => {
      let result: ToolResult;
      try {
        callbacks.current.onStart(text.trim());
        result = await callbacks.current.execute(
          command,
          controller.signal,
          (output) => {
            if (mounted.current && !controller.signal.aborted) {
              setTool((current) =>
                current
                  ? {
                      ...current,
                      output: plainTerminalText(output),
                    }
                  : null,
              );
            }
          },
          excludeFromContext,
        );
      } catch (error) {
        result = {
          output: `Error: ${asErrorString(error)}`,
          isError: true,
        };
      }
      controllerRef.current = null;
      pending.current = null;
      if (mounted.current) {
        const recorded: UserBashResult = {
          command,
          excludeFromContext,
          output: plainTerminalText(result.output),
          isError: result.isError,
          elapsed: (Date.now() - started) / 1000,
          status: controller.signal.aborted
            ? "stopped"
            : result.isError
              ? "failed"
              : "completed",
        };
        callbacks.current.setMessages((messages) => [
          ...messages,
          userBashCard(recorded),
        ]);
        setTool(null);
        callbacks.current.onResult?.(recorded);
        callbacks.current.onSettled();
      }
    })();
    return true;
  }, []);

  const interrupt = useCallback((): boolean => {
    if (!controllerRef.current) {
      return false;
    }
    controllerRef.current.abort();
    return true;
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    await pending.current;
  }, []);

  return {
    tool,
    running: tool !== null,
    backgroundAllowed: tool !== null && backgroundAllowed,
    submit,
    interrupt,
    stop,
  };
}
