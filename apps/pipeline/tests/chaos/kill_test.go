//go:build chaos

package chaos_test

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	osexec "os/exec"
	"syscall"
	"testing"
	"time"

	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/kernel/kernelfake"
	"studio.local/pipeline/internal/testenv"
)

// childSpec configures the pipeline process TestHelperPipelineProcess runs.
type childSpec struct {
	EngineURL string `json:"engine_url"`
	StudioURL string `json:"studio_url"`
	KernelURL string `json:"kernel_url"`
	StartRun  string `json:"start_run,omitempty"`
}

var childFlag = flag.String("chaos-child", "", "internal: run as a pipeline process (JSON childSpec)")

// TestHelperPipelineProcess is the pipeline process TestRecoveryAfterKill starts and kills.
// It does nothing in a normal run.
func TestHelperPipelineProcess(t *testing.T) {
	if *childFlag == "" {
		t.Skip("helper process only")
	}
	var spec childSpec
	if err := json.Unmarshal([]byte(*childFlag), &spec); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	studio := pool(t, spec.StudioURL, 4)
	e := testenv.Engine(t, spec.EngineURL, "wf-1", "pipeline-0", 10) // a StatefulSet pod: stable executor ID
	y := &toy{db: studio, k: kernel.New(spec.KernelURL, testenv.Token), pollAfter: 30 * time.Second}
	y.register(t, e)
	if err := e.Launch(ctx); err != nil {
		t.Fatal(err)
	}
	testenv.StartConsumerURL(spec.KernelURL, e)
	if spec.StartRun != "" {
		exec(t, studio, `INSERT INTO chaos_runs (run_id, workspace, state) VALUES ($1, 'ws1', 'queued') ON CONFLICT DO NOTHING`, spec.StartRun)
		if _, err := e.Start(ctx, engine.StartRequest{Workflow: "pipeline-run", ID: spec.StartRun,
			Input: engine.Input(runInput{RunID: spec.StartRun, Workspace: "ws1"})}); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(5 * time.Minute) // until killed
}

// TestRecoveryAfterKill (§7 gate "Recovery after a pipeline pod is killed mid-step: the run
// resumes from its last completed step, no duplicate kernel jobs"). A real pipeline process
// is SIGKILLed while its run waits on a kernel job; the job finishes while no pipeline is
// up; the restarted process (same executor ID) recovers the run.
func TestRecoveryAfterKill(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns processes")
	}
	studioURL := newDB(t)
	studio := pool(t, studioURL, 4)
	exec(t, studio, toyDDL)
	engineURL := newDB(t)
	release := make(chan struct{})
	k := testenv.Kernel(t, kernelfake.Options{Workers: 2, ClaimInterval: 20 * time.Millisecond, LongPoll: 2 * time.Second,
		Work: func(j kernelfake.Job) kernelfake.Outcome {
			if j.Kind == "inspect" {
				<-release
			}
			return kernelfake.Outcome{Duration: 50 * time.Millisecond, ResultRef: "blob://r"}
		}})
	y := &toy{db: studio}
	spawn := func(spec childSpec) *osexec.Cmd {
		spec.EngineURL, spec.StudioURL, spec.KernelURL = engineURL, studioURL, k.URL()
		b, _ := json.Marshal(spec)
		cmd := osexec.Command(os.Args[0], "-test.run=^TestHelperPipelineProcess$", "-test.timeout=10m", "-chaos-child="+string(b)) //nolint:gosec // the test binary itself
		cmd.Env = os.Environ()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}

	first := spawn(childSpec{StartRun: "kill_000"})
	waitUntil(t, 2*time.Minute, "the inspect job to run", func() bool {
		for _, j := range k.Jobs() {
			if j.Kind == "inspect" && j.State == kernel.StateRunning {
				return true
			}
		}
		return false
	})
	_ = first.Process.Signal(syscall.SIGKILL)
	_ = first.Wait()
	killedAt := time.Now()
	close(release) // the kernel finishes the job with no pipeline up
	waitUntil(t, time.Minute, "the job to finish", func() bool {
		for _, j := range k.Jobs() {
			if j.Kind == "inspect" {
				return j.State == kernel.StateSucceeded
			}
		}
		return false
	})

	restartAt := time.Now()
	spawn(childSpec{})
	waitUntil(t, 3*time.Minute, "the run to reach review", func() bool { return len(y.inState(t, "awaiting_review")) == 1 })
	recovered := time.Since(restartAt)

	jobs := k.Jobs()
	perKind := map[string]int{}
	for _, j := range jobs {
		perKind[j.Kind]++
	}
	marks := y.count(t, `SELECT count(*) FROM chaos_effects WHERE run_id = 'kill_000' AND step = 'mark-running'`)
	gate(t, "kill: SIGKILL mid-step; restarted %s after the kill; run resumed and reached review %s after restart",
		restartAt.Sub(killedAt).Round(time.Millisecond), recovered.Round(time.Millisecond))
	gate(t, "kill: kernel jobs inspect=%d validate=%d (want 1 each); enqueue calls %d; completed step re-run %d times (want 0)",
		perKind["inspect"], perKind["validate"], k.Requests()["POST /api/v1/service/jobs"], marks-1)
	if perKind["inspect"] != 1 || perKind["validate"] != 1 || marks != 1 {
		t.Fatalf("duplicates: jobs %v, first step ran %d times", perKind, marks)
	}
}
