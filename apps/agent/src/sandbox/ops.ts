/**
 * Adapted from @daytona/pi (src/ops.ts).
 * Copyright Daytona Platforms Inc. SPDX-License-Identifier: Apache-2.0. See ../../NOTICE.
 *
 * pi's read/write/edit/ls tools take an `*Operations` object; these run against a Daytona
 * sandbox. (bash has its own execute in tools/sandbox.ts.) The tool factories get the sandbox cwd, so the absolute paths pi hands us are already
 * sandbox-rooted. Host `env` is never forwarded.
 */
import type { Sandbox } from "@daytona/sdk";
import type {
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { execCommand, shellQuote, withRecovery } from "./exec.ts";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const run = (sandbox: Sandbox, command: string) => execCommand(sandbox, command, { backgroundSafe: false });

export function createReadOps(sandbox: Sandbox): ReadOperations {
  return {
    readFile: (path) => withRecovery(sandbox, () => sandbox.fs.downloadFile(path)),
    access: async (path) => {
      const { exitCode } = await run(sandbox, `test -r ${shellQuote(path)}`);
      if (exitCode !== 0) throw new Error(`File not readable: ${path}`);
    },
    detectImageMimeType: async (path) => {
      try {
        const { output } = await run(sandbox, `file --mime-type -b ${shellQuote(path)}`);
        const mime = output.trim();
        return IMAGE_MIME_TYPES.has(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

export function createWriteOps(sandbox: Sandbox): WriteOperations {
  return {
    writeFile: (path, content) =>
      withRecovery(sandbox, () => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path)),
    mkdir: async (dir) => {
      const { exitCode } = await run(sandbox, `mkdir -p ${shellQuote(dir)}`);
      if (exitCode !== 0) throw new Error(`Failed to create directory: ${dir}`);
    },
  };
}

/** pi applies the exact oldText→newText edit in-process (keeping its uniqueness checks); we download and upload. */
export function createEditOps(sandbox: Sandbox): EditOperations {
  return {
    readFile: (path) => withRecovery(sandbox, () => sandbox.fs.downloadFile(path)),
    writeFile: (path, content) =>
      withRecovery(sandbox, () => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path)),
    access: async (path) => {
      const q = shellQuote(path);
      const { exitCode } = await run(sandbox, `test -r ${q} && test -w ${q}`);
      if (exitCode !== 0) throw new Error(`File not readable/writable: ${path}`);
    },
  };
}

export function createLsOps(sandbox: Sandbox): LsOperations {
  return {
    exists: async (path) => (await run(sandbox, `test -e ${shellQuote(path)}`)).exitCode === 0,
    stat: async (path) => {
      const q = shellQuote(path);
      const { output, exitCode } = await run(sandbox, `test -e ${q} || exit 1; test -d ${q} && echo dir || echo other`);
      if (exitCode !== 0) throw new Error(`Path not found: ${path}`);
      const isDir = output.trim() === "dir";
      return { isDirectory: () => isDir };
    },
    readdir: async (path) => {
      const { output, exitCode } = await run(sandbox, `ls -1A ${shellQuote(path)}`);
      if (exitCode !== 0) throw new Error(`Failed to read directory: ${path}`);
      return output.split("\n").filter((line) => line.length > 0);
    },
  };
}
