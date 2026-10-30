//go:build load

package load

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"

	"studio.local/versioning/internal/testenv"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func copyFromContainer(ctx context.Context, pg *testenv.Postgres, src, dst string) error {
	rc, err := pg.Container.CopyFileFromContainer(ctx, src)
	if err != nil {
		return err
	}
	defer rc.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, rc)
	return err
}

func restoreInto(ctx context.Context, pg *testenv.Postgres, dump string) error {
	if err := pg.Container.CopyFileToContainer(ctx, dump, "/tmp/v.dump", 0o644); err != nil {
		return err
	}
	code, out, err := pg.Container.Exec(ctx, []string{"pg_restore", "-U", "postgres", "-d", "studio", "--clean", "--if-exists", "/tmp/v.dump"})
	if err != nil {
		return err
	}
	if code != 0 {
		b, _ := io.ReadAll(out)
		return fmt.Errorf("pg_restore exit %d: %s", code, b)
	}
	return nil
}
