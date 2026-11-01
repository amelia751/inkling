// Package config parses the pipeline service's environment once into a typed struct.
//
// Env var names are not hardcoded to a brand: the env prefix comes from the naming config
// (schemas/naming.json), located through NAMING_FILE (the one unprefixed name: the prefix is
// read from it) or by walking up from the working directory, as apps/versioning does. This
// package is the only place the service reads the environment (`pnpm check:names`).
//
// The engine library (DBOS Transact) reads a handful of its own DBOS_* variables (application
// version, executor ID, cloud/Conductor mode). The pipeline's engine configuration comes only
// from our keys, so Load refuses to start when any of those is set.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// BuildAppVersion is the workflow package digest baked in at build time
// (-ldflags -X …/internal/config.BuildAppVersion=…, scripts/workflow-digest.sh). It is the
// default for PIPELINE_APP_VERSION; one of the two must be set.
var BuildAppVersion = ""

// Naming mirrors the fields of schemas/naming.json that this service reads.
type Naming struct {
	ResourcePrefix string `json:"resourcePrefix"`
	EnvPrefix      string `json:"envPrefix"`
}

// Config is the validated service configuration (todo12 §6). Keys are written without
// the prefix: PIPELINE_PORT means <envPrefix>PIPELINE_PORT.
type Config struct {
	Naming Naming

	Port              int    // PIPELINE_PORT (default 8095)
	DatabaseURL       string // PIPELINE_DATABASE_URL: database studio, schema pipeline
	EngineDatabaseURL string // PIPELINE_ENGINE_DATABASE_URL: database pipeline_engine (DBOS state)
	DBPoolMax         int    // PIPELINE_DB_POOL_MAX: per-pod pool size, per database

	APIURL   string // PIPELINE_API_URL: the kernel's service routes
	APIToken string // PIPELINE_API_TOKEN: the service:pipeline principal's token

	VersioningURL        string // PIPELINE_VERSIONING_URL
	VersioningJWTKID     string // PIPELINE_VERSIONING_JWT_KID (default "pipeline")
	VersioningJWTKeyFile string // PIPELINE_VERSIONING_JWT_KEY_FILE
	APIJWKSFile          string // PIPELINE_API_JWKS_FILE: verifies the api's calls (kid "api")

	AppVersion      string        // PIPELINE_APP_VERSION: workflow package digest, set at build time
	ExecutorID      string        // PIPELINE_EXECUTOR_ID: stable per replica (defaults to the hostname)
	RunDeadline     time.Duration // PIPELINE_RUN_DEADLINE (24h)
	DrainDeadline   time.Duration // PIPELINE_DRAIN_DEADLINE (72h)
	EngineRetention time.Duration // PIPELINE_ENGINE_RETENTION (30d)
}

// LoadNaming reads the naming config. A missing file falls back to brand-free defaults so
// the service still starts in isolation (tests, a lone checkout).
func LoadNaming() (Naming, error) {
	n := Naming{ResourcePrefix: "studio", EnvPrefix: ""}
	path := os.Getenv("NAMING_FILE")
	if path == "" {
		path = findUp("schemas/naming.json")
	}
	if path == "" {
		return n, nil
	}
	b, err := os.ReadFile(path) //nolint:gosec // operator-controlled path to the naming config
	if err != nil {
		return n, fmt.Errorf("read naming config: %w", err)
	}
	var f Naming
	if err := json.Unmarshal(b, &f); err != nil {
		return n, fmt.Errorf("parse naming config: %w", err)
	}
	if f.ResourcePrefix != "" {
		n.ResourcePrefix = f.ResourcePrefix
	}
	n.EnvPrefix = f.EnvPrefix
	return n, nil
}

func findUp(rel string) string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		p := filepath.Join(dir, rel)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// Env reads one setting outside Config (tests, chaos runs): Env(n, "PIPELINE_TEST_DATABASE_URL")
// reads <envPrefix>PIPELINE_TEST_DATABASE_URL.
func Env(naming Naming, key string) string { return os.Getenv(naming.EnvPrefix + key) }

// Hostname is the default executor ID: a pod name in Kubernetes, a container ID in compose.
func Hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "local"
	}
	return h
}

// Load parses the environment. Errors name the missing or invalid keys only, never values.
func Load() (*Config, error) {
	naming, err := LoadNaming()
	if err != nil {
		return nil, err
	}
	if bad := engineEnvSet(os.Environ()); len(bad) > 0 {
		return nil, fmt.Errorf("config: engine settings come only from %sPIPELINE_*; unset %s", naming.EnvPrefix, strings.Join(bad, ", "))
	}
	return FromEnv(naming, os.LookupEnv)
}

// Migrate is what cmd/migrate needs: the two database URLs only.
type Migrate struct {
	DatabaseURL       string
	EngineDatabaseURL string
}

// LoadMigrate reads PIPELINE_DATABASE_URL and PIPELINE_ENGINE_DATABASE_URL.
func LoadMigrate() (*Migrate, error) {
	naming, err := LoadNaming()
	if err != nil {
		return nil, err
	}
	if bad := engineEnvSet(os.Environ()); len(bad) > 0 {
		return nil, fmt.Errorf("config: unset %s", strings.Join(bad, ", "))
	}
	p := &parser{prefix: naming.EnvPrefix + "PIPELINE_", lookup: os.LookupEnv}
	m := &Migrate{DatabaseURL: p.required("DATABASE_URL"), EngineDatabaseURL: p.required("ENGINE_DATABASE_URL")}
	p.validate(&Config{DatabaseURL: m.DatabaseURL, EngineDatabaseURL: m.EngineDatabaseURL})
	if len(p.missing)+len(p.invalid) > 0 {
		return nil, p.err()
	}
	return m, nil
}

// engineEnvSet lists the DBOS library's own variables present in environ. DBOS__APPVERSION
// and DBOS__VMID would override our application version and executor ID; DBOS__CLOUD and the
// conductor keys would connect DBOS Conductor, which must never receive pipeline state.
func engineEnvSet(environ []string) []string {
	var bad []string
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "DBOS_") {
			bad = append(bad, k)
		}
	}
	sort.Strings(bad)
	return bad
}

// FromEnv builds a Config from a lookup function (os.LookupEnv in production).
func FromEnv(naming Naming, lookup func(string) (string, bool)) (*Config, error) {
	p := &parser{prefix: naming.EnvPrefix + "PIPELINE_", lookup: lookup}
	c := &Config{Naming: naming}

	c.Port = p.positive("PORT", 8095)
	c.DatabaseURL = p.required("DATABASE_URL")
	c.EngineDatabaseURL = p.required("ENGINE_DATABASE_URL")
	c.DBPoolMax = p.positive("DB_POOL_MAX", 8)

	c.APIURL = p.required("API_URL")
	c.APIToken = p.required("API_TOKEN")

	c.VersioningURL = p.str("VERSIONING_URL", "")
	c.VersioningJWTKID = p.str("VERSIONING_JWT_KID", "pipeline")
	c.VersioningJWTKeyFile = p.str("VERSIONING_JWT_KEY_FILE", "")
	c.APIJWKSFile = p.str("API_JWKS_FILE", "")

	if c.AppVersion = p.str("APP_VERSION", BuildAppVersion); c.AppVersion == "" {
		p.missing = append(p.missing, p.key("APP_VERSION"))
	}
	c.ExecutorID = p.str("EXECUTOR_ID", Hostname())
	c.RunDeadline = p.duration("RUN_DEADLINE", 24*time.Hour)
	c.DrainDeadline = p.duration("DRAIN_DEADLINE", 72*time.Hour)
	c.EngineRetention = p.duration("ENGINE_RETENTION", 30*24*time.Hour)

	p.validate(c)
	if len(p.missing)+len(p.invalid) > 0 {
		return nil, p.err()
	}
	return c, nil
}

type parser struct {
	prefix  string
	lookup  func(string) (string, bool)
	missing []string
	invalid []string
}

func (p *parser) key(k string) string { return p.prefix + k }

func (p *parser) str(k, def string) string {
	if v, ok := p.lookup(p.key(k)); ok && v != "" {
		return v
	}
	return def
}

func (p *parser) required(k string) string {
	v, ok := p.lookup(p.key(k))
	if !ok || v == "" {
		p.missing = append(p.missing, p.key(k))
	}
	return v
}

func (p *parser) positive(k string, def int) int {
	v, ok := p.lookup(p.key(k))
	if !ok || v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		p.invalid = append(p.invalid, p.key(k))
	}
	return n
}

// duration accepts Go durations plus a day suffix ("30d"), the unit §6 is written in.
func (p *parser) duration(k string, def time.Duration) time.Duration {
	v, ok := p.lookup(p.key(k))
	if !ok || v == "" {
		return def
	}
	d, err := ParseDuration(v)
	if err != nil || d <= 0 {
		p.invalid = append(p.invalid, p.key(k))
	}
	return d
}

// ParseDuration is time.ParseDuration plus whole days ("30d").
func ParseDuration(v string) (time.Duration, error) {
	if days, ok := strings.CutSuffix(v, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return time.ParseDuration(v)
}

func (p *parser) validate(c *Config) {
	for k, v := range map[string]string{"DATABASE_URL": c.DatabaseURL, "ENGINE_DATABASE_URL": c.EngineDatabaseURL} {
		if v == "" {
			continue
		}
		if u, err := url.Parse(v); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			p.invalid = append(p.invalid, p.key(k))
		}
	}
	for k, v := range map[string]string{"API_URL": c.APIURL, "VERSIONING_URL": c.VersioningURL} {
		if v == "" {
			continue
		}
		if u, err := url.Parse(v); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			p.invalid = append(p.invalid, p.key(k))
		}
	}
	if c.Port > 65535 {
		p.invalid = append(p.invalid, p.key("PORT"))
	}
	// The drain deadline is the run lifetime plus a margin (P§5.2).
	if c.RunDeadline > 0 && c.DrainDeadline > 0 && c.DrainDeadline < c.RunDeadline {
		p.invalid = append(p.invalid, p.key("DRAIN_DEADLINE"))
	}
}

func (p *parser) err() error {
	sort.Strings(p.missing)
	sort.Strings(p.invalid)
	var parts []string
	if len(p.missing) > 0 {
		parts = append(parts, "missing: "+strings.Join(p.missing, ", "))
	}
	if len(p.invalid) > 0 {
		parts = append(parts, "invalid: "+strings.Join(p.invalid, ", "))
	}
	return errors.New("config: " + strings.Join(parts, "; "))
}
