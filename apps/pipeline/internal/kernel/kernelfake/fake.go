// Package kernelfake is an in-process HTTP fake of the kernel's service routes (todo12 §5
// contracts) with a simulated worker pool, for testing dispatch, triggers and the chaos
// suite without apps/api. It implements:
//
//   - POST /api/v1/service/jobs and GET /api/v1/service/jobs/{id} (idempotency per
//     workspace + key, 200 on a repeat; kernel-owned retries up to MaxAttempts);
//   - GET /api/v1/service/events?after=&types= (long-poll, cross-workspace) over an outbox
//     that receives job.succeeded / job.failed with the §5 payload;
//   - the kernel fairness gate (E4): a claim skips jobs whose workspace is at its running
//     cap for the job's resource class; otherwise oldest first, as the SQL queue does.
//
// Workers claim in a loop: a worker that finishes a job claims the next one at once; an
// idle worker re-polls every ClaimInterval (the "claim cycle").
package kernelfake

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"studio.local/pipeline/internal/kernel"
)

// Outcome is what a simulated worker does with one attempt of a job.
type Outcome struct {
	Duration   time.Duration
	ResultRef  string
	Fail       bool   // this attempt fails (the kernel retries up to MaxAttempts)
	ErrorClass string // on the final failure
}

// Job is the fake's job record.
type Job struct {
	ID             string
	WorkspaceID    string
	Kind           string
	Plugin         string
	InputRef       string
	ResourceClass  string
	IdempotencyKey string
	State          string
	Attempts       int
	MaxAttempts    int
	ResultRef      string
	ErrorClass     string
	CreatedAt      time.Time
	ClaimedAt      []time.Time // per attempt
	FinishedAt     time.Time
	Source         string // "service" (POST) or "local" (Submit)
}

// Options configure a fake kernel.
type Options struct {
	Token         string                    // bearer token the service principal presents
	Workers       int                       // simulated worker slots (default 4)
	ClaimInterval time.Duration             // idle re-poll (default 100ms)
	MaxAttempts   int                       // kernel retries (default 3)
	LongPoll      time.Duration             // event feed wait (default 25s, the contract's maximum)
	Caps          map[string]int            // per-workspace running cap by resource class; 0/absent: none
	Work          func(j Job) Outcome       // default: 10ms success
	DropEvent     func(e kernel.Event) bool // chaos: true drops an event before the outbox
}

// Kernel is a running fake.
type Kernel struct {
	opts Options
	srv  *httptest.Server

	mu       sync.Mutex
	jobs     map[string]*Job
	order    []string          // job IDs, oldest first
	byKey    map[string]string // workspace\x00key → job ID
	events   []kernel.Event
	running  map[string]int // workspace\x00class → running
	nextJob  int
	stopped  bool
	paused   bool
	wake     chan struct{}
	evWake   chan struct{}
	freed    []time.Time // when a worker slot freed up (job finished)
	requests map[string]int

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Start launches the fake's HTTP server and workers.
func Start(o Options) *Kernel {
	if o.Workers <= 0 {
		o.Workers = 4
	}
	if o.ClaimInterval <= 0 {
		o.ClaimInterval = 100 * time.Millisecond
	}
	if o.MaxAttempts <= 0 {
		o.MaxAttempts = 3
	}
	if o.LongPoll <= 0 {
		o.LongPoll = 25 * time.Second
	}
	if o.Work == nil {
		o.Work = func(Job) Outcome { return Outcome{Duration: 10 * time.Millisecond} }
	}
	k := &Kernel{opts: o, jobs: map[string]*Job{}, byKey: map[string]string{}, running: map[string]int{},
		wake: make(chan struct{}, 1), evWake: make(chan struct{}), requests: map[string]int{}}
	k.ctx, k.cancel = context.WithCancel(context.Background())
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/service/jobs", k.auth(k.postJob))
	mux.HandleFunc("GET /api/v1/service/jobs/{id}", k.auth(k.getJob))
	mux.HandleFunc("GET /api/v1/service/events", k.auth(k.getEvents))
	k.srv = httptest.NewServer(mux)
	for i := range o.Workers {
		k.wg.Add(1)
		go k.worker(i)
	}
	return k
}

// URL is the base URL (PIPELINE_API_URL).
func (k *Kernel) URL() string { return k.srv.URL }

// Close stops workers and the server.
func (k *Kernel) Close() {
	k.mu.Lock()
	k.stopped = true
	k.mu.Unlock()
	k.cancel()
	k.wg.Wait()
	k.srv.CloseClientConnections()
	k.srv.Close()
}

// Pause stops workers claiming (running attempts finish). Resume undoes it.
func (k *Kernel) Pause()  { k.mu.Lock(); k.paused = true; k.mu.Unlock() }
func (k *Kernel) Resume() { k.mu.Lock(); k.paused = false; k.mu.Unlock(); k.poke() }

func (k *Kernel) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if k.opts.Token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(k.opts.Token)) != 1 {
			http.Error(w, `{"detail":"bad service token"}`, http.StatusUnauthorized)
			return
		}
		k.mu.Lock()
		k.requests[r.Pattern]++
		k.mu.Unlock()
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (k *Kernel) postJob(w http.ResponseWriter, r *http.Request) {
	var req kernel.EnqueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.WorkspaceID == "" || req.Kind == "" || req.IdempotencyKey == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"detail": "workspace_id, kind and idempotency_key are required"})
		return
	}
	id, created := k.enqueue(req, "service")
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]string{"job_id": id})
}

// Submit enqueues a job as another kernel client would (imports, inspection, plugin
// tools): it competes for the same workers and caps but isn't the pipeline's.
func (k *Kernel) Submit(req kernel.EnqueueRequest) string {
	id, _ := k.enqueue(req, "local")
	return id
}

func (k *Kernel) enqueue(req kernel.EnqueueRequest, source string) (string, bool) {
	if req.ResourceClass == "" {
		req.ResourceClass = kernel.ClassCPU
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	key := req.WorkspaceID + "\x00" + req.IdempotencyKey
	if id, ok := k.byKey[key]; ok {
		return id, false
	}
	k.nextJob++
	id := fmt.Sprintf("job_%06d", k.nextJob)
	k.jobs[id] = &Job{ID: id, WorkspaceID: req.WorkspaceID, Kind: req.Kind, Plugin: req.Plugin, InputRef: req.InputRef,
		ResourceClass: req.ResourceClass, IdempotencyKey: req.IdempotencyKey, State: kernel.StateQueued,
		MaxAttempts: k.opts.MaxAttempts, CreatedAt: time.Now(), Source: source}
	k.order = append(k.order, id)
	k.byKey[key] = id
	k.pokeLocked()
	return id, true
}

func (k *Kernel) getJob(w http.ResponseWriter, r *http.Request) {
	k.mu.Lock()
	j, ok := k.jobs[r.PathValue("id")]
	var st kernel.JobStatus
	if ok {
		st = kernel.JobStatus{State: j.State, Attempts: j.Attempts, ResultRef: j.ResultRef, ErrorClass: j.ErrorClass}
	}
	k.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"detail": "no such job"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (k *Kernel) getEvents(w http.ResponseWriter, r *http.Request) {
	after := 0
	if a := r.URL.Query().Get("after"); a != "" {
		n, err := strconv.Atoi(a)
		if err != nil || n < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"detail": "bad cursor"})
			return
		}
		after = n
	}
	var types []string
	if t := r.URL.Query().Get("types"); t != "" {
		types = strings.Split(t, ",")
	}
	deadline := time.NewTimer(k.opts.LongPoll)
	defer deadline.Stop()
	for {
		k.mu.Lock()
		var page []kernel.Event
		for _, e := range k.events[min(after, len(k.events)):] {
			if len(types) == 0 || slices.Contains(types, e.Type) {
				page = append(page, e)
			}
			if len(page) == 500 {
				break
			}
		}
		cursor := len(k.events)
		if len(page) == 500 {
			cursor, _ = strconv.Atoi(page[len(page)-1].EventID[len("evt_"):])
		}
		wake := k.evWake
		k.mu.Unlock()
		if len(page) > 0 {
			writeJSON(w, http.StatusOK, kernel.EventPage{Events: page, Cursor: strconv.Itoa(cursor)})
			return
		}
		select {
		case <-wake:
		case <-deadline.C:
			writeJSON(w, http.StatusOK, kernel.EventPage{Events: []kernel.Event{}, Cursor: strconv.Itoa(cursor)})
			return
		case <-r.Context().Done():
			return
		case <-k.ctx.Done():
			return
		}
	}
}

func (k *Kernel) poke() {
	k.mu.Lock()
	k.pokeLocked()
	k.mu.Unlock()
}

func (k *Kernel) pokeLocked() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

// claim picks the oldest queued job whose workspace is under its cap. Caller holds mu.
func (k *Kernel) claimLocked() *Job {
	if k.paused || k.stopped {
		return nil
	}
	for i, id := range k.order {
		j := k.jobs[id]
		if j.State != kernel.StateQueued {
			continue
		}
		slot := j.WorkspaceID + "\x00" + j.ResourceClass
		if c := k.opts.Caps[j.ResourceClass]; c > 0 && k.running[slot] >= c {
			continue // the kernel fairness gate
		}
		k.running[slot]++
		j.State = kernel.StateRunning
		j.Attempts++
		j.ClaimedAt = append(j.ClaimedAt, time.Now())
		k.order = append(k.order[:i:i], k.order[i+1:]...)
		return j
	}
	return nil
}

func (k *Kernel) worker(int) {
	defer k.wg.Done()
	t := time.NewTicker(k.opts.ClaimInterval)
	defer t.Stop()
	for {
		k.mu.Lock()
		j := k.claimLocked()
		var snapshot Job
		if j != nil {
			snapshot = *j
		}
		k.mu.Unlock()
		if j == nil {
			select {
			case <-k.ctx.Done():
				return
			case <-t.C:
			case <-k.wake:
			}
			continue
		}
		out := k.opts.Work(snapshot)
		if out.Duration > 0 {
			select {
			case <-time.After(out.Duration):
			case <-k.ctx.Done():
				return
			}
		}
		k.finish(j.ID, out)
	}
}

func (k *Kernel) finish(id string, out Outcome) {
	k.mu.Lock()
	defer k.mu.Unlock()
	j := k.jobs[id]
	k.running[j.WorkspaceID+"\x00"+j.ResourceClass]--
	k.freed = append(k.freed, time.Now())
	if j.State != kernel.StateRunning {
		return // cancelled meanwhile
	}
	if out.Fail && j.Attempts < j.MaxAttempts {
		j.State = kernel.StateQueued
		k.order = append(k.order, j.ID) // retried behind the queue, like a re-lease
		k.pokeLocked()
		return
	}
	j.FinishedAt = time.Now()
	typ := kernel.EventJobSucceeded
	if out.Fail {
		j.State, j.ErrorClass, typ = kernel.StateFailed, out.ErrorClass, kernel.EventJobFailed
		if j.ErrorClass == "" {
			j.ErrorClass = "user_code_error"
		}
	} else {
		j.State, j.ResultRef = kernel.StateSucceeded, out.ResultRef
	}
	k.pokeLocked()
	payload, _ := json.Marshal(kernel.JobEvent{JobID: j.ID, WorkspaceID: j.WorkspaceID, IdempotencyKey: j.IdempotencyKey,
		Attempts: j.Attempts, ResultRef: j.ResultRef, ErrorClass: j.ErrorClass})
	ev := kernel.Event{EventID: fmt.Sprintf("evt_%d", len(k.events)+1), WorkspaceID: j.WorkspaceID, Type: typ,
		Payload: payload, Source: "kernel", CorrelationID: j.ID, IdempotencyKey: j.ID + "/" + typ,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if k.opts.DropEvent != nil && k.opts.DropEvent(ev) {
		return
	}
	k.events = append(k.events, ev)
	close(k.evWake)
	k.evWake = make(chan struct{})
}

// Cancel cancels a queued or running job (no event: the contract has none for cancels).
func (k *Kernel) Cancel(id string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if j, ok := k.jobs[id]; ok && !kernel.Terminal(j.State) {
		j.State = kernel.StateCancelled
		j.FinishedAt = time.Now()
	}
}

// Jobs returns a snapshot of every job, oldest first.
func (k *Kernel) Jobs() []Job {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := make([]Job, 0, len(k.jobs))
	for _, j := range k.jobs {
		c := *j
		c.ClaimedAt = slices.Clone(j.ClaimedAt)
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b Job) int { return strings.Compare(a.ID, b.ID) })
	return out
}

// Freed returns the times a worker slot freed up.
func (k *Kernel) Freed() []time.Time {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.freed)
}

// Requests counts authenticated requests by "METHOD pattern".
func (k *Kernel) Requests() map[string]int {
	k.mu.Lock()
	defer k.mu.Unlock()
	out := map[string]int{}
	for kk, v := range k.requests {
		out[kk] = v
	}
	return out
}

// ClaimInterval is the configured idle re-poll interval.
func (k *Kernel) ClaimInterval() time.Duration { return k.opts.ClaimInterval }
