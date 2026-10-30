package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LocalFS is a filesystem BlobStore for unit tests only.
type LocalFS struct{ Root string }

var _ BlobStore = (*LocalFS)(nil)

func (l *LocalFS) path(bucket, key string) (string, error) {
	p := filepath.Join(l.Root, bucket, filepath.FromSlash(key))
	if !strings.HasPrefix(p, filepath.Join(l.Root, bucket)+string(filepath.Separator)) {
		return "", fmt.Errorf("localfs: key escapes root")
	}
	return p, nil
}

func (l *LocalFS) write(bucket, key string, r io.Reader) error {
	p, err := l.path(bucket, key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

func (l *LocalFS) read(bucket, key string) ([]byte, error) {
	p, err := l.path(bucket, key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p) // #nosec G304 -- path confined to Root
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

// PutStaged verifies then writes the object.
func (l *LocalFS) PutStaged(_ context.Context, tenant, sha string, size int64, _ string, r io.Reader) error {
	if err := checkSHA(sha); err != nil {
		return err
	}
	vr := newVerifyingReader(io.LimitReader(r, size+1))
	buf, err := io.ReadAll(vr)
	if err != nil {
		return err
	}
	if err := vr.check(sha, size); err != nil {
		return err
	}
	return l.write("objects", ObjectKey(tenant, sha), bytes.NewReader(buf))
}

// Head stats the object.
func (l *LocalFS) Head(_ context.Context, tenant, sha string) (ObjectInfo, error) {
	p, err := l.path("objects", ObjectKey(tenant, sha))
	if err != nil {
		return ObjectInfo{}, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return ObjectInfo{}, ErrNotFound
	}
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{Size: st.Size()}, nil
}

// Get reads the object.
func (l *LocalFS) Get(_ context.Context, tenant, sha string, rng *Range) (io.ReadCloser, error) {
	b, err := l.read("objects", ObjectKey(tenant, sha))
	if err != nil {
		return nil, err
	}
	if rng != nil {
		b = b[rng.Start : rng.End+1]
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

// PresignGet returns a file URL; tests only.
func (l *LocalFS) PresignGet(_ context.Context, tenant, sha string, _ time.Duration) (string, error) {
	p, err := l.path("objects", ObjectKey(tenant, sha))
	return "file://" + p, err
}

// Delete removes the object.
func (l *LocalFS) Delete(_ context.Context, tenant, sha string) error {
	p, err := l.path("objects", ObjectKey(tenant, sha))
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// PutManifest writes a manifest document.
func (l *LocalFS) PutManifest(_ context.Context, key string, data []byte, _ string) error {
	return l.write("manifests", key, bytes.NewReader(data))
}

// GetManifest reads a manifest document.
func (l *LocalFS) GetManifest(_ context.Context, key string) ([]byte, error) {
	return l.read("manifests", key)
}

// DeleteManifest removes a manifest document.
func (l *LocalFS) DeleteManifest(_ context.Context, key string) error {
	p, err := l.path("manifests", key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// ListManifests walks manifest keys under prefix.
func (l *LocalFS) ListManifests(_ context.Context, prefix string, fn func(string, time.Time) error) error {
	base := filepath.Join(l.Root, "manifests")
	return filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".tmp-") {
			return nil
		}
		rel, _ := filepath.Rel(base, p)
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return fn(key, info.ModTime())
	})
}

// Ping always succeeds.
func (l *LocalFS) Ping(context.Context) error { return nil }
