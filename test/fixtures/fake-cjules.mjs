#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const stateFile = process.env.FAKE_CJULES_STATE_FILE;

function loadState() {
  if (!stateFile || !existsSync(stateFile)) {
    return {
      sessions: {},
      calls: [],
      mode: process.env.FAKE_CJULES_MODE || "normal", // normal, needs_input, failed, malformed
      ticks: 0,
    };
  }
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function saveState(state) {
  if (stateFile) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const state = loadState();
  state.calls.push(args);

  // Global flags can appear before command
  let cmdIdx = 0;
  while (cmdIdx < args.length && args[cmdIdx].startsWith("--")) {
    if (args[cmdIdx] === "--account") cmdIdx += 2;
    else cmdIdx++;
  }

  const command = args[cmdIdx];
  const rest = args.slice(cmdIdx + 1);

  if (command === "new") {
    const prompt = await readStdin();
    const sessionId = "fake-session-12345";
    state.sessions[sessionId] = {
      id: sessionId,
      name: `sessions/${sessionId}`,
      prompt,
      state: "QUEUED",
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
      messages: [prompt],
    };
    saveState(state);

    if (state.mode === "malformed") {
      process.stdout.write("INVALID JSON\n");
      return;
    }

    process.stdout.write(
      JSON.stringify({
        id: sessionId,
        name: `sessions/${sessionId}`,
        state: "QUEUED",
        createTime: state.sessions[sessionId].createTime,
        updateTime: state.sessions[sessionId].updateTime,
      }) + "\n",
    );
    return;
  }

  if (command === "msg") {
    const sessionId = rest[0];
    const prompt = await readStdin();
    if (!state.sessions[sessionId]) {
      state.sessions[sessionId] = {
        id: sessionId,
        name: `sessions/${sessionId}`,
        messages: [],
      };
    }
    state.sessions[sessionId].messages.push(prompt);
    state.sessions[sessionId].resumed = true;
    state.ticks = 0; // Reset ticks on resume
    saveState(state);
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return;
  }

  if (command === "get") {
    const sessionId = rest[0];
    const session = state.sessions[sessionId] || {
      id: sessionId,
      name: `sessions/${sessionId}`,
      createTime: new Date().toISOString(),
    };

    state.ticks = (state.ticks || 0) + 1;

    let targetState = "COMPLETED";
    if (state.mode === "needs_input") {
      targetState = state.ticks < 2 ? "IN_PROGRESS" : "AWAITING_USER_FEEDBACK";
    } else if (state.mode === "failed") {
      targetState = state.ticks < 2 ? "IN_PROGRESS" : "FAILED";
    } else if (state.mode === "needs_approval") {
      targetState = state.ticks < 2 ? "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL";
    } else {
      targetState = state.ticks < 2 ? "IN_PROGRESS" : "COMPLETED";
    }

    session.state = targetState;
    session.updateTime = new Date(Date.now() + state.ticks * 1000).toISOString();
    state.sessions[sessionId] = session;
    saveState(state);

    process.stdout.write(JSON.stringify(session) + "\n");
    return;
  }

  if (command === "logs") {
    const sessionId = rest[0];
    const session = state.sessions[sessionId];
    const activities = [
      {
        id: "act-1",
        activityType: "PROGRESS_UPDATED",
        createTime: "2026-09-22T00:00:01Z",
        progressUpdated: { description: "Setting up environment" },
      },
      {
        id: "act-2",
        activityType: "PROGRESS_UPDATED",
        createTime: "2026-09-22T00:00:02Z",
        progressUpdated: { description: "Running test suite" },
      },
    ];

    if (session?.state === "COMPLETED") {
      activities.push({
        id: "act-3",
        activityType: "AGENT_MESSAGED",
        createTime: "2026-09-22T00:00:03Z",
        agentMessage: { text: "Fixed race condition successfully." },
      });
      activities.push({
        id: "act-4",
        activityType: "SESSION_COMPLETED",
        createTime: "2026-09-22T00:00:04Z",
      });
    } else if (session?.state === "AWAITING_USER_FEEDBACK") {
      activities.push({
        id: "act-feedback",
        activityType: "AGENT_MESSAGED",
        createTime: "2026-09-22T00:00:03Z",
        agentMessage: { text: "Should I update the public API interface?" },
      });
    } else if (session?.state === "AWAITING_PLAN_APPROVAL") {
      activities.push({
        id: "act-plan",
        activityType: "PLAN_GENERATED",
        createTime: "2026-09-22T00:00:03Z",
        planGenerated: { title: "Refactor concurrency model" },
      });
    } else if (session?.state === "FAILED") {
      activities.push({
        id: "act-fail",
        activityType: "SESSION_FAILED",
        createTime: "2026-09-22T00:00:03Z",
        sessionFailed: { reason: "Regression tests failed after 3 retries" },
      });
    }

    process.stdout.write(JSON.stringify({ activities }) + "\n");
    return;
  }

  if (command === "rm") {
    state.rmCalled = true;
    saveState(state);
    process.stdout.write("Deleted\n");
    return;
  }

  if (command === "approve") {
    state.approveCalled = true;
    saveState(state);
    process.stdout.write("Approved\n");
    return;
  }

  process.stderr.write(`Unknown fake cjules command: ${command}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`fake cjules error: ${err.message}\n`);
  process.exit(1);
});
