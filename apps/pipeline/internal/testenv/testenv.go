// Package testenv wires the pieces integration tests share: a DBOS engine on a test
// database, the fake kernel, and a trigger consumer between them.
package testenv

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	enginedbos "studio.local/pipeline/internal/engine/dbos"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/kernel/kernelfake"
	"studio.local/pipeline/internal/triggers"
)

// Token is the service token the fake kernel accepts.
const Token = "test-pipeline-token"

// Quiet is a logger that drops everything (DBOS logs every recovery at info).
func Quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Engine builds an unlaunched DBOS engine.
func Engine(t testing.TB, db, ver, exec string, pool int32) *enginedbos.Engine {
	t.Helper()
	e, err := enginedbos.New(context.Background(), enginedbos.Options{DatabaseURL: db, AppVersion: ver, ExecutorID: exec,
		PoolMax: pool, Logger: Quiet()})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	return e
}

// Kernel starts a fake kernel accepting Token, closed at cleanup.
func Kernel(t testing.TB, o kernelfake.Options) *kernelfake.Kernel {
	t.Helper()
	o.Token = Token
	k := kernelfake.Start(o)
	t.Cleanup(k.Close)
	return k
}

// Client is a kernel client for k.
func Client(k *kernelfake.Kernel) *kernel.Client { return kernel.New(k.URL(), Token) }

// Consumer runs a trigger consumer from k's feed into e until the returned stop is called.
type Consumer struct {
	C      *triggers.Consumer
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// StartConsumer starts a consumer with an in-memory cursor (shared across restarts if given).
func StartConsumer(k *kernelfake.Kernel, e triggers.Sender, cur triggers.Cursors) *Consumer {
	return startConsumer(Client(k), e, cur)
}

// StartConsumerURL starts a consumer against a kernel at url (another process's fake).
func StartConsumerURL(url string, e triggers.Sender) *Consumer {
	return startConsumer(kernel.New(url, Token), e, nil)
}

func startConsumer(feed triggers.Feed, e triggers.Sender, cur triggers.Cursors) *Consumer {
	if cur == nil {
		cur = &triggers.MemoryCursor{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Consumer{C: &triggers.Consumer{Feed: feed, Engine: e, Cursors: cur, Log: Quiet(), Backoff: 50 * time.Millisecond}, cancel: cancel}
	c.wg.Add(1)
	go func() { defer c.wg.Done(); _ = c.C.Run(ctx) }()
	return c
}

// Stop ends the consumer and waits for it.
func (c *Consumer) Stop() { c.cancel(); c.wg.Wait() }
