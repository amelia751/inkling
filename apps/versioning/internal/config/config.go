// Package config parses the service environment once into a typed struct.
//
// Env var and bucket names are not hardcoded to a brand (todo4 V11): the env
// prefix and resource prefix come from the naming config (schemas/naming.json),
// located through NAMING_FILE (the one unprefixed name: the prefix is read from
// it) or by walking up from the working directory. This package is the only
// place the service reads the environment.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Naming mirrors the fields of schemas/naming.json that this service reads.
type Naming struct {
	ResourcePrefix string `json:"resourcePrefix"`
	EnvPrefix      string `json:"envPrefix"`
}

// Config is the validated service configuration.
type Config struct {
	Naming Naming

	HTTPAddr      string
	DatabaseURL   string
	DefaultBranch string

	ObjectStore     string // "s3" (any S3-compatible store) or "gcs" (Cloud Storage, ADC only)
	ObjectEndpoint  string // empty means AWS default resolution
	ObjectRegion    string
	ObjectPathStyle bool
	ObjectBucket    string
	ManifestBucket  string
	S3AccessKeyID   string
	S3SecretKey     string

	JWTPublicKeyFile string
	JWTAudience      string
	JWTIssuer        string

	EventBus      string // "log" or "redis"
	RedisURL      string
	EventSubject  string // subject prefix, e.g. "versioning"
	DiffRulesDir  string // optional plugin-declared diff rules (V13)
	PurgeEnabled  bool   // V9: gated until the retention ADR is signed off
	GCSweepEnable bool

	MaxCommitEntries   int
	MaxDiffPageSize    int
	SyncDiffMaxEntries int
	MaxWalkDepth       int
	ChunkThreshold     int
	MaxBodyBytes       int64
	MaxArtifactBytes   int64
	TempDir            string
	StagedTTL          time.Duration
	GCGrace            time.Duration
	HistoryRetention   time.Duration
	BranchRetention    time.Duration
	IdempotencyTTL     time.Duration
	PresignTTL         time.Duration
	CheckoutLeaseTTL   time.Duration
	RequestTimeout     time.Duration
	RateDiffPerMinute  int
	RateCheckoutPerMin int
	GitCacheObjects    int
}

var bucketRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

// LoadNaming reads the naming config. A missing file falls back to brand-free
// defaults so the service still starts in isolation (tests, a lone checkout).
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

// Env reads one setting outside Config (scripts, tests): Env(n, "VERSIONING_LOAD_ENTRIES")
// reads <envPrefix>VERSIONING_LOAD_ENTRIES.
func Env(naming Naming, key string) string { return os.Getenv(naming.EnvPrefix + key) }

// Load parses the environment. Errors name the missing or invalid keys only,
// never their values.
func Load() (*Config, error) {
	naming, err := LoadNaming()
	if err != nil {
		return nil, err
	}
	return FromEnv(naming, os.LookupEnv)
}

// FromEnv builds a Config from a lookup function (os.LookupEnv in production).
func FromEnv(naming Naming, lookup func(string) (string, bool)) (*Config, error) {
	p := &parser{prefix: naming.EnvPrefix + "VERSIONING_", lookup: lookup}
	c := &Config{Naming: naming}

	c.HTTPAddr = p.str("HTTP_ADDR", ":8090")
	c.DatabaseURL = p.required("DATABASE_URL")
	c.DefaultBranch = p.str("DEFAULT_BRANCH", "main")

	c.ObjectStore = p.str("OBJECT_STORE", "s3")
	c.ObjectEndpoint = p.str("OBJECT_ENDPOINT", "")
	c.ObjectRegion = p.str("OBJECT_REGION", "us-east-1")
	c.ObjectPathStyle = p.boolean("OBJECT_PATH_STYLE", c.ObjectEndpoint != "")
	c.ObjectBucket = p.str("OBJECT_BUCKET", naming.ResourcePrefix+"-objects")
	c.ManifestBucket = p.str("MANIFEST_BUCKET", naming.ResourcePrefix+"-manifests")
	c.S3AccessKeyID = p.str("S3_ACCESS_KEY_ID", "")
	c.S3SecretKey = p.str("S3_SECRET_ACCESS_KEY", "")

	c.JWTPublicKeyFile = p.required("JWT_PUBLIC_KEY_FILE")
	c.JWTAudience = p.str("JWT_AUDIENCE", "versioning")
	c.JWTIssuer = p.str("JWT_ISSUER", "api")

	c.EventBus = p.str("EVENT_BUS", "log")
	c.RedisURL = p.str("REDIS_URL", "")
	c.EventSubject = p.str("EVENT_SUBJECT_PREFIX", "versioning")
	c.DiffRulesDir = p.str("DIFF_RULES_DIR", "")
	c.PurgeEnabled = p.boolean("PURGE_ENABLED", false)
	c.GCSweepEnable = p.boolean("GC_SWEEP_ENABLED", false)

	c.MaxCommitEntries = p.positive("MAX_COMMIT_ENTRIES", 1_000_000)
	c.MaxDiffPageSize = p.positive("MAX_DIFF_PAGE_SIZE", 1000)
	c.SyncDiffMaxEntries = p.positive("SYNC_DIFF_MAX_ENTRIES", 50_000)
	c.MaxWalkDepth = p.positive("MAX_WALK_DEPTH", 10_000)
	c.ChunkThreshold = p.positive("CHUNK_THRESHOLD", 10_000)
	c.MaxBodyBytes = int64(p.positive("MAX_BODY_BYTES", 64<<20))
	c.MaxArtifactBytes = int64(p.positive("MAX_ARTIFACT_MB", 50<<10)) << 20
	c.TempDir = p.str("TEMP_DIR", os.TempDir())
	c.StagedTTL = p.duration("STAGED_TTL", 24*time.Hour)
	c.GCGrace = time.Duration(p.positive("GC_GRACE_HOURS", 168)) * time.Hour
	c.HistoryRetention = p.duration("HISTORY_RETENTION", 30*24*time.Hour)
	c.BranchRetention = p.duration("BRANCH_RETENTION", 14*24*time.Hour)
	c.IdempotencyTTL = p.duration("IDEMPOTENCY_TTL", 24*time.Hour)
	c.PresignTTL = p.duration("PRESIGN_TTL", 5*time.Minute)
	c.CheckoutLeaseTTL = p.duration("CHECKOUT_LEASE_TTL", time.Hour)
	c.RequestTimeout = p.duration("REQUEST_TIMEOUT", 30*time.Second)
	c.RateDiffPerMinute = p.positive("RATE_DIFF_PER_MINUTE", 60)
	c.RateCheckoutPerMin = p.positive("RATE_CHECKOUT_PER_MINUTE", 60)
	c.GitCacheObjects = p.positive("GIT_CACHE_OBJECTS", 50_000)

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

func (p *parser) boolean(k string, def bool) bool {
	v, ok := p.lookup(p.key(k))
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		p.invalid = append(p.invalid, p.key(k))
	}
	return b
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

func (p *parser) duration(k string, def time.Duration) time.Duration {
	v, ok := p.lookup(p.key(k))
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		p.invalid = append(p.invalid, p.key(k))
	}
	return d
}

func (p *parser) validate(c *Config) {
	if c.DatabaseURL != "" {
		if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			p.invalid = append(p.invalid, p.key("DATABASE_URL"))
		}
	}
	if c.ObjectEndpoint != "" {
		if u, err := url.Parse(c.ObjectEndpoint); err != nil || u.Host == "" {
			p.invalid = append(p.invalid, p.key("OBJECT_ENDPOINT"))
		}
	}
	for k, b := range map[string]string{"OBJECT_BUCKET": c.ObjectBucket, "MANIFEST_BUCKET": c.ManifestBucket} {
		if !bucketRE.MatchString(b) {
			p.invalid = append(p.invalid, p.key(k))
		}
	}
	if c.ObjectStore != "s3" && c.ObjectStore != "gcs" {
		p.invalid = append(p.invalid, p.key("OBJECT_STORE"))
	}
	if (c.S3AccessKeyID == "") != (c.S3SecretKey == "") {
		p.invalid = append(p.invalid, p.key("S3_ACCESS_KEY_ID")+"/"+p.key("S3_SECRET_ACCESS_KEY"))
	}
	if c.PresignTTL > 5*time.Minute {
		p.invalid = append(p.invalid, p.key("PRESIGN_TTL"))
	}
	switch c.EventBus {
	case "log":
	case "redis":
		if c.RedisURL == "" {
			p.missing = append(p.missing, p.key("REDIS_URL"))
		}
	default:
		p.invalid = append(p.invalid, p.key("EVENT_BUS"))
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
