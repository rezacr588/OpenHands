// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const entrypoint = readFileSync(
  path.join(repoRoot, "docker/entrypoint.sh"),
  "utf-8",
);
const persistenceSetup = entrypoint.slice(
  entrypoint.indexOf("# Persistence paths"),
  entrypoint.indexOf("# OH_SECRET_KEY is required"),
);

function initializePersistence(homeDir: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        'log_error() { printf "%s\\n" "$*" >&2; }',
        persistenceSetup,
      ].join("\n"),
    ],
    {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: homeDir },
    },
  );
}

describe.skipIf(process.platform === "win32")(
  "Docker default workspace",
  () => {
    let directory: string;
    let volume: string;

    beforeEach(() => {
      directory = mkdtempSync(path.join(tmpdir(), "docker-workspace-"));
      volume = path.join(directory, "persistent-state");
      mkdirSync(volume);
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    function containerHome(name: string): string {
      const homeDir = path.join(directory, name);
      mkdirSync(homeDir);
      symlinkSync(volume, path.join(homeDir, ".openhands"), "dir");
      return homeDir;
    }

    it("retains default conversation files when a new container reuses the state volume", () => {
      const firstHome = containerHome("first-container");
      expect(initializePersistence(firstHome).status).toBe(0);
      const relativeFile = "workspace/project/conversation/keep.txt";
      const firstFile = path.join(firstHome, relativeFile);
      mkdirSync(path.dirname(firstFile), { recursive: true });
      writeFileSync(firstFile, "saved conversation work\n");
      expect(initializePersistence(firstHome).status).toBe(0);

      const replacementHome = containerHome("replacement-container");
      expect(initializePersistence(replacementHome).status).toBe(0);

      expect(
        readFileSync(path.join(replacementHome, relativeFile), "utf-8"),
      ).toBe("saved conversation work\n");
    });

    it.each(["directory", "symlink"])(
      "preserves an existing workspace %s and its contents",
      (kind) => {
        const homeDir = containerHome("custom-workspace");
        const workspace = path.join(homeDir, "workspace");
        const target =
          kind === "directory" ? workspace : path.join(directory, "custom");
        mkdirSync(target);
        if (kind === "symlink") symlinkSync(target, workspace, "dir");
        writeFileSync(path.join(target, "keep.txt"), "user workspace\n");

        expect(initializePersistence(homeDir).status).toBe(0);

        expect(realpathSync(workspace)).toBe(realpathSync(target));
        expect(readFileSync(path.join(workspace, "keep.txt"), "utf-8")).toBe(
          "user workspace\n",
        );
      },
    );

    it("fails startup rather than using ephemeral storage when persistence cannot be prepared", () => {
      const homeDir = containerHome("unavailable-persistence");
      writeFileSync(path.join(volume, "workspace"), "not a directory");

      const result = initializePersistence(homeDir);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(existsSync(path.join(homeDir, "workspace"))).toBe(false);
    });
  },
);
