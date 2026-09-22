import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { repoRoot, withTempWorkspace } from "./cli-support.ts";

const wrapperPath = join(repoRoot, "examples/integrations/jules/orchestrator-jules");
const fakeCjulesScriptPath = join(repoRoot, "test/fixtures/fake-cjules.mjs");

async function setupFakeCjulesEnv(workspaceRoot: string, mode = "normal") {
  const binDir = join(workspaceRoot, "bin");
  await mkdir(binDir, { recursive: true });
  const fakeCjulesBin = join(binDir, "cjules");
  await writeFile(fakeCjulesBin, `#!/bin/sh\nexec node "${fakeCjulesScriptPath}" "$@"\n`);
  await chmod(fakeCjulesBin, 0o755);

  const stateFile = join(workspaceRoot, "fake-cjules-state.json");
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    FAKE_CJULES_STATE_FILE: stateFile,
    FAKE_CJULES_MODE: mode,
  };

  return { binDir, stateFile, env };
}

function runWrapper(
  args: string[],
  stdinInput: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapperPath, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    if (stdinInput) {
      child.stdin.write(stdinInput);
    }
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function parseJsonlLines(output: string): any[] {
  return output
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("orchestrator-jules run creates session and monitors to completion", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env, stateFile } = await setupFakeCjulesEnv(workspaceRoot, "normal");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Fix concurrency bug", env);

    assert.equal(result.code, 0);
    const events = parseJsonlLines(result.stdout);

    // 1. Emits agent.session first
    assert.deepEqual(events[0], {
      type: "agent.session",
      provider: "jules",
      sessionId: "fake-session-12345",
    });

    // 2. Emits state transitions
    const states = events.filter((e) => e.type === "jules.state").map((e) => e.state);
    assert.ok(states.includes("IN_PROGRESS"));
    assert.ok(states.includes("COMPLETED"));

    // 3. Emits activities
    const activities = events.filter((e) => e.type === "jules.activity");
    assert.ok(activities.length >= 2);
    assert.ok(activities.some((a) => a.activityType === "PROGRESS_UPDATED"));
    assert.ok(activities.some((a) => a.activityType === "AGENT_MESSAGED"));

    // 4. Emits final event
    const finalEvent = events.find((e) => e.type === "final");
    assert.ok(finalEvent);
    assert.equal(finalEvent.status, "completed");
    assert.equal(finalEvent.sessionId, "fake-session-12345");
    assert.equal(finalEvent.text, "Fixed race condition successfully.");

    // Check state file
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.sessions["fake-session-12345"].prompt, "Fix concurrency bug");
  }, "jules-run-");
});

test("orchestrator-jules run deduplicates activities across poll ticks", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await setupFakeCjulesEnv(workspaceRoot, "normal");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Test deduplication", env);

    assert.equal(result.code, 0);
    const events = parseJsonlLines(result.stdout);
    const activities = events.filter((e) => e.type === "jules.activity");
    const activityIds = activities.map((a) => a.activityId);
    const uniqueIds = new Set(activityIds);
    assert.equal(activityIds.length, uniqueIds.size, "All emitted activities must have unique IDs");
  }, "jules-dedup-");
});

test("orchestrator-jules run handles failure state cleanly", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await setupFakeCjulesEnv(workspaceRoot, "failed");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Failing prompt", env);

    assert.notEqual(result.code, 0);
    const events = parseJsonlLines(result.stdout);

    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent);
    assert.equal(errorEvent.state, "FAILED");
    assert.match(errorEvent.message, /Regression tests failed/);
  }, "jules-failed-");
});

test("orchestrator-jules run handles AWAITING_USER_FEEDBACK as needs_input and exits 0", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await setupFakeCjulesEnv(workspaceRoot, "needs_input");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Ambiguous prompt", env);

    assert.equal(result.code, 0);
    const events = parseJsonlLines(result.stdout);

    const finalEvent = events.find((e) => e.type === "final");
    assert.ok(finalEvent);
    assert.equal(finalEvent.status, "needs_input");
    assert.equal(finalEvent.sessionId, "fake-session-12345");
    assert.match(finalEvent.text, /Should I update the public API interface/);
  }, "jules-needs-input-");
});

test("orchestrator-jules run handles AWAITING_PLAN_APPROVAL as needs_approval and exits 0", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await setupFakeCjulesEnv(workspaceRoot, "needs_approval");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Plan prompt", env);

    assert.equal(result.code, 0);
    const events = parseJsonlLines(result.stdout);

    const finalEvent = events.find((e) => e.type === "final");
    assert.ok(finalEvent);
    assert.equal(finalEvent.status, "needs_approval");
    assert.equal(finalEvent.sessionId, "fake-session-12345");
    assert.match(finalEvent.text, /Refactor concurrency model/);
  }, "jules-needs-approval-");
});

test("orchestrator-jules resume sends message to same session without calling cjules new", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env, stateFile } = await setupFakeCjulesEnv(workspaceRoot, "normal");

    // Pre-populate state with existing session
    const initialState = {
      sessions: {
        "existing-session-999": {
          id: "existing-session-999",
          name: "sessions/existing-session-999",
          state: "IN_PROGRESS",
          messages: ["first prompt"],
        },
      },
      calls: [],
      mode: "normal",
      ticks: 0,
    };
    await writeFile(stateFile, JSON.stringify(initialState, null, 2));

    const result = await runWrapper(
      ["resume", "--session", "existing-session-999", "--poll-interval", "0.05"],
      "Follow-up answer",
      env,
    );

    assert.equal(result.code, 0);
    const events = parseJsonlLines(result.stdout);

    // Emits session event with same sessionId
    assert.deepEqual(events[0], {
      type: "agent.session",
      provider: "jules",
      sessionId: "existing-session-999",
    });

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const commandsCalled = state.calls.map((c: string[]) => c[0]);

    assert.ok(commandsCalled.includes("msg"), "Must call cjules msg");
    assert.ok(!commandsCalled.includes("new"), "Must NOT call cjules new during resume");
    assert.deepEqual(state.sessions["existing-session-999"].messages, [
      "first prompt",
      "Follow-up answer",
    ]);
  }, "jules-resume-");
});

test("orchestrator-jules monitor attaches to existing session without new or msg", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env, stateFile } = await setupFakeCjulesEnv(workspaceRoot, "normal");

    const initialState = {
      sessions: {
        "monitor-session-555": {
          id: "monitor-session-555",
          name: "sessions/monitor-session-555",
          state: "IN_PROGRESS",
        },
      },
      calls: [],
      mode: "normal",
      ticks: 0,
    };
    await writeFile(stateFile, JSON.stringify(initialState, null, 2));

    const result = await runWrapper(
      ["monitor", "--session", "monitor-session-555", "--poll-interval", "0.05"],
      "",
      env,
    );

    assert.equal(result.code, 0);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const commandsCalled = state.calls.map((c: string[]) => c[0]);

    assert.ok(!commandsCalled.includes("new"), "Must NOT call cjules new");
    assert.ok(!commandsCalled.includes("msg"), "Must NOT call cjules msg");
    assert.ok(commandsCalled.includes("get"), "Must call cjules get");
  }, "jules-monitor-");
});

test("orchestrator-jules safely passes complex prompts containing quotes and metacharacters via stdin", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env, stateFile } = await setupFakeCjulesEnv(workspaceRoot, "normal");
    const complexPrompt = `Hello; rm -rf /; $(whoami); \`echo pwned\`; "quotes" and 'single quotes' \n Newline!`;

    const result = await runWrapper(["run", "--poll-interval", "0.05"], complexPrompt, env);
    assert.equal(result.code, 0);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.sessions["fake-session-12345"].prompt, complexPrompt);
  }, "jules-stdin-safety-");
});

test("orchestrator-jules terminates child process cleanly on SIGTERM without deleting remote session", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env, stateFile } = await setupFakeCjulesEnv(workspaceRoot, "normal");

    const child = spawn(process.execPath, [wrapperPath, "run", "--poll-interval", "0.5"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();

    child.stdin.write("Long running prompt\n");
    child.stdin.end();

    // Wait briefly for process to start polling
    await new Promise((resolve) => setTimeout(resolve, 100));

    child.kill("SIGTERM");

    await new Promise((resolve) => {
      child.on("close", resolve);
    });

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.rmCalled, undefined, "Remote session MUST NOT be deleted on interrupt");
  }, "jules-sigterm-");
});

test("orchestrator-jules fails gracefully when cjules outputs malformed JSON", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const { env } = await setupFakeCjulesEnv(workspaceRoot, "malformed");
    const result = await runWrapper(["run", "--poll-interval", "0.05"], "Bad json prompt", env);

    assert.notEqual(result.code, 0);
    const events = parseJsonlLines(result.stdout);
    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent);
    assert.equal(errorEvent.state, "CREATE_FAILED");
  }, "jules-malformed-");
});

test("orchestrator-jules fails when cjules binary is missing", async () => {
  const env = {
    ...process.env,
    PATH: "/empty/nonexistent/path",
  };
  const result = await runWrapper(["run"], "Missing binary prompt", env);

  assert.notEqual(result.code, 0);
});
