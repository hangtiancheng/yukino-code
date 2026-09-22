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

// Package version exposes the yukino library version.
//
// Difference from the TypeScript original (src/version.ts): TS resolves the
// version at runtime from the __YUKINO_VERSION__ build-time define, falling
// back to reading package.json from the source tree. Go has no
// package.json, so Version defaults to "0.0.0-dev" and is injected at
// build time instead:
//
//	go build -ldflags "-X github.com/hangtiancheng/yukino-code/yukino/version.Version=1.2.3"
package version

// Version is the library version, overridable via -ldflags at build time.
var Version = "0.0.0-dev"

// Get returns the current library version.
func Get() string {
	return Version
}
