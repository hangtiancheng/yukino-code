import type {
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  type ServerCallContext,
} from "@a2a-js/sdk/server";

import { DEFAULT_HISTORY_LENGTH } from "@/a2a/constants.js";

export class YukinoA2aRequestHandler extends DefaultRequestHandler {
  override sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    return super.sendMessage(
      {
        ...params,
        configuration: {
          acceptedOutputModes: [],
          returnImmediately: false,
          taskPushNotificationConfig: undefined,
          ...params.configuration,
          historyLength:
            params.configuration?.historyLength ?? DEFAULT_HISTORY_LENGTH,
        },
      },
      context,
    );
  }

  override getTask(params: GetTaskRequest, context: ServerCallContext) {
    return super.getTask(
      {
        ...params,
        historyLength: params.historyLength ?? DEFAULT_HISTORY_LENGTH,
      },
      context,
    );
  }

  override listTasks(params: ListTasksRequest, context: ServerCallContext) {
    return super.listTasks(
      {
        ...params,
        historyLength: params.historyLength ?? DEFAULT_HISTORY_LENGTH,
      },
      context,
    );
  }
}
