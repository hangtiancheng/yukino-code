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

package memory

import (
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// NewMemoryToolRegistry builds the fixed five-tool registry the background
// memory agent runs with (TS extractor.ts/consolidation.ts register exactly
// ReadFile/WriteFile/EditFile/Glob/Grep — no Bash, no Agent). The three file
// tools share one FileStateCache so read-before-edit spans them.
func NewMemoryToolRegistry() *tools.Registry {
	fsc := tools.NewFileStateCache()
	reg := tools.NewRegistry()
	reg.Register(&tools.ReadFileTool{FileStateCache: fsc})
	reg.Register(&tools.WriteFileTool{FileStateCache: fsc})
	reg.Register(&tools.EditFileTool{FileStateCache: fsc})
	reg.Register(&tools.GlobTool{})
	reg.Register(&tools.GrepTool{})
	return reg
}

// NewSubAgentChecker builds the permission checker for the background memory
// agent (extraction and consolidation). It mirrors the TS
// MemoryPermissionChecker: command-category tools are always denied, writes are
// allowed only to .md files inside the two memory roots (project .yukino/memory
// and the user-level memory dir), and reads are scoped to the memory roots —
// plus the whole project when allowProjectReads is true (consolidation passes
// true, extraction passes false).
func NewSubAgentChecker(projectRoot, userMemoryDir string, allowProjectReads bool) *permissions.Checker {
	return permissions.NewMemoryChecker(projectRoot, userMemoryDir, allowProjectReads)
}
