package a2a

import "testing"

// Expected strings byte-verified against src/a2a/constants.ts via npx tsx.
func TestReasonBuilders(t *testing.T) {
	cases := []struct{ got, want string }{
		{BuildContextBusyReason("ctx-1", "task-2"), "Context ctx-1 is busy with task task-2. Cancel it or wait for it to finish before sending a new message."},
		{BuildPermissionTaskMismatchReason("task-9"), `Permission responses must be sent with taskId "task-9".`},
		{BuildUnknownPermissionIDReason("perm-3"), `Unknown or already resolved permission id "perm-3".`},
		{UnsupportedVersionError("2.0"), `Unsupported A2A-Version "2.0"; this server requires A2A-Version: 1.0.`},
		{UnknownMethodError("FooBar"), `Unknown method "FooBar". Supported methods: SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, CreateTaskPushNotificationConfig, GetTaskPushNotificationConfig, ListTaskPushNotificationConfigs, DeleteTaskPushNotificationConfig, GetExtendedAgentCard.`},
		{RequestTooLargeError, "Request body exceeds the 102400 byte limit."},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d:\ngot  %q\nwant %q", i, c.got, c.want)
		}
	}
}
