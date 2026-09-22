# Jules Agent Integration

Orchestrator integrates with Google Jules as a custom process agent via the `cjules` CLI.

## Architecture

```text
    Orchestrator
         |
         | process runtime
         v
  orchestrator-jules wrapper
         |
         | invokes cjules
         v
      cjules CLI
         |
         v
      Jules API (v1alpha)
```

### Why `cjules`?

1. **API Boundary**: The Google Jules REST API is currently `v1alpha`. The ecosystem CLI `cjules` provides a stable interface, absorbing upstream alpha changes without destabilizing Orchestrator core.
2. **Authentication**: `cjules` handles Google API credentials, accounts, and session keys. Orchestrator never needs to store, log, or manage Jules API keys.
3. **Repository Resolution**: `cjules` automatically detects the current Git origin and maps it to the registered Jules `Source` resource (`sources/github/...`).
4. **Resilience**: `cjules` owns ambiguous-creation reconciliation, retries, and rate limit handling.

## Prerequisites

Ensure `cjules` is installed and authenticated:

```sh
which cjules
cjules version
cjules accounts ls
```

> [!NOTE]
> Tested with `cjules 0.2.3`.

## Configuration

Register `jules` in `~/.orchestrator/config.json` or `<workspace>/orchestrator.config.json`:

```json
{
  "agents": {
    "jules": {
      "adapter": "process",
      "displayName": "Jules",
      "command": "/path/to/orchestrator/examples/integrations/jules/orchestrator-jules",
      "args": ["run"],
      "prompt": "stdin",
      "output": {
        "format": "jsonl",
        "finalEvent": "final"
      },
      "resume": {
        "args": ["resume", "--session", "{sessionId}"],
        "prompt": "stdin"
      },
      "timeoutMs": 43200000,
      "maxOutputBytes": 500000
    }
  }
}
```

Make sure `orchestrator-jules` has execute permissions:

```sh
chmod +x examples/integrations/jules/orchestrator-jules
```

## Usage

### Launch a Task

```sh
orchestrator launch jules --name "fix race condition" "Fix the race condition and add regression tests."
```

### Observe the Run

Inspect status, logs, and events as with any Orchestrator agent:

```sh
orchestrator ps
orchestrator watch <task>
orchestrator events <task>
orchestrator logs <task>
orchestrator read <task>
```

### Resuming a Task

When Jules completes a turn or asks for clarification, resume the same Jules session:

```sh
orchestrator resume <task> "Focus on resolving the flaky retry test."
```

Resuming sends a follow-up message to the **same** Jules session without creating a new session. Orchestrator records the new task linked to the root task via `fromTaskId` and `rootTaskId`.

## Attention States

Jules sessions distinguish terminal states from control handoffs:

| State                    | Orchestrator Status | Event Emitted              | Behavior                                                                |
| :----------------------- | :------------------ | :------------------------- | :---------------------------------------------------------------------- |
| `COMPLETED`              | `succeeded`         | `final` (`completed`)      | Process exits 0 with Jules final response text.                         |
| `FAILED`                 | `failed`            | `error` (`FAILED`)         | Process exits non-zero with failure reason.                             |
| `CANCELLED`              | `failed`            | `error` (`CANCELLED`)      | Process exits non-zero.                                                 |
| `AWAITING_USER_FEEDBACK` | `succeeded`         | `final` (`needs_input`)    | Wrapper returns control immediately. Resume with `orchestrator resume`. |
| `AWAITING_PLAN_APPROVAL` | `succeeded`         | `final` (`needs_approval`) | Wrapper returns plan summary. Does not auto-approve plans.              |

## Interrupt Semantics

```sh
orchestrator interrupt <task>
```

Terminating the local task (`SIGINT` or `SIGTERM`) cleanly kills the child `cjules` polling process. It **does not** delete or cancel the remote Jules session. To view or manage remote sessions directly, use `cjules get <id>` or `cjules rm <id>`.

## Security

- `JULES_API_KEY` remains managed by `cjules`.
- Prompts travel via `stdin` to avoid shell evaluation and argv length limits.
- No credentials are saved in Orchestrator task directories or metadata files.
