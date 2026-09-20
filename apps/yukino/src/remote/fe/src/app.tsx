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

import { useCallback } from "react";

import { InputArea } from "./components/input-area";
import { MessageList } from "./components/message-list";
import { StatusBar } from "./components/status-bar";
import { useChat } from "./hooks/use-chat";
import { useWebSocket } from "./hooks/use-web-socket";
import type { ClientMessage, PermissionResponse } from "./types";

export function App() {
  const { state, dispatchMessage, setConnection, respondPermission, markAskAnswered } = useChat();

  const { send } = useWebSocket({
    onMessage: dispatchMessage,
    onOpen: () => {
      setConnection("connected");
    },
    onClose: () => {
      setConnection("reconnecting");
    },
  });

  const handleSend = useCallback(
    (text: string) => {
      const msg: ClientMessage = {
        type: "user_message",
        data: { content: text },
      };
      send(msg);
    },
    [send],
  );

  const handleCancel = useCallback(() => {
    send({ type: "cancel", data: null });
  }, [send]);

  const handleRespondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      respondPermission(id, response);
      const msg: ClientMessage = {
        type: "permission_response",
        data: { id, response },
      };
      send(msg);
    },
    [respondPermission, send],
  );

  const handleAnswerAsk = useCallback(
    (id: string, answers: Record<string, string>) => {
      markAskAnswered(id);
      const msg: ClientMessage = {
        type: "ask_user_response",
        data: { id, answers },
      };
      send(msg);
    },
    [markAskAnswered, send],
  );

  return (
    <div className="flex h-screen w-full flex-col bg-bg font-sans text-sm text-base antialiased">
      <StatusBar connection={state.connection} usage={state.usage} cwd={state.cwd} />
      <MessageList
        items={state.items}
        onRespondPermission={handleRespondPermission}
        onAnswerAsk={handleAnswerAsk}
      />
      <InputArea
        streaming={state.streaming}
        commands={state.commands}
        onSend={handleSend}
        onCancel={handleCancel}
      />
    </div>
  );
}
