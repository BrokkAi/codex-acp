This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, or `agent-full-access`. In the BrokkAi fork, `agent` preserves Codex's configured sandbox and uses automatic approval review; `agent-full-access` selects unrestricted permissions from startup.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

### Quick start

#### Develop on Windows?

- Download and install [C++ redistributable package](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version)

#### Adjust ACP client config

Run from sources

1. Install dependencies `npm install`
2. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/path/to/project/"],
      "env": {
        "CODEX_PATH": "node_modules/.bin/codex",
        "APP_SERVER_LOGS": "optional/path/to/existing/log/directory"
      }
    }
  }
}
```

Run from binaries

1. Download a `codex-acp-<platform>.zip` archive from https://github.com/agentclientprotocol/codex-acp/releases (`<platform>` is one of: `linux`, `darwin`, `win32`)
2. Unzip the archive:
   ```bash
   unzip codex-acp-<platform>.zip
   ```
3. Adjust ACP client config

```json
{
  "agent_servers": {
    "Codex (app-server)": {
      "command": "/path/to/codex-acp",
      "env": {
        "CODEX_PATH": "/path/to/codex"
      }
    }
  }
}
```

### Build binaries

Building standalone binaries requires [bun](https://bun.com/docs/installation).

Build single-file executables in `dist/bin` directory:

```bash
npm run bundle:all
```

Package binaries into zip archives:

```bash
npm run package:all
```

### Update supported Codex version

1. Update the `@openai/codex` version in `package.json` (under `dependencies`).
2. Regenerate Codex types in `src/app-server/`: `npm run generate-types`
3. Ensure there are no type errors or failed tests: `npm run typecheck` and `npm run test`


### Goal recovery and native execution

Clients negotiate `_meta.execution: {version: 1}` in initialize capabilities to receive `_meta.execution` on session-info updates and session-open responses. The snapshot contains `version`, monotonic session `revision`, `status` (`running` or `idle`), and `turnId`. Session-open responses also include the current `_meta.goal` snapshot or explicit null. Native notifications and interaction handlers are installed before resume and remain active between ACP prompts.

The goal capability advertises `resumePolicies`. A session resume/load request may include `_meta.goal.resumePolicy: "pause"` to pause an active stored goal before native opening. Omitting the policy, or using `"preserve"`, retains native continuation behavior. `_session/goal` pause/resume accepts `expectedGoal: {objective, createdAt}` using the published identity; stale decisions are rejected. Identity-checked resume acknowledges when execution starts and avoids starting a second already-running continuation. These controls preserve the goal budget and counters.

### Disallowed native tools

Session creation, resume, load, and fork requests accept the private option `_meta.codex.options.disallowedTools`, modeled after Claude Code's option of the same name. Codex currently exposes native collaboration tools as one feature family, so listing any supported collaboration tool removes the entire family from the model before inference. Supported names are `spawn_agent`, `send_input`, `send_message`, `followup_task`, `resume_agent`, `wait_agent`, `list_agents`, `close_agent`, and `interrupt_agent`. Other names are rejected because Codex does not yet provide a generic native-tool deny list and silently accepting them would not enforce the requested policy.

For example:

```json
{
  "_meta": {
    "codex": {
      "options": {
        "disallowedTools": ["spawn_agent"]
      }
    }
  }
}
```

The live development runner accepts the equivalent repeatable flag: `npm run codex-test -- -p "Delegate this task" --disallow-tool spawn_agent`.

### Native child cancellation

Clients that negotiate `nativeSubagentSessions` receive `capabilities.cancel: true`
for live children. Send `_session/subagent/cancel` as a JSON-RPC request with
`{sessionId: <owner>, subagentSessionId: <child>}`. The reply is
`{cancelled: true}` after Codex accepts interruption of that child's active turn;
terminal state still arrives through `subagent_state_update`. Unknown children,
terminal children, and stale generation IDs return `{cancelled: false}`. Errors
from Codex propagate to the caller. Parent and sibling turns are unaffected.
Replayed children remain read-only; continuing a child publishes a new generation
with live capabilities. Closing and direct prompting are not advertised.

### Steering

Clients inject a message into the running turn with the `_session/steering`
request: `{sessionId, prompt}`. Initialize advertises it as
`_meta.steering: {supported: true, idleBehaviors: ["promptRequired"]}`.

The reply is `{outcome: "injected"}` when the message joined the running turn.
When no turn can accept it, the adapter starts a new turn itself and replies
`{outcome: "startedNewTurn"}`. That turn belongs to no `session/prompt`.

A client that wants to own every turn sends
`_meta: {steering: {idleBehavior: "promptRequired"}}`. When no turn can accept
the message, the adapter then starts nothing and replies
`{outcome: "promptRequired", reason: "noRunningTurn"}`, and the client submits
the prompt as a normal `session/prompt`. This includes a turn that ends while
the steer is being delivered. The adapter rejects other `idleBehavior` values
with `invalidParams` so that a client never mistakes an ignored option for an
accepted one.

### Session notices

The adapter implements [Session Notices](https://agentclientprotocol.com/rfds/session-notices)
for Codex warnings, configuration warnings, deprecation notices, model rerouting, and the legacy
`thread/compacted` advisory when the client advertises `clientCapabilities.session.notices: {}`.
These are live `session/update` notifications with
`sessionUpdate: "notice"`, a severity, a plain-text title, and optional description.
They are not replayed from session history and repeated notices remain independent events.

Without that capability (including absent or null capability objects), the adapter preserves
the existing assistant/thought text or AIR `sessionFailure` advisory records. When notices are
enabled, they take precedence over AIR advisory records. Clients control their presentation;
the adapter does not rely on notices being displayed.

Command replies, review results, and terminal/retrying errors retain their existing response or
failure channels. Clients advertising session compaction support continue to receive the dedicated
compaction lifecycle instead of the legacy completion advisory.

### AIR diff statistics

See the [diff statistics specification](docs/diff-statistics-extension.md) for the
`_meta.jetbrains.air.diffStats` payload and its compatibility rules.
