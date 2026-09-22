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

package tools

import (
	"regexp"
	"strings"
)

// Allowlist of read-only safe commands. Used in two places: the permissions
// layer decides whether to allow execution, and the scheduler decides whether
// concurrent execution is safe.
//
// This mirrors the TS SAFE_PREFIXES + isSafeCommand (permissions/index.ts). The
// TS list mixes plain strings with regexes; the regexes that use negative
// lookahead (dangerous-flag exclusions such as `find -delete` or `sort -o`)
// cannot be expressed in Go's RE2, so they are reproduced as flagGuard entries
// that check the base command and then reject disqualifying flags.

// safeCommandMetachars mirrors the TS rejection set: any shell metacharacter
// disqualifies a "safe" prefix from becoming a gateway to piping, chaining,
// redirection, or substitution. Note this includes newline, single `&`, `<`,
// and the bracket/brace/paren characters the Go port previously missed.
var safeCommandMetachars = regexp.MustCompile("[\r\n&|;<>`(){}\\[\\]]")

// safeCommandStrings mirrors the TS SAFE_PREFIXES string entries.
var safeCommandStrings = []string{
	"basename", "cat", "cksum", "cmp", "column", "comm", "cut", "df", "dirname",
	"du", "echo", "expr", "false", "fold", "fmt", "grep", "groups", "head", "id",
	"jq", "locate", "ls", "md5", "md5sum", "nl", "od", "paste", "pgrep",
	"printenv", "printf", "ps", "pwd", "readlink", "realpath", "sha1sum",
	"sha224sum", "sha256sum", "sha384sum", "sha512sum", "shasum", "stat",
	"strings", "tac", "tail", "tr", "true", "tty", "type", "uname", "uptime",
	"w", "wc", "whereis", "which", "who", "whoami", "ack", "ag", "alias", "arch",
	"base64", "bat", "bzcat", "cal", "col", "cloc", "diff", "diff3", "dig",
	"dmesg", "expand", "factor", "free", "help", "hexdump", "host", "iconv",
	"info", "locale", "lscpu", "lsblk", "lsof", "lspci", "lsusb", "man",
	"mdfind", "mdls", "ncal", "netstat", "nproc", "nslookup", "objdump",
	"otool", "pbpaste", "ping", "readelf", "rev", "sdiff", "seq", "sum",
	"sw_vers", "tldr", "traceroute", "unexpand", "vm_stat", "whois", "xxd",
	"xzcat", "zcat", "zgrep", "zipinfo",
}

// safeCommandRegexps mirrors the TS SAFE_PREFIXES regex entries that are
// expressible in RE2 (no lookahead/lookbehind).
var safeCommandRegexps = []*regexp.Regexp{
	regexp.MustCompile(`^command\s+(?:-v|-V)\s+\S+(?:\s+\S+)*$`),
	regexp.MustCompile(`^hostname(?:\s+(?:-[adfFiIsyVh]|--(?:alias|all-fqdns|all-ip-addresses|domain|fqdn|help|ip-address|long|nis|short|version|yp)))*$`),
	regexp.MustCompile(`^git\s+(?:--version|version)$`),
	regexp.MustCompile(`^git\s+(?:blame|cat-file|count-objects|describe|for-each-ref|ls-files|ls-tree|merge-base|name-rev|rev-parse|shortlog|show-ref|status|verify-pack)(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+branch$`),
	regexp.MustCompile(`^git\s+config(?:\s+(?:--blob(?:=|\s)\S+|--file(?:=|\s)\S+|--fixed-value|--global|--local|--null|--show-names|--show-origin|--show-scope|--system|--worktree|-z))*\s+(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+notes\s+(?:list|show)(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+reflog\s+show(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+remote(?:\s+-v)?$`),
	regexp.MustCompile(`^git\s+remote\s+get-url(?:\s+(?:--all|--push))*\s+\S+$`),
	regexp.MustCompile(`^git\s+remote\s+show(?:\s+-n)?(?:\s+\S+)?$`),
	regexp.MustCompile(`^git\s+stash\s+(?:list|show)(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+submodule\s+(?:status|summary)(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+tag(?:\s+(?:-l|--list)(?:\s.*)?)?$`),
	regexp.MustCompile(`^git\s+worktree\s+list(?:\s.*)?$`),
	regexp.MustCompile(`^(?:bun|npm|pnpm|yarn)\s+(?:explain|help|info|list|ls|outdated|prefix|query|root|search|show|view|why)(?:\s.*)?$`),
	regexp.MustCompile(`^(?:npm|pnpm|yarn)\s+config\s+(?:get|list)(?:\s.*)?$`),
	regexp.MustCompile(`^npm\s+pkg\s+get(?:\s.*)?$`),
	regexp.MustCompile(`^bun\s+pm\s+ls(?:\s.*)?$`),
	regexp.MustCompile(`^(?:bun|cargo|clang|cmake|composer|deno|gcc|gem|node|npm|php|pip|pip3|pnpm|python|python3|ruby|rustc|swift|yarn)\s+(?:--version|-V)$`),
	regexp.MustCompile(`^(?:go|helm|kubectl|podman|terraform)\s+version(?:\s.*)?$`),
	regexp.MustCompile(`^(?:java|javac)\s+-version$`),
	regexp.MustCompile(`^dotnet\s+(?:--info|--list-runtimes|--list-sdks|--version)$`),
	regexp.MustCompile(`^(?:docker|podman)\s+(?:diff|events|images|info|inspect|logs|port|ps|stats|top|version)(?:\s.*)?$`),
	regexp.MustCompile(`^(?:docker|podman)\s+(?:container|image|network|volume)\s+(?:inspect|ls)(?:\s.*)?$`),
	regexp.MustCompile(`^docker\s+compose\s+(?:config|images|logs|ps|top|version)(?:\s.*)?$`),
	regexp.MustCompile(`^kubectl\s+(?:api-resources|api-versions|cluster-info|describe|explain|get|logs|top|version)(?:\s.*)?$`),
	regexp.MustCompile(`^kubectl\s+config\s+(?:current-context|get-contexts|view)(?:\s.*)?$`),
	regexp.MustCompile(`^helm\s+(?:env|get|history|list|search|show|status|version)(?:\s.*)?$`),
	regexp.MustCompile(`^terraform\s+(?:output|providers|show|version)(?:\s.*)?$`),
	regexp.MustCompile(`^terraform\s+workspace\s+(?:list|show)(?:\s.*)?$`),
	regexp.MustCompile(`^systemctl\s+(?:is-active|is-enabled|is-failed|list-dependencies|list-jobs|list-sockets|list-timers|list-unit-files|list-units|show|show-environment|status)(?:\s.*)?$`),
	regexp.MustCompile(`^launchctl\s+(?:error|hostinfo|list|managername|managerpid|manageruid|print|print-cache|procinfo|variant|version)(?:\s.*)?$`),
	regexp.MustCompile(`^defaults\s+read(?:\s.*)?$`),
	regexp.MustCompile(`^ifconfig$`),
	regexp.MustCompile(`^ipconfig(?:\s+/(?:all|allcompartments|displaydns))?\s*$`),
	regexp.MustCompile(`^ip\s+(?:addr(?:ess)?|route)$`),
	regexp.MustCompile(`^ip\s+(?:addr(?:ess)?|link|route|neigh(?:bor)?)\s+(?:show|list)\b(?:\s.*)?$`),
	regexp.MustCompile(`^tar\s+(?:--list\b|-[a-zA-Z]*t[a-zA-Z]*)(?:\s.*)?$`),
	regexp.MustCompile(`^unzip\s+-[a-zA-Z]*l(?:\s.*)?$`),
	regexp.MustCompile(`^git\s+(?:grep|fsck|rev-list|whatchanged|help|diff-tree|diff-index|diff-files|ls-remote|verify-tag|verify-commit)(?:\s.*)?$`),
	regexp.MustCompile(`^svn\s+(?:status|stat|st|diff|di|log|info|list|ls|cat|blame|ann|annotate|proplist|propget|pg)(?:\s.*)?$`),
	regexp.MustCompile(`^hg\s+(?:status|st|log|diff|summary|id|identify|branches|tags|manifest|cat|files|locate|heads|tip|parents|paths|root)(?:\s.*)?$`),
	regexp.MustCompile(`^cargo\s+(?:tree|search|locate-project|verify-project|config\s+get)(?:\s.*)?$`),
	regexp.MustCompile(`^gem\s+(?:list|search|info|env|dependency|contents|specification|sources\s+(?:-l|--list))(?:\s.*)?$`),
	regexp.MustCompile(`^brew\s+(?:--version|-v|list|info|search|outdated|deps|uses|config|leaves|doctor)(?:\s.*)?$`),
	regexp.MustCompile(`^choco\s+(?:--version|list|info|search|outdated)(?:\s.*)?$`),
	regexp.MustCompile(`^apt(?:-get)?\s+list(?:\s.*)?$`),
	regexp.MustCompile(`^apt-cache\s+(?:search|show|showpkg|policy|depends|rdepends|pkgnames)(?:\s.*)?$`),
	regexp.MustCompile(`^dpkg\s+(?:-l|-L|-s|-S|--list|--listfiles|--status|--search)\b(?:\s.*)?$`),
	regexp.MustCompile(`^rpm\s+-q[a-zA-Z]*(?:\s.*)?$`),
	regexp.MustCompile(`^(?:aws|gh|gcloud|az)\s+--version$`),
	regexp.MustCompile(`^aws\s+(?:\S+\s+)?(?:describe|list|get|wait)-\S+(?:\s.*)?$`),
	regexp.MustCompile(`^aws\s+s3\s+ls(?:\s.*)?$`),
	regexp.MustCompile(`^gcloud\s+\S+(?:\s+\S+)*\s+(?:list|describe)(?:\s.*)?$`),
	regexp.MustCompile(`^az\s+\S+(?:\s+\S+)*\s+(?:list|show)(?:\s.*)?$`),
	regexp.MustCompile(`^gh\s+(?:pr|issue|repo|run|release|gist)\s+(?:view|list|status|checks|diff)(?:\s.*)?$`),
	regexp.MustCompile(`^(?:docker|podman)\s+(?:system\s+(?:df|info)|history|context\s+(?:ls|list|show|inspect))(?:\s.*)?$`),
	regexp.MustCompile(`(?i)^(?:Get-(?:Acl|Alias|AuthenticodeSignature|ChildItem|CimInstance|Clipboard|Command|ComputerInfo|Content|Counter|Culture|Date|DnsClientCache|EventLog|ExecutionPolicy|FileHash|Help|History|Host|HotFix|Item|ItemProperty|Location|Member|Module|NetAdapter|NetIPAddress|NetNeighbor|NetIPConfiguration|NetRoute|NetTCPConnection|NetUDPEndpoint|Package|PackageProvider|PnpDevice|Printer|Process|PSDrive|PSProvider|PSRepository|PSSnapin|ScheduledTask|Service|TimeZone|UICulture|Variable|Verb|WinEvent|WmiObject)|Compare-Object|Format-(?:Custom|Hex|List|Table|Wide)|Group-Object|Measure-Object|Out-String|Resolve-Path|Select-Object|Select-String|Sort-Object|Test-Path|Where-Object|Write-(?:Debug|Error|Host|Information|Output|Progress|Verbose|Warning))(?:\s.*)?$`),
}

// flagGuard reproduces a TS SAFE_PREFIXES regex of the form
// `^<base>(?!.*\s(?:<dangerous flags>)(?:=|\s|$))(?:\s.*)?$`: the command must
// be the base alone or base followed by arguments, and must not contain any
// disqualifying flag. clusterFlags additionally rejects short-flag clusters
// containing a given letter (TS `-[^-\s]*C`).
//
// mode mirrors the trailing constraint TS applies after each flag:
//   - flagExactOrEquals: `(?:=|\s|$)` — the flag alone or as `flag=value`
//     (date, file, fd, rg, sort, tree, git diff/log/show, git archive).
//   - flagExact: `(?:\s|$)` — the flag alone; `flag=value` does not
//     disqualify (find, ss --kill).
//   - flagPrefix: no trailing constraint — any flag starting with the entry
//     disqualifies (journalctl).
type flagMatchMode int

const (
	flagExactOrEquals flagMatchMode = iota
	flagExact
	flagPrefix
)

type flagGuard struct {
	base         string
	mode         flagMatchMode
	dangerous    []string
	clusterFlags []string // single letters that disqualify inside a -xyz cluster
	// clusterAtEnd requires the cluster letter to terminate the flag (TS
	// `-[^-\s]*K(?:\s|$)` for ss); when false the letter may appear anywhere
	// (TS `-[^-\s]*C` for file).
	clusterAtEnd bool
}

func (g flagGuard) match(cmd string) bool {
	if cmd != g.base && !strings.HasPrefix(cmd, g.base+" ") && !strings.HasPrefix(cmd, g.base+"\t") {
		return false
	}
	rest := strings.TrimSpace(cmd[len(g.base):])
	if rest == "" {
		return true
	}
	for _, f := range strings.Fields(rest) {
		for _, d := range g.dangerous {
			switch g.mode {
			case flagExact:
				if f == d {
					return false
				}
			case flagPrefix:
				if strings.HasPrefix(f, d) {
					return false
				}
			default: // flagExactOrEquals
				if f == d || strings.HasPrefix(f, d+"=") {
					return false
				}
			}
		}
		if len(g.clusterFlags) > 0 && strings.HasPrefix(f, "-") && !strings.HasPrefix(f, "--") && !strings.Contains(f[1:], "-") {
			for _, c := range g.clusterFlags {
				if g.clusterAtEnd {
					if strings.HasSuffix(f, c) {
						return false
					}
				} else if strings.Contains(f, c) {
					return false
				}
			}
		}
	}
	return true
}

var safeCommandFlagGuards = []flagGuard{
	{base: "date", mode: flagExactOrEquals, dangerous: []string{"-s", "--set"}},
	{base: "file", mode: flagExactOrEquals, dangerous: []string{"--compile"}, clusterFlags: []string{"C"}},
	{base: "find", mode: flagExact, dangerous: []string{"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"}},
	{base: "fd", mode: flagExactOrEquals, dangerous: []string{"-x", "-X", "--exec", "--exec-batch"}},
	{base: "rg", mode: flagExactOrEquals, dangerous: []string{"--pre", "--pre-glob", "--hostname-bin"}},
	{base: "sort", mode: flagExactOrEquals, dangerous: []string{"-o", "--output", "--compress-program"}},
	{base: "ss", mode: flagExact, dangerous: []string{"--kill"}, clusterFlags: []string{"K"}, clusterAtEnd: true},
	{base: "tree", mode: flagExactOrEquals, dangerous: []string{"-o", "--output"}},
	{base: "git diff", mode: flagExactOrEquals, dangerous: []string{"--ext-diff", "--output"}},
	{base: "git log", mode: flagExactOrEquals, dangerous: []string{"--ext-diff", "--output"}},
	{base: "git show", mode: flagExactOrEquals, dangerous: []string{"--ext-diff", "--output"}},
	{base: "git archive", mode: flagExactOrEquals, dangerous: []string{"-o", "--output"}},
	{base: "journalctl", mode: flagPrefix, dangerous: []string{"--rotate", "--vacuum", "--flush", "--sync"}},
}

// gitBranchGuard mirrors TS line 189: `git branch` with at least one read-only
// flag and none of the mutating flags. Bare `git branch` is handled by the
// regexp list above.
var (
	gitBranchAllowed = []string{
		"-a", "--all", "-r", "--remotes", "--list", "--show-current",
		"--contains", "--no-contains", "--merged", "--no-merged",
	}
	gitBranchDangerous = []string{
		"-d", "-D", "-m", "-M", "-c", "-C", "-f",
		"--copy", "--create-reflog", "--delete", "--edit-description",
		"--move", "--set-upstream-to", "--unset-upstream",
	}
)

func matchGitBranch(cmd string) bool {
	const base = "git branch"
	if !strings.HasPrefix(cmd, base+" ") && !strings.HasPrefix(cmd, base+"\t") {
		return false
	}
	rest := strings.Fields(cmd[len(base):])
	hasAllowed := false
	for _, f := range rest {
		token := f
		if i := strings.IndexByte(token, '='); i >= 0 {
			token = token[:i]
		}
		for _, d := range gitBranchDangerous {
			if token == d {
				return false
			}
		}
		for _, a := range gitBranchAllowed {
			if token == a {
				hasAllowed = true
			}
		}
	}
	return hasAllowed
}

// IsSafeCommand reports whether a shell command is read-only and therefore safe
// to auto-allow and to run concurrently. It mirrors the TS isSafeCommand:
// reject anything containing shell metacharacters first, then match the
// allowlist (plain prefixes, RE2 regexps, and dangerous-flag guards).
func IsSafeCommand(command string) bool {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return false
	}
	// Reject anything with shell metacharacters: a "safe" prefix like `cat`
	// must not become a gateway to piping/chaining/redirection/substitution.
	if safeCommandMetachars.MatchString(cmd) {
		return false
	}
	for _, prefix := range safeCommandStrings {
		if cmd == prefix || strings.HasPrefix(cmd, prefix+" ") || strings.HasPrefix(cmd, prefix+"\t") {
			return true
		}
	}
	for _, re := range safeCommandRegexps {
		if re.MatchString(cmd) {
			return true
		}
	}
	for _, g := range safeCommandFlagGuards {
		if g.match(cmd) {
			return true
		}
	}
	if matchGitBranch(cmd) {
		return true
	}
	return false
}
