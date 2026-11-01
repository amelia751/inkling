package config

import (
	"strings"
	"testing"
	"time"
)

func lookup(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestFromEnvDefaultsAndPrefix(t *testing.T) {
	n := Naming{EnvPrefix: "X_", ResourcePrefix: "x"}
	c, err := FromEnv(n, lookup(map[string]string{
		"X_PIPELINE_DATABASE_URL":        "postgres://u@h/studio",
		"X_PIPELINE_ENGINE_DATABASE_URL": "postgres://u@h/pipeline_engine",
		"X_PIPELINE_API_URL":             "http://api:8000",
		"X_PIPELINE_API_TOKEN":           "t",
		"X_PIPELINE_APP_VERSION":         "sha256:abc",
		"X_PIPELINE_ENGINE_RETENTION":    "7d",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8095 || c.RunDeadline != 24*time.Hour || c.DrainDeadline != 72*time.Hour {
		t.Fatalf("defaults: %+v", c)
	}
	if c.EngineRetention != 7*24*time.Hour || c.VersioningJWTKID != "pipeline" || c.DBPoolMax != 8 {
		t.Fatalf("parsed: %+v", c)
	}
}

func TestFromEnvNamesMissingAndInvalidKeysOnly(t *testing.T) {
	_, err := FromEnv(Naming{EnvPrefix: "X_"}, lookup(map[string]string{
		"X_PIPELINE_DATABASE_URL": "mysql://secret-value@h/db",
		"X_PIPELINE_PORT":         "-1",
		"X_PIPELINE_RUN_DEADLINE": "100h",
	}))
	if err == nil {
		t.Fatal("want error")
	}
	msg := err.Error()
	for _, want := range []string{"X_PIPELINE_ENGINE_DATABASE_URL", "X_PIPELINE_API_TOKEN", "X_PIPELINE_APP_VERSION",
		"invalid: ", "X_PIPELINE_DATABASE_URL", "X_PIPELINE_PORT", "X_PIPELINE_DRAIN_DEADLINE"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "secret-value") {
		t.Errorf("error leaks a value: %q", msg)
	}
}

func TestEngineEnvRefused(t *testing.T) {
	got := engineEnvSet([]string{"PATH=/bin", "DBOS__APPVERSION=x", "DBOS__CLOUD=true", "XDBOS_=1"})
	if strings.Join(got, ",") != "DBOS__APPVERSION,DBOS__CLOUD" {
		t.Fatalf("got %v", got)
	}
}
