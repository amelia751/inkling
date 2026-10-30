// Package events relays the transactional outbox to the event bus (spec §12).
// Delivery is at-least-once; consumers dedupe by event_id.
package events

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/storage"
)

// Publisher sends one event to the bus.
type Publisher interface {
	Publish(ctx context.Context, subject, eventID string, payload []byte) error
}

// LogPublisher logs events (local development without a bus).
type LogPublisher struct{ Log *slog.Logger }

// Publish logs the subject and id; payloads hold ids only but are not logged.
func (p LogPublisher) Publish(_ context.Context, subject, eventID string, _ []byte) error {
	p.Log.Info("event", "subject", subject, "event_id", eventID)
	return nil
}

// RedisStreams publishes to a Redis stream per subject (todo3 E.2 EventBus).
type RedisStreams struct {
	Client *redis.Client
	MaxLen int64
}

// NewRedisStreams connects from a redis:// URL.
func NewRedisStreams(url string) (*RedisStreams, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("redis url: %w", err)
	}
	return &RedisStreams{Client: redis.NewClient(opt), MaxLen: 1_000_000}, nil
}

// Publish XADDs the event.
func (r *RedisStreams) Publish(ctx context.Context, subject, eventID string, payload []byte) error {
	return r.Client.XAdd(ctx, &redis.XAddArgs{Stream: subject, MaxLen: r.MaxLen, Approx: true,
		Values: map[string]any{"event_id": eventID, "payload": payload}}).Err()
}

// Relay moves undelivered outbox rows to the publisher.
type Relay struct {
	DB        *storage.DB
	Publisher Publisher
	Prefix    string // subject prefix from config; defaults to "versioning"
	Batch     int32
}

// Subject maps an event type to a bus subject: versioning.<event>.
func (r *Relay) Subject(eventType string) string {
	prefix := r.Prefix
	if prefix == "" {
		prefix = "versioning"
	}
	return prefix + strings.TrimPrefix(eventType, "versioning")
}

// RunOnce delivers pending events for every tenant. Rows are claimed with
// FOR UPDATE SKIP LOCKED, so several replicas can relay concurrently.
func (r *Relay) RunOnce(ctx context.Context) (int, error) {
	tenants, err := db.New(r.DB.Pool).ListTenants(ctx)
	if err != nil {
		return 0, err
	}
	batch := r.Batch
	if batch == 0 {
		batch = 200
	}
	total := 0
	for _, t := range tenants {
		for {
			n := 0
			err := r.DB.InTenantTx(ctx, t, func(tx pgx.Tx) error {
				q := db.New(tx)
				rows, err := q.ClaimOutbox(ctx, batch)
				if err != nil {
					return err
				}
				var ids []string
				for _, e := range rows {
					if err := r.Publisher.Publish(ctx, r.Subject(e.EventType), e.ID, e.Payload); err != nil {
						break // deliver what we have; the rest stays pending
					}
					ids = append(ids, e.ID)
				}
				n = len(ids)
				if n == 0 {
					return nil
				}
				return q.MarkOutboxDelivered(ctx, ids)
			})
			if err != nil {
				return total, err
			}
			total += n
			if n < int(batch) {
				break
			}
		}
	}
	return total, nil
}
