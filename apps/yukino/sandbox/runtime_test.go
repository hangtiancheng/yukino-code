package sandbox

import "testing"

func TestRuntimeCachesInstancesAndUnavailableResultsUntilReset(t *testing.T) {
	var runtime Runtime
	first := runtime.Get()
	if !runtime.initialized || runtime.Get() != first {
		t.Fatal("sandbox instance was not cached")
	}
	runtime.Reset()
	if runtime.initialized || runtime.instance != nil {
		t.Fatal("reset retained cached state")
	}
	runtime.initialized = true
	if runtime.Get() != nil {
		t.Fatal("unavailable result was not cached")
	}
	runtime.Reset()
	runtime.Get()
	if !runtime.initialized {
		t.Fatal("reset did not permit reinitialization")
	}
}
