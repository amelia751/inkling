import { DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { NAMING } from "../../src/naming.ts";

const RES = NAMING.resourcePrefix;

type Exec = (command: string, cwd?: string) => { exitCode: number; result: string } | Promise<{ exitCode: number; result: string }>;

/** In-memory stand-in for the parts of `Sandbox` the ops and recovery code touch. */
export class FakeSandbox {
  id = "fake-0000-sandbox";
  name = `${RES}-test-fake`;
  state: string | undefined = "started";
  labels: Record<string, string> = {};
  gone = false;
  files = new Map<string, Buffer>();
  calls: string[] = [];
  starts = 0;
  /** Fail the next N toolbox calls with this error (simulates auto-stop mid-session). */
  failNext: { count: number; error: Error } | undefined;
  exec: Exec = () => ({ exitCode: 0, result: "" });

  private trip() {
    if (this.gone) throw new Error("no such container");
    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count--;
      throw this.failNext.error;
    }
    if (this.state !== "started") throw new Error(`sandbox is ${this.state}`);
  }

  async refreshData() {
    if (this.gone) throw new DaytonaNotFoundError("Sandbox not found", 404);
  }
  async start() {
    this.starts++;
    this.state = "started";
  }
  async stop() {
    this.state = "stopped";
  }
  async refreshActivity() {}

  process = {
    executeCommand: async (command: string, cwd?: string) => {
      this.trip();
      this.calls.push(command);
      return this.exec(command, cwd);
    },
  };

  fs = {
    downloadFile: async (path: string) => {
      this.trip();
      const f = this.files.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      return f;
    },
    uploadFile: async (data: Buffer, path: string) => {
      this.trip();
      this.files.set(path, Buffer.from(data));
    },
    getFileDetails: async (path: string) => {
      this.trip();
      const f = this.files.get(path);
      if (!f) throw new Error(`not found: ${path}`);
      return { name: path.split("/").pop(), isDir: false, size: f.length };
    },
    createFolder: async (path: string) => {
      this.trip();
      this.calls.push(`mkdir ${path}`);
    },
  };

  asSandbox(): Sandbox {
    return this as unknown as Sandbox;
  }
}
