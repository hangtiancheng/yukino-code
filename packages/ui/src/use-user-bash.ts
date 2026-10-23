import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";

import type { UserBashResult } from "@yukino.js/conversation";
import type { ConversationManager } from "@yukino.js/conversation";
import { userBashContext } from "@yukino.js/conversation/prompts.js";
import { parseUserBashCommand } from "@yukino.js/conversation/user-bash.js";
import type { InputEntry } from "@yukino.js/history";
import {
  saveMessage,
  rebuildFromSession,
  type SessionMessage,
} from "@yukino.js/session";
import type { ToolResult } from "@yukino.js/tools/types.js";
import type { ChatMessage } from "./chat.js";
import {
  USER_BASH_PROGRESS_EXCLUDED,
  USER_BASH_PROGRESS_INCLUDED,
} from "./constants.js";
import { plainTerminalLine } from "./terminal-text.js";
import type { ToolBlockInfo } from "./tool-display.js";
import { asErrorString, plainTerminalText } from "@yukino.js/utils";

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
          ? USER_BASH_PROGRESS_EXCLUDED
          : USER_BASH_PROGRESS_INCLUDED,
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
  const record = useCallback((result: UserBashResult, input?: InputEntry) => {
    pending.current.push({
      role: "user",
      content: userBashContext(result),
      timestamp: Math.floor(Date.now() / 1000),
      user_bash: result,
      ...(input
        ? { user_input: { id: input.id, timestamp: input.timestamp } }
        : {}),
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
      ? USER_BASH_PROGRESS_EXCLUDED
      : USER_BASH_PROGRESS_INCLUDED;
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
