package service

import (
	"math/rand"
	"testing"
	"testing/quick"
)

// Random walks over the transition table, applying the service's guards,
// never reach MERGED unless the current source oid has the required
// approvals and passing mandatory checks (todo4 2.5; acceptance row 3).
func TestReviewStateMachineProperty(t *testing.T) {
	type model struct {
		status    string
		source    int
		approvals map[int]int  // source oid -> approvals
		passed    map[int]bool // source oid -> mandatory checks passed
	}
	const required = 1
	f := func(seed int64) bool {
		r := rand.New(rand.NewSource(seed))
		m := model{status: StDraft, approvals: map[int]int{}, passed: map[int]bool{}}
		for step := 0; step < 200; step++ {
			switch r.Intn(6) {
			case 0: // push to source: new oid, back to CHECKING where allowed
				m.source++
				if CanTransition(m.status, StChecking) && m.status != StMerging {
					m.status = StChecking
				}
			case 1: // approve current source
				switch m.status {
				case StOpen, StChecking, StReady, StBlocked, StConflicted:
					m.approvals[m.source]++
				}
			case 2: // checks complete for the current source
				if m.status == StChecking {
					if r.Intn(3) > 0 {
						m.passed[m.source] = true
						m.status = StReady
					} else {
						m.status = []string{StBlocked, StConflicted}[r.Intn(2)]
					}
				}
			case 3: // merge attempt
				if MergeAllowed(m.status, m.approvals[m.source], required, m.passed[m.source]) && CanTransition(m.status, StMerging) {
					m.status = StMerging
					if r.Intn(4) == 0 { // stale target
						m.status = StChecking
					} else if CanTransition(StMerging, StMerged) {
						m.status = StMerged
					}
				}
			case 4: // any other table edge except the guarded ones
				next := Transitions[m.status]
				if len(next) == 0 {
					break
				}
				to := next[r.Intn(len(next))]
				if to == StReady || to == StMerging || to == StMerged {
					break // only reachable through their guards above
				}
				m.status = to
			case 5:
				if m.status == StDraft {
					m.status = StOpen
				}
			}
			if m.status == StMerged {
				return m.approvals[m.source] >= required && m.passed[m.source]
			}
		}
		return true
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 2000}); err != nil {
		t.Fatal(err)
	}
}

func TestTransitionTableMatchesSpec(t *testing.T) {
	must := [][2]string{{StDraft, StOpen}, {StOpen, StChecking}, {StChecking, StReady}, {StReady, StMerging},
		{StMerging, StMerged}, {StChecking, StBlocked}, {StReady, StConflicted}, {StOpen, StClosed}, {StReady, StClosed},
		{StBlocked, StClosed}, {StConflicted, StClosed}}
	for _, e := range must {
		if !CanTransition(e[0], e[1]) {
			t.Errorf("missing spec edge %s -> %s", e[0], e[1])
		}
	}
	mustNot := [][2]string{{StChecking, StMerged}, {StOpen, StMerged}, {StBlocked, StMerging}, {StConflicted, StMerging},
		{StMerged, StOpen}, {StClosed, StOpen}, {StDraft, StMerged}}
	for _, e := range mustNot {
		if CanTransition(e[0], e[1]) {
			t.Errorf("forbidden edge %s -> %s present", e[0], e[1])
		}
	}
	for from, tos := range Transitions {
		for _, to := range tos {
			if to == StMerged && from != StMerging {
				t.Errorf("MERGED reachable from %s", from)
			}
		}
	}
}

func TestBranchNames(t *testing.T) {
	good := []string{"main", "work/alice/labels", "review/fix-labels", "release-1.2", "a"}
	bad := []string{"", "HEAD", "head", "Main", "-x", ".x", "a..b", "a//b", "a@{1}", "a/", "a.lock", "a/.hidden", "a\x00b",
		"a b", "ä", string(make([]byte, 200))}
	for _, n := range good {
		if err := ValidateBranchName(n); err != nil {
			t.Errorf("%q rejected: %v", n, err)
		}
	}
	for _, n := range bad {
		if ValidateBranchName(n) == nil {
			t.Errorf("%q accepted", n)
		}
	}
}
