package config

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// TLS builds a verified TLS connection, optionally with a CA and client certificate.
func TLS(options *TLSConfig, serverName string) (*tls.Config, error) {
	if options == nil {
		return nil, nil
	}
	if options.ServerName != "" {
		serverName = options.ServerName
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName, InsecureSkipVerify: options.InsecureSkipVerify}
	if options.CAFile != "" {
		pem, err := os.ReadFile(options.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read TLS CA: %w", err)
		}
		cfg.RootCAs, err = x509.SystemCertPool()
		if err != nil {
			cfg.RootCAs = x509.NewCertPool()
		}
		if !cfg.RootCAs.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("TLS CA file contains no certificates")
		}
	}
	if (options.CertFile == "") != (options.KeyFile == "") {
		return nil, fmt.Errorf("TLS cert_file and key_file must be provided together")
	}
	if options.CertFile != "" {
		cert, err := tls.LoadX509KeyPair(options.CertFile, options.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("load TLS client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return cfg, nil
}
