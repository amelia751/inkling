package domain

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"testing"
)

func TestTransitions(t *testing.T) {
	for _, s := range []string{RunPublished, RunRejected, RunFailed, RunCancelled} {
		if !Terminal(s) {
			t.Fatalf("%s not terminal", s)
		}
	}
	for _, c := range []struct {
		from, to string
		ok       bool
	}{
		{RunQueued, RunRunning, true},
		{RunRunning, RunAwaitingReview, true},
		{RunAwaitingReview, RunPublishing, true},
		{RunPublishing, RunAwaitingReview, true}, // stale head → rebase review
		{RunPublishing, RunPublished, true},
		{RunPublished, RunPublishing, false}, // no second publish
		{RunAwaitingReview, RunRunning, false},
		{RunCancelled, RunRunning, false},
	} {
		if err := CheckTransition(c.from, c.to); (err == nil) != c.ok {
			t.Errorf("%s → %s: %v", c.from, c.to, err)
		}
	}
}

// RunTransitions equals PIPELINE_RUN_TRANSITIONS in packages/contracts.
func TestTransitionsMatchContracts(t *testing.T) {
	b, err := os.ReadFile("../../../../packages/contracts/src/pipeline/run.ts")
	if err != nil {
		t.Skip(err)
	}
	block := regexp.MustCompile(`(?s)PIPELINE_RUN_TRANSITIONS[^=]*= \{(.*?)\};`).FindSubmatch(b)
	if block == nil {
		t.Fatal("PIPELINE_RUN_TRANSITIONS not found")
	}
	line := regexp.MustCompile(`(\w+): \[([^\]]*)\]`)
	got := map[string][]string{}
	for _, m := range line.FindAllSubmatch(block[1], -1) {
		var to []string
		if err := json.Unmarshal([]byte("["+string(m[2])+"]"), &to); err != nil {
			t.Fatal(err)
		}
		got[string(m[1])] = to
	}
	a, _ := json.Marshal(got)
	w, _ := json.Marshal(RunTransitions)
	if string(a) != string(w) {
		t.Fatalf("contracts %s\ngo        %s", a, w)
	}
}

func TestKeys(t *testing.T) {
	k, err := JobKey("run_1", "derivatives", PartitionID(3))
	if err != nil || k != "run_1/derivatives/3" {
		t.Fatal(k, err)
	}
	if _, err := JobKey("../x", "s", "0"); !errors.Is(err, ErrBadID) {
		t.Fatal("path traversal accepted")
	}
	b, _ := CandidateBranch("run_1")
	if b != "pipeline/run_1" {
		t.Fatal(b)
	}
	key, err := StagingKey("run_1", "inspect", "0", 2, "items.json")
	if err != nil || key != "pipeline/run_1/inspect/0.2/items.json" {
		t.Fatal(key, err)
	}
	k1, _ := StagingKey("run_1", "inspect", "0", 1, "items.json")
	if k1 == key {
		t.Fatal("attempts share a key")
	}
	if _, err := StagingKey("run_1", "inspect", "0", 1, "../../main"); err == nil {
		t.Fatal("unsafe name accepted")
	}
	if EventKey("run_1", "pipeline.step.started", "inspect") != "run_1/pipeline.step.started/inspect" {
		t.Fatal("event key")
	}
}

func TestPartitions(t *testing.T) {
	p, err := Partitions(130, 64, 10)
	if err != nil || len(p) != 3 || p[2].Offset != 128 || p[2].Limit != 2 {
		t.Fatal(p, err)
	}
	if _, err := Partitions(10_000, 1, 1000); err == nil {
		t.Fatal("unbounded fan-out accepted")
	}
	if p, _ := Partitions(0, 64, 1); len(p) != 0 {
		t.Fatal(p)
	}
}

func TestRetryable(t *testing.T) {
	if !Retryable(ErrClassTransient) || Retryable(ErrClassInvalidInput) || Retryable(ErrClassPolicyDenied) {
		t.Fatal("retry classes")
	}
	if e := NewError(ErrClassWorkerCrash, "lease_lost", "The worker stopped."); !e.Retryable {
		t.Fatal("worker crash should retry")
	}
}
