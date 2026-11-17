package llm

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	retryAfterSecondsRe = regexp.MustCompile(`^\d+(?:\.\d+)?$`)
	retryAfterDateRe    = regexp.MustCompile(`^[A-Za-z]{3},`)
)

func retryAfterDelay(header string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(header)
	if value == "" {
		return fallback
	}
	if retryAfterSecondsRe.MatchString(value) {
		seconds, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return fallback
		}
		delay := time.Duration(seconds * float64(time.Second))
		return minDuration(delay, MaxDelay)
	}
	if retryAfterDateRe.MatchString(value) {
		if date, err := http.ParseTime(value); err == nil {
			delay := time.Until(date)
			if delay < 0 {
				delay = 0
			}
			return minDuration(delay, MaxDelay)
		}
	}
	return fallback
}

// LLMRetryDelay reports how long to wait before retrying the given attempt.
// It returns ok=false when the error is not retryable or retries are
// exhausted.
func LLMRetryDelay(err error, attempt int) (time.Duration, bool) {
	if attempt >= MaxRetries {
		return 0, false
	}
	var rateLimit *RateLimitError
	if errors.As(err, &rateLimit) {
		return retryAfterDelay(rateLimit.RetryAfter, RateLimitBaseDelay*time.Duration(int64(1)<<attempt)), true
	}
	delay := minDuration(BackoffBaseDelay*time.Duration(int64(1)<<attempt), MaxDelay)
	var serverErr *ServerError
	if errors.As(err, &serverErr) {
		return retryAfterDelay(serverErr.RetryAfter, delay), true
	}
	var netErr *NetworkError
	if errors.As(err, &netErr) {
		return delay, true
	}
	return 0, false
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// WaitForLLMRetry sleeps for milliseconds, resolving early with the context
// error when the caller aborts.
func WaitForLLMRetry(ctx context.Context, delay time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
