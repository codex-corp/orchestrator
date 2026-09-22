import { LaunchPlanError } from "./launch-plan.ts";
import type {
  AgentLaunchPlan,
  BuildAgentResumeLaunchPlanInput,
  HeadlessAgentRuntimeConfig,
  PromptTransport,
} from "./types.ts";

export type CustomProcessResumeConfig = {
  supported: boolean;
  args?: readonly string[];
  prompt?: PromptTransport;
};

export function parseCustomProcessResumeConfig(
  config: Record<string, unknown>,
  sourcePath: string,
  id: string,
): CustomProcessResumeConfig {
  const resume = config.resume;
  if (resume === undefined) {
    return { supported: false };
  }

  if (typeof resume !== "object" || resume === null || Array.isArray(resume)) {
    throw new LaunchPlanError(
      `${sourcePath}: agents.${id}.resume must be an object with args and optional prompt fields.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}.resume`,
        hint: 'Use "resume": { "args": ["resume", "--session", "{sessionId}"], "prompt": "stdin" }.',
      },
    );
  }

  const resumeRecord = resume as Record<string, unknown>;
  const rawArgs = resumeRecord.args;
  if (
    !Array.isArray(rawArgs) ||
    rawArgs.length === 0 ||
    rawArgs.some((arg) => typeof arg !== "string")
  ) {
    throw new LaunchPlanError(
      `${sourcePath}: agents.${id}.resume.args must be a non-empty string array.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}.resume.args`,
        hint: 'Include "{sessionId}" in resume.args.',
      },
    );
  }

  const args = rawArgs as string[];
  validateResumePlaceholderMistakes(args, sourcePath, id);

  const hasSessionIdPlaceholder = args.some((arg) => hasTemplatePlaceholder(arg, "sessionId"));
  if (!hasSessionIdPlaceholder) {
    throw new LaunchPlanError(
      `${sourcePath}: agents.${id}.resume.args must include a "{sessionId}" placeholder.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}.resume.args`,
        hint: 'Add "{sessionId}" to resume.args so Orchestrator can inject the session handle.',
      },
    );
  }

  const hasPromptPlaceholder = args.some((arg) => hasTemplatePlaceholder(arg, "prompt"));
  const rawPrompt = resumeRecord.prompt;

  if (hasPromptPlaceholder && rawPrompt !== undefined) {
    throw new LaunchPlanError(
      `${sourcePath}: agents.${id}.resume cannot combine args {prompt} with prompt mode.`,
      {
        reason: "invalid_config_schema",
        input: `agents.${id}.resume`,
        hint: 'Use either resume.args with "{prompt}" or "prompt", not both.',
      },
    );
  }

  let promptTransport: PromptTransport | undefined;
  if (hasPromptPlaceholder) {
    promptTransport = { kind: "argv_template" };
  } else if (rawPrompt !== undefined) {
    promptTransport = parseResumePromptTransport(rawPrompt, sourcePath, id);
  } else {
    promptTransport = { kind: "stdin", closeAfterWrite: true };
  }

  return {
    supported: true,
    args,
    prompt: promptTransport,
  };
}

export function buildCustomProcessResumePlan(
  input: BuildAgentResumeLaunchPlanInput,
  runtime: HeadlessAgentRuntimeConfig,
): AgentLaunchPlan {
  const sessionId = input.provider.sessionId?.trim();
  if (!sessionId) {
    throw new LaunchPlanError(`Runtime "${runtime.id}" resume requires provider.sessionId.`, {
      reason: "missing_resume_provider_id",
      input: runtime.id,
      hint: `Resume a ${runtime.displayName} task only after its task record has provider.sessionId.`,
    });
  }

  const resumeConfig = runtime.resume;
  const templateArgs = resumeConfig?.args ?? [];
  const promptTransport = resumeConfig?.prompt ?? { kind: "stdin", closeAfterWrite: true };

  const hasPromptPlaceholder = templateArgs.some((arg) => hasTemplatePlaceholder(arg, "prompt"));

  let finalArgs: string[];
  let stdin: { input: string; closeAfterWrite: boolean } | undefined;

  if (hasPromptPlaceholder) {
    finalArgs = templateArgs.map((arg) =>
      replaceTemplatePlaceholder(
        replaceTemplatePlaceholder(arg, "sessionId", sessionId),
        "prompt",
        input.task,
      ),
    );
  } else {
    finalArgs = templateArgs.map((arg) => replaceTemplatePlaceholder(arg, "sessionId", sessionId));

    switch (promptTransport.kind) {
      case "stdin":
        stdin = { input: input.task, closeAfterWrite: promptTransport.closeAfterWrite };
        break;
      case "argv":
        if (promptTransport.position === "first") {
          finalArgs = [input.task, ...finalArgs];
        } else {
          finalArgs = [...finalArgs, input.task];
        }
        break;
      case "flag":
        finalArgs = [...finalArgs, promptTransport.flag, input.task];
        break;
      default:
        stdin = { input: input.task, closeAfterWrite: true };
        break;
    }
  }

  return {
    runtime: runtime.id,
    executionKind: "process",
    displayName: runtime.displayName,
    executable: runtime.launch.executable,
    args: finalArgs,
    env: {
      ...(runtime.launch.env ?? {}),
      ...(input.env ?? {}),
    },
    cwd: input.cwd,
    promptTransport,
    outputTransport: runtime.launch.output,
    expectedProcesses: runtime.detect.expectedProcesses ?? [runtime.detect.command],
    interrupt: runtime.control.interrupt,
    canSteerRunning: runtime.control.steerRunning,
    handlesOwnAuth: runtime.capabilities.handlesOwnAuth,
    enabled: runtime.enabled,
    safety: {
      acceptsShellCommand: runtime.safety?.acceptsShellCommand ?? false,
    },
    resume: {
      provider: input.provider.provider ?? runtime.id,
      sessionId,
    },
    ...(stdin ? { stdin } : {}),
  };
}

function parseResumePromptTransport(
  prompt: unknown,
  sourcePath: string,
  id: string,
): PromptTransport {
  if (prompt === "stdin") {
    return { kind: "stdin", closeAfterWrite: true };
  }
  if (prompt === "argv-last") {
    return { kind: "argv", position: "last" };
  }
  if (prompt === "argv-first") {
    return { kind: "argv", position: "first" };
  }

  throw new LaunchPlanError(
    `${sourcePath}: agents.${id}.resume.prompt must be one of: stdin, argv-last, argv-first.`,
    {
      reason: "invalid_config_schema",
      input: `agents.${id}.resume.prompt`,
      hint: 'Use "prompt": "stdin", "argv-last", or "argv-first".',
    },
  );
}

function validateResumePlaceholderMistakes(
  args: readonly string[],
  sourcePath: string,
  id: string,
): void {
  const mistakes = [
    {
      pattern: /\{\{sessionId\}\}/,
      input: "{{sessionId}}",
      hint: 'Use "{sessionId}" exactly; double braces are not supported.',
    },
    {
      pattern: /\{\{prompt\}\}/,
      input: "{{prompt}}",
      hint: 'Use "{prompt}" exactly; double braces are not supported.',
    },
    {
      pattern: /\{\{session\}\}|\{session\}/,
      input: "{session}",
      hint: 'Use "{sessionId}" for the session handle. There is no "{session}" placeholder.',
    },
    {
      pattern: /\{\{task\}\}|\{task\}/,
      input: "{task}",
      hint: 'Use "{prompt}" for the task text. There is no "{task}" placeholder.',
    },
  ];

  for (const arg of args) {
    for (const mistake of mistakes) {
      if (mistake.pattern.test(arg)) {
        throw new LaunchPlanError(
          `${sourcePath}: agents.${id}.resume.args contains unsupported placeholder ${mistake.input}.`,
          {
            reason: "invalid_config_schema",
            input: `agents.${id}.resume.args`,
            hint: mistake.hint,
          },
        );
      }
    }
  }
}

function hasTemplatePlaceholder(value: string, name: "sessionId" | "prompt"): boolean {
  return new RegExp(`(?<!\\$)\\{${name}\\}`, "g").test(value);
}

function replaceTemplatePlaceholder(
  value: string,
  name: "sessionId" | "prompt",
  replacement: string,
): string {
  return value.replaceAll(new RegExp(`(?<!\\$)\\{${name}\\}`, "g"), replacement);
}
