// Command server runs the internal versioning HTTP API and River workers.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"studio.local/versioning/internal/app"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/observability"
)

// gitSHA is set with -ldflags "-X main.gitSHA=...".
var gitSHA = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "versioning:", err)
		os.Exit(1)
	}
}

func run() error {
	log := observability.Logger()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	shutdownTracing, err := observability.Tracing(ctx)
	if err != nil {
		return err
	}
	a, err := app.Build(ctx, cfg, log, app.Options{Periodic: true, GitSHA: gitSHA})
	if err != nil {
		return err
	}
	defer a.Close()
	if err := a.River.Start(ctx); err != nil {
		return fmt.Errorf("start jobs: %w", err)
	}
	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: a.Handler, ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 120 * time.Second}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.HTTPAddr, "git_sha", gitSHA)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	// Stop accepting, drain in-flight requests and jobs within 25 s.
	drain, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	log.Info("shutting down")
	err = srv.Shutdown(drain)
	if rerr := a.River.Stop(drain); err == nil {
		err = rerr
	}
	_ = shutdownTracing(drain)
	return err
}
