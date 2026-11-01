// Package kernel is the pipeline's client for the kernel's service routes (todo12 §5
// contracts), authenticated as the service:pipeline principal with PIPELINE_API_TOKEN:
//
//	POST /api/v1/service/jobs        {workspace_id, kind, plugin?, input_ref, resource_class, idempotency_key} → {job_id}
//	GET  /api/v1/service/jobs/{id}   → {state, attempts, result_ref?, error_class?}
//	GET  /api/v1/service/events?after=<cursor>&types=<csv>   → {events: [envelope], cursor}  (long-poll ≤ 25 s)
//
// A repeated idempotency key returns the same job (200). The kernel owns a job's retries
// (max_attempts); the pipeline never re-enqueues a job it already holds an ID for.
package kernel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Job states (plugin_jobs.state).
const (
	StateQueued    = "queued"
	StateRunning   = "running"
	StateSucceeded = "succeeded"
	StateFailed    = "failed"
	StateCancelled = "cancelled"
)

// Event types the pipeline consumes.
const (
	EventJobSucceeded = "job.succeeded"
	EventJobFailed    = "job.failed"
)

// Resource classes (PluginJob.resource_class).
const (
	ClassCPU    = "cpu"
	ClassMemory = "memory"
	ClassGPU    = "gpu"
)

// Terminal reports whether a job state is final.
func Terminal(state string) bool {
	return state == StateSucceeded || state == StateFailed || state == StateCancelled
}

// EnqueueRequest is POST /api/v1/service/jobs.
type EnqueueRequest struct {
	WorkspaceID    string `json:"workspace_id"`
	Kind           string `json:"kind"`
	Plugin         string `json:"plugin,omitempty"`
	InputRef       string `json:"input_ref"`
	ResourceClass  string `json:"resource_class"`
	IdempotencyKey string `json:"idempotency_key"`
}

// JobStatus is GET /api/v1/service/jobs/{id}.
type JobStatus struct {
	State      string `json:"state"`
	Attempts   int    `json:"attempts"`
	ResultRef  string `json:"result_ref,omitempty"`
	ErrorClass string `json:"error_class,omitempty"`
}

// Event is the outbox envelope (plugin_events columns, P§15).
type Event struct {
	EventID        string          `json:"event_id"`
	WorkspaceID    string          `json:"workspace_id"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	PayloadRef     string          `json:"payload_ref,omitempty"`
	Source         string          `json:"source"`
	CorrelationID  string          `json:"correlation_id"`
	Depth          int             `json:"depth"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	CreatedAt      string          `json:"created_at,omitempty"`
}

// JobEvent is the payload of job.succeeded / job.failed.
type JobEvent struct {
	JobID          string `json:"job_id"`
	WorkspaceID    string `json:"workspace_id"`
	IdempotencyKey string `json:"idempotency_key"`
	Attempts       int    `json:"attempts"`
	ResultRef      string `json:"result_ref,omitempty"`
	ErrorClass     string `json:"error_class,omitempty"`
}

// EventPage is GET /api/v1/service/events.
type EventPage struct {
	Events []Event `json:"events"`
	Cursor string  `json:"cursor"`
}

// HTTPError is a non-2xx answer. Body is truncated and never contains our token.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("kernel: HTTP %d: %s", e.Status, e.Body) }

// Retryable reports whether an error is worth retrying (network, 429, 5xx).
func Retryable(err error) bool {
	var he *HTTPError
	if errors.As(err, &he) {
		return he.Status == http.StatusTooManyRequests || he.Status >= 500
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

// Client calls the kernel's service routes.
type Client struct {
	BaseURL string // PIPELINE_API_URL, e.g. http://api:8000
	Token   string // PIPELINE_API_TOKEN
	HTTP    *http.Client
}

// New returns a client with timeouts suited to the long-poll feed.
func New(baseURL, token string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{Timeout: 40 * time.Second}}
}

// Enqueue creates (or, for a repeated idempotency key, returns) a kernel job.
func (c *Client) Enqueue(ctx context.Context, req EnqueueRequest) (string, error) {
	if req.IdempotencyKey == "" {
		return "", errors.New("kernel: enqueue needs an idempotency key")
	}
	if req.ResourceClass == "" {
		req.ResourceClass = ClassCPU
	}
	var out struct {
		JobID string `json:"job_id"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/v1/service/jobs", req, &out); err != nil {
		return "", err
	}
	if out.JobID == "" {
		return "", errors.New("kernel: enqueue returned no job_id")
	}
	return out.JobID, nil
}

// Job reads a job's status.
func (c *Client) Job(ctx context.Context, id string) (JobStatus, error) {
	var out JobStatus
	err := c.do(ctx, http.MethodGet, "/api/v1/service/jobs/"+url.PathEscape(id), nil, &out)
	return out, err
}

// Events long-polls the service event feed after cursor ("" = from the start).
func (c *Client) Events(ctx context.Context, after string, types []string) (EventPage, error) {
	q := url.Values{}
	if after != "" {
		q.Set("after", after)
	}
	if len(types) > 0 {
		q.Set("types", strings.Join(types, ","))
	}
	var out EventPage
	path := "/api/v1/service/events"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("kernel: %s %s: %w", method, strings.SplitN(path, "?", 2)[0], err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("kernel: decode %s: %w", strings.SplitN(path, "?", 2)[0], err)
	}
	return nil
}
