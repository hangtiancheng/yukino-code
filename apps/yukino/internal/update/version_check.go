package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

var (
	numericIdentifier     = regexp.MustCompile(`^\d+$`)
	leadingZeroIdentifier = regexp.MustCompile(`^0\d+$`)
)

type parsedVersion struct {
	core       [3]*big.Int
	prerelease []string
}

func parseVersion(value string) (parsedVersion, error) {
	match := VersionPattern.FindStringSubmatch(value)
	if match == nil {
		return parsedVersion{}, fmt.Errorf("Invalid package version: %s", value)
	}
	var prerelease []string
	if match[4] != "" {
		prerelease = strings.Split(match[4], ".")
	}
	for _, part := range prerelease {
		if leadingZeroIdentifier.MatchString(part) {
			return parsedVersion{}, fmt.Errorf("Invalid package version: %s", value)
		}
	}
	var out parsedVersion
	for i, part := range []string{match[1], match[2], match[3]} {
		n, ok := new(big.Int).SetString(part, 10)
		if !ok {
			return parsedVersion{}, fmt.Errorf("Invalid package version: %s", value)
		}
		out.core[i] = n
	}
	out.prerelease = prerelease
	return out, nil
}

// IsNewerVersion compares two versions with npm semver precedence rules
// (BigInt core parts, prerelease identifiers numeric-before-alpha).
func IsNewerVersion(candidate, current string) (bool, error) {
	left, err := parseVersion(candidate)
	if err != nil {
		return false, err
	}
	right, err := parseVersion(current)
	if err != nil {
		return false, err
	}
	for i := 0; i < len(left.core); i++ {
		if left.core[i].Cmp(right.core[i]) != 0 {
			return left.core[i].Cmp(right.core[i]) > 0, nil
		}
	}
	if len(left.prerelease) == 0 || len(right.prerelease) == 0 {
		return len(left.prerelease) == 0 && len(right.prerelease) > 0, nil
	}
	length := len(left.prerelease)
	if len(right.prerelease) > length {
		length = len(right.prerelease)
	}
	for i := 0; i < length; i++ {
		aExists := i < len(left.prerelease)
		bExists := i < len(right.prerelease)
		a, b := "", ""
		if aExists {
			a = left.prerelease[i]
		}
		if bExists {
			b = right.prerelease[i]
		}
		if a == b && aExists && bExists {
			continue
		}
		if !aExists || !bExists {
			return !bExists, nil
		}
		aNumeric := numericIdentifier.MatchString(a)
		bNumeric := numericIdentifier.MatchString(b)
		if aNumeric && bNumeric {
			ai, _ := new(big.Int).SetString(a, 10)
			bi, _ := new(big.Int).SetString(b, 10)
			return ai.Cmp(bi) > 0, nil
		}
		if aNumeric == bNumeric {
			return a > b, nil
		}
		return bNumeric, nil
	}
	return false, nil
}

// uriUnreserved mirrors the characters encodeURIComponent leaves unescaped.
func uriUnreserved(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.' || r == '!' || r == '~' || r == '*' || r == '\'' || r == '(' || r == ')':
		default:
			return false
		}
	}
	return true
}

// packageURL is the registry dist-tag endpoint; tests may point it at a local
// server, mirroring the reference tests' fetch stub.
var packageURL = PackageURL

// GetLatestVersion fetches the version published under an npm dist-tag. An
// empty tag is invalid; callers that want the default pass DefaultDistTag.
func GetLatestVersion(ctx context.Context, tag string) (string, error) {
	if tag == "" || !uriUnreserved(tag) || tag == "." || tag == ".." {
		return "", fmt.Errorf("Invalid npm dist-tag: %s", tag)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(RegistryFetchTimeoutMS)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, packageURL+"/"+tag, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("User-Agent", fmt.Sprintf("yukino/%s (%s; %s)", version.Version, runtime.GOOS, runtime.GOARCH))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("No Yukino release found for npm dist-tag %q.", tag)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", fmt.Errorf("Could not check for Yukino updates (npm dist-tag %q): HTTP %d", tag, response.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", err
	}
	latest, ok := payload["version"].(string)
	if !ok {
		return "", errors.New("npm registry response is missing a string version")
	}
	if _, err := parseVersion(latest); err != nil {
		return "", err
	}
	return latest, nil
}

// CheckForUpdate returns the newer published version, or "" when there is none
// or the check fails.
func CheckForUpdate(ctx context.Context) string {
	latest, err := GetLatestVersion(ctx, DefaultDistTag)
	if err != nil {
		return ""
	}
	newer, err := IsNewerVersion(latest, version.Version)
	if err != nil || !newer {
		return ""
	}
	return latest
}
