package telemetry

import (
	"os"
	"reflect"
	"strings"

	"github.com/getsentry/sentry-go"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// ScrubTelemetryPayload redacts secrets and home paths from a JSON-shaped
// payload in place: map[string]any and []any elements are mutated directly,
// other maps and slices through reflection on a best-effort basis.
func ScrubTelemetryPayload(value any) {
	secrets := utils.EnvironmentSecrets()
	redact := func(text string) string {
		text = utils.RedactCredentials(text, secrets, RedactedPlaceholder)
		if home, err := os.UserHomeDir(); err == nil && home != "" && home != "/" {
			text = strings.ReplaceAll(text, home, "~")
			text = strings.ReplaceAll(text, utils.EncodeURIComponent(home), "~")
		}
		return text
	}
	seen := map[uintptr]struct{}{}
	unwrap := func(v reflect.Value) reflect.Value {
		for v.Kind() == reflect.Interface || v.Kind() == reflect.Ptr {
			if v.IsNil() {
				return v
			}
			v = v.Elem()
		}
		return v
	}
	var visit func(v reflect.Value)
	visit = func(v reflect.Value) {
		v = unwrap(v)
		switch v.Kind() {
		case reflect.Map:
			if v.IsNil() {
				return
			}
			ptr := v.Pointer()
			if _, ok := seen[ptr]; ok {
				return
			}
			seen[ptr] = struct{}{}
			for _, key := range v.MapKeys() {
				if key.Kind() != reflect.String {
					continue
				}
				name := key.String()
				if SensitiveKeyPattern.MatchString(name) {
					placeholder := reflect.ValueOf(RedactedPlaceholder)
					if placeholder.Type().AssignableTo(v.Type().Elem()) {
						v.SetMapIndex(key, placeholder)
					}
					continue
				}
				entry := unwrap(v.MapIndex(key))
				if entry.Kind() == reflect.String {
					v.SetMapIndex(key, reflect.ValueOf(redact(entry.String())))
				} else {
					visit(entry)
				}
			}
		case reflect.Slice, reflect.Array:
			if v.Kind() == reflect.Slice && v.IsNil() {
				return
			}
			if v.Kind() == reflect.Slice && v.Len() > 0 {
				ptr := v.Pointer()
				if _, ok := seen[ptr]; ok {
					return
				}
				seen[ptr] = struct{}{}
			}
			for i := 0; i < v.Len(); i++ {
				entry := v.Index(i)
				concrete := unwrap(entry)
				if concrete.Kind() == reflect.String {
					if entry.CanSet() {
						entry.Set(reflect.ValueOf(redact(concrete.String())))
					}
				} else {
					visit(concrete)
				}
			}
		}
	}
	visit(reflect.ValueOf(value))
}

// ScrubSentryEvent redacts secrets and home paths from a typed Sentry event,
// mirroring the generic payload walk the reference applies in beforeSend.
func ScrubSentryEvent(event *sentry.Event) {
	secrets := utils.EnvironmentSecrets()
	redact := func(text string) string {
		text = utils.RedactCredentials(text, secrets, RedactedPlaceholder)
		if home, err := os.UserHomeDir(); err == nil && home != "" && home != "/" {
			text = strings.ReplaceAll(text, home, "~")
			text = strings.ReplaceAll(text, utils.EncodeURIComponent(home), "~")
		}
		return text
	}
	redactStringMap := func(m map[string]string) {
		for key, value := range m {
			if SensitiveKeyPattern.MatchString(key) {
				m[key] = RedactedPlaceholder
				continue
			}
			m[key] = redact(value)
		}
	}

	event.Message = redact(event.Message)
	event.Transaction = redact(event.Transaction)
	event.ServerName = redact(event.ServerName)
	redactStringMap(event.Tags)
	redactStringMap(event.Modules)
	for key, ctx := range event.Contexts {
		if SensitiveKeyPattern.MatchString(key) {
			event.Contexts[key] = sentry.Context{"value": RedactedPlaceholder}
			continue
		}
		for name, value := range ctx {
			if text, ok := value.(string); ok {
				ctx[name] = redact(text)
			} else {
				ScrubTelemetryPayload(value)
			}
		}
	}
	for _, breadcrumb := range event.Breadcrumbs {
		breadcrumb.Message = redact(breadcrumb.Message)
		ScrubTelemetryPayload(breadcrumb.Data)
	}
	for i := range event.Exception {
		exception := &event.Exception[i]
		exception.Type = redact(exception.Type)
		exception.Value = redact(exception.Value)
		if exception.Stacktrace == nil {
			continue
		}
		for j := range exception.Stacktrace.Frames {
			frame := &exception.Stacktrace.Frames[j]
			frame.Filename = redact(frame.Filename)
			frame.AbsPath = redact(frame.AbsPath)
			frame.Function = redact(frame.Function)
			frame.Module = redact(frame.Module)
			frame.Package = redact(frame.Package)
			frame.ContextLine = redact(frame.ContextLine)
			for k, line := range frame.PreContext {
				frame.PreContext[k] = redact(line)
			}
			for k, line := range frame.PostContext {
				frame.PostContext[k] = redact(line)
			}
			ScrubTelemetryPayload(frame.Vars)
		}
	}
	if event.Request != nil {
		event.Request.URL = redact(event.Request.URL)
		event.Request.QueryString = redact(event.Request.QueryString)
		redactStringMap(event.Request.Headers)
		redactStringMap(event.Request.Env)
	}
	event.User.Email = redact(event.User.Email)
	event.User.ID = redact(event.User.ID)
	event.User.IPAddress = redact(event.User.IPAddress)
	event.User.Username = redact(event.User.Username)
	event.User.Name = redact(event.User.Name)
	redactStringMap(event.User.Data)
	for i, fingerprint := range event.Fingerprint {
		event.Fingerprint[i] = redact(fingerprint)
	}
}
