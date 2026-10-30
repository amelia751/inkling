import { afterAll, describe, expect, it } from "vitest";
import type { Sandbox } from "@daytona/sdk";
import { execCommand } from "../../src/sandbox/exec.ts";
import { ensureSnapshot, getSnapshotStatus } from "../../src/sandbox/snapshot.ts";
import { LIVE_LABELS, config, daytona, live, runId } from "./setup.ts";

/**
 * Slow and manual: builds the snapshot if it's missing (minutes), then checks a sandbox from it has
 * the scientific stack. Run with INKLING_SNAPSHOT_LIVE=1 pnpm agent:live.
 */
const enabled = live && process.env.INKLING_SNAPSHOT_LIVE === "1";
let sandbox: Sandbox | undefined;

describe.skipIf(!enabled)("snapshot (live, manual)", () => {
  afterAll(async () => {
    await sandbox?.delete(60).catch((e) => console.error("cleanup failed", e));
  }, 120_000);

  it("builds or finds the content-hashed snapshot; a sandbox from it imports pydicom and nibabel", async () => {
    const name = await ensureSnapshot(daytona!, { onLogs: (c) => process.stdout.write(c) });
    expect(await getSnapshotStatus(daytona!, name)).toMatchObject({ state: "active" });
    sandbox = await daytona!.create(
      { snapshot: name, labels: { app: "inkling", env: config.env, session: runId(), ...LIVE_LABELS }, autoDeleteInterval: 30, autoStopInterval: 10 },
      { timeout: 180 },
    );
    const res = await execCommand(sandbox, `python3 -c "import pydicom, nibabel, SimpleITK, numpy, cv2; print('stack-ok', pydicom.__version__)"; rg --version | head -1`);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("stack-ok");
    expect(res.output).toMatch(/ripgrep/);
  }, 3_600_000);
});
