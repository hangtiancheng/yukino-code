// A disposable wire-level broker for the TypeScript Kafka integration tests.
package main

import (
	"fmt"
	"github.com/twmb/franz-go/pkg/kfake"
	"io"
	"os"
	"strings"
)

func main() {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer cluster.Close()
	fmt.Println(strings.Join(cluster.ListenAddrs(), ","))
	_, _ = io.Copy(io.Discard, os.Stdin)
}
