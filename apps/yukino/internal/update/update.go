package update

import (
	"context"
	"fmt"
	"os"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

// Install hooks mirror the module boundary the reference tests mock
// (vi.mock("@/update/install.js")).
var (
	selfUpdateCommand = GetSelfUpdateCommand
	selfUpdateRun     = RunSelfUpdate
)

// RunUpdate checks the npm dist-tag and self-installs a newer release. It
// mirrors runUpdate: progress goes to stdout, failures to stderr, and the
// return value is the process exit code (0 or 1). A nil tag selects the
// default dist-tag; an explicitly empty tag is rejected like the reference.
func RunUpdate(ctx context.Context, tag *string) int {
	if err := runUpdate(ctx, tag); err != nil {
		fmt.Fprintf(os.Stderr, "Update failed: %s\n", err)
		return 1
	}
	return 0
}

func runUpdate(ctx context.Context, tag *string) error {
	resolved := DefaultDistTag
	if tag != nil {
		resolved = *tag
	}
	latest, err := GetLatestVersion(ctx, resolved)
	if err != nil {
		return err
	}
	newer, err := IsNewerVersion(latest, version.Version)
	if err != nil {
		return err
	}
	if !newer {
		fmt.Printf("Yukino is already up to date (v%s).\n", version.Version)
		return nil
	}
	command, err := selfUpdateCommand(ctx, latest, "")
	if err != nil {
		return err
	}
	fmt.Printf("Updating Yukino from v%s to v%s with %s...\n", version.Version, latest, command.Command)
	if err := selfUpdateRun(command); err != nil {
		return err
	}
	fmt.Printf("Updated Yukino from v%s to v%s.\n", version.Version, latest)
	return nil
}
