package config

import "testing"

func TestEtcdEndpoints(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"https://one:2379/,http://two:2379", "https://one:2379"},
		{" one:2379, two:2379 ", "http://one:2379"},
		{"http://one:2379/", "http://one:2379"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			if got := LoadFrom(map[string]string{"ETCD_ENDPOINTS": tc.input}).Etcd.URL; got != tc.want {
				t.Fatalf("URL = %q, want %q", got, tc.want)
			}
		})
	}
}
