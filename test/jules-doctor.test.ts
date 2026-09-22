import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_AGENT_RUNTIMES } from "@backnotprop/orchestrator-core/runtime";
import { doctorRuntimeAvailability } from "../packages/cli/src/runtime-doctor.ts";
import { runCli, withTempWorkspace } from "./cli-support.ts";

async function installFakeCjules(
  workspaceRoot: string,
  scriptContent: string,
): Promise<{ binDir: string; env: Record<string, string> }> {
  const binDir = join(workspaceRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "cjules");
  await writeFile(binPath, `#!/bin/sh\n${scriptContent}\n`);
  await chmod(binPath, 0o755);

  return {
    binDir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  };
}

test("doctor reports jules as unavailable with install suggestion when cjules is missing", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const checks = await doctorRuntimeAvailability(
      { jules: BUILT_IN_AGENT_RUNTIMES.jules },
      {
        cwd: workspaceRoot,
        env: { PATH: "/nonexistent/empty/path" },
      },
    );

    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.equal(check.id, "jules");
    assert.equal(check.displayName, "Jules");
    assert.equal(check.executable, "cjules");
    assert.equal(check.available, false);
    assert.match(check.message, /not found on PATH/);
    assert.match(check.suggestion ?? "", /npm install -g cjules/);
  }, "jules-doc-missing-");
});

test("doctor reports jules as unavailable with auth warning and login suggestion when unauthenticated", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await installFakeCjules(
      workspaceRoot,
      'if [ "$1" = "account" ]; then echo "No accounts configured."; exit 0; fi; exit 1',
    );

    const checks = await doctorRuntimeAvailability(
      { jules: BUILT_IN_AGENT_RUNTIMES.jules },
      {
        cwd: workspaceRoot,
        env,
      },
    );

    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.equal(check.id, "jules");
    assert.equal(check.executable, "cjules");
    assert.equal(check.available, false);
    assert.ok(check.path);
    assert.match(check.message, /no active Jules account was found/);
    assert.match(check.suggestion ?? "", /cjules login/);
  }, "jules-doc-unauth-");
});

test("doctor reports jules as available when cjules has an active account", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await installFakeCjules(
      workspaceRoot,
      'if [ "$1" = "account" ]; then echo "* my-active-account    ***secretKey"; exit 0; fi; exit 1',
    );

    const checks = await doctorRuntimeAvailability(
      { jules: BUILT_IN_AGENT_RUNTIMES.jules },
      {
        cwd: workspaceRoot,
        env,
      },
    );

    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.equal(check.id, "jules");
    assert.equal(check.executable, "cjules");
    assert.equal(check.available, true);
    assert.ok(check.path);
    assert.match(check.message, /active account: my-active-account/);
  }, "jules-doc-auth-");
});

test("CLI doctor --json includes jules in runtimes and adds suggestion when unauthenticated", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await installFakeCjules(
      workspaceRoot,
      'if [ "$1" = "account" ]; then echo "No accounts found."; exit 0; fi; exit 1',
    );

    const result = await runCli(
      workspaceRoot,
      ["doctor", "--workspace", workspaceRoot, "--json", "--compact"],
      10_000,
      env,
    );

    const report = JSON.parse(result.stdout);
    const julesRuntime = report.runtimes?.find((r: { id: string }) => r.id === "jules");

    assert.ok(julesRuntime, "doctor report must include jules runtime");
    assert.equal(julesRuntime.id, "jules");
    assert.equal(julesRuntime.executable, "cjules");
    assert.equal(julesRuntime.available, false);
    assert.match(julesRuntime.suggestion ?? "", /cjules login/);
  }, "jules-doc-cli-");
});
