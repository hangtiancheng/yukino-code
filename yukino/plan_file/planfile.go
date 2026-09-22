// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package plan_file

import (
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

const PlansDir = ".yukino/plans"

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"plan-file"})).
var log = logger.CreateChildLogger("plan-file")

// planPaths caches the active plan file per workDir. The chat server hosts
// many sessions in one process, so a single global path would leak session
// A's plan into session B.
var planPaths = struct {
	sync.Mutex
	m map[string]string
}{m: make(map[string]string)}

func plansDir(workDir string) string {
	return filepath.Join(workDir, PlansDir)
}

func generateSlug() string {
	// The word lists mirror the TS ADJECTIVES/NOUNS constants verbatim.
	adjectives := []string{
		"brave", "calm", "dark", "eager", "fair",
		"gentle", "happy", "kind", "lively", "mighty",
		"noble", "proud", "quiet", "swift", "warm", "wise",
	}
	nouns := []string{
		"crystal", "dragon", "eagle", "falcon", "flame",
		"forest", "frost", "mountain", "ocean", "phoenix",
		"river", "shadow", "thunder", "tiger",
	}
	// TS picks random words and a base36 timestamp suffix
	// (Date.now().toString(36).slice(-4)); the deterministic UnixNano pick was
	// a Go-only divergence.
	ts := strconv.FormatInt(time.Now().UnixMilli(), 36)
	if len(ts) > 4 {
		ts = ts[len(ts)-4:]
	}
	return adjectives[rand.IntN(len(adjectives))] + "-" + nouns[rand.IntN(len(nouns))] + "-" + ts
}

// isPlanUnderWorkDir reports whether planPath resolves inside workDir's plans
// directory (TS: isPlanUnderWorkDir, plan-file/index.ts:75-79).
func isPlanUnderWorkDir(planPath, workDir string) bool {
	plansDir, err := filepath.Abs(filepath.Join(workDir, PlansDir))
	if err != nil {
		return false
	}
	resolved, err := filepath.Abs(planPath)
	if err != nil {
		return false
	}
	return strings.HasPrefix(resolved, plansDir+string(filepath.Separator))
}

func GetOrCreatePlanPath(workDir string) string {
	planPaths.Lock()
	defer planPaths.Unlock()
	if path, ok := planPaths.m[workDir]; ok {
		// TS re-checks existsSync on every call: a cached path whose file was
		// deleted falls through and is recreated instead of going stale.
		if _, err := os.Stat(path); err == nil {
			if isPlanUnderWorkDir(path, workDir) {
				return path
			}
			// Cached path escaped this workspace (aliased workDir / stale map
			// entry): warn and fall through to a fresh plan, exactly like TS.
			log.Warn("current plan path is not under work dir", "planPath", path, "workDir", workDir)
		}
	}
	dir := plansDir(workDir)
	os.MkdirAll(dir, 0o755)
	slug := generateSlug()
	path := filepath.Join(dir, slug+".md")
	// TS eagerly creates the file (writeFileSync(path, "")), so PlanExists
	// reports true right after GetOrCreatePlanPath.
	os.WriteFile(path, nil, 0o644)
	planPaths.m[workDir] = path
	return path
}

// SavePlan writes content to the current plan file, creating the plan (and
// the file) for workDir if it has none yet (TS savePlan).
func SavePlan(workDir, content string) error {
	path := GetOrCreatePlanPath(workDir)
	return os.WriteFile(path, []byte(content), 0o644)
}

// LoadPlan returns the current plan content. It reports ok=false when no plan
// path is cached for workDir or the file is gone/unreadable (TS loadPlan
// returns null for the missing cases).
func LoadPlan(workDir string) (content string, ok bool) {
	path := GetCurrentPlanPath(workDir)
	if path == "" {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func PlanExists(workDir string) bool {
	planPaths.Lock()
	path, ok := planPaths.m[workDir]
	planPaths.Unlock()
	if !ok {
		return false
	}
	if _, err := os.Stat(path); err != nil {
		return false
	}
	if !isPlanUnderWorkDir(path, workDir) {
		log.Warn("current plan path is not under work dir", "planPath", path, "workDir", workDir)
		return false
	}
	return true
}

// ResetPlanPath drops the cached plan path for workDir; the next
// GetOrCreatePlanPath starts a fresh plan file (TS resetPlanPath).
func ResetPlanPath(workDir string) {
	planPaths.Lock()
	defer planPaths.Unlock()
	delete(planPaths.m, workDir)
}

// GetCurrentPlanPath returns the cached plan path for workDir, or "" when
// none is cached (TS getCurrentPlanPath → null). Unlike GetOrCreatePlanPath
// it neither creates a file nor revalidates the cached entry.
func GetCurrentPlanPath(workDir string) string {
	planPaths.Lock()
	defer planPaths.Unlock()
	return planPaths.m[workDir]
}
