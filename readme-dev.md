This package uses the bundled `@openai/codex` dependency by default.
Set `CODEX_PATH` to run a different Codex binary; versions other than the one specified in `package.json` may not be compatible.

### Runtime environment

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config. `hooks` move to App Server startup (`-c hooks=...`) for AIR review; Codex rejects malformed hooks at startup and `initialize` reports its error.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, or `agent-full-access`. In the BrokkAi fork, `agent` preserves Codex's configured sandbox and uses automatic approval review; `agent-full-access` selects unrestricted permissions from startup.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.
- `CODEX_ACP_APP_SERVER_CRASH_LIMIT` - how many crashes of the Codex app-server in the crash window stop its automatic restart (default `5`).
- `CODEX_ACP_APP_SERVER_CRASH_WINDOW_MS` - the crash window in milliseconds (default `300000`, 5 minutes).

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

A goal snapshot with status `limited` also carries `limitReason`. `usage` means Codex stopped the goal at the account usage limit, which ends when the limit resets. `budget` means the goal's own token budget is spent; this wins whenever `tokensUsed` has reached `tokenBudget`, even if Codex recorded the usage limit last. Identity-checked resume restarts a goal whose reason is `usage` and ignores one whose reason is `budget`, which needs the user.

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
### Test suites

- `npm test`: unit tests with the Codex app-server mocked.
- `npm run test:integration`: real codex-acp plus a real `codex app-server`. The model is a local mock of the
  OpenAI Responses API (`src/__tests__/integration/mock-responses-server.ts`) reached through the `gateway`
  auth method, so no API key or network is needed. Tests script model replies with `textResponse`,
  `execCommandResponse` and `applyPatchResponse`.
- `npm run test:e2e`: real OpenAI model. Builds first and requires `RUN_E2E_TESTS=true` (set by the script)
  plus `OPENAI_API_KEY` or `CODEX_API_KEY` in the environment.

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

### MCP server approval policy

Each MCP server in `mcpServers` may set `_meta.codex.defaultToolsApprovalMode`
to `auto`, `prompt`, `writes`, or `approve`. The bridge forwards this as Codex's
`default_tools_approval_mode` for that server. `approve` pre-approves its tools;
omitting the field leaves the native default in effect. Explicit per-tool
settings still take precedence. This metadata travels with the server through
new, load, resume, fork, and provider restart. Invalid values are rejected.
Clients should attach it only to registrations they intend to pre-approve;
server names alone do not imply trust. Mjolnir sends `approve` for its owned
servers in Guardian mode and leaves yolo registrations unchanged.

### DeepSeek tool history compatibility

In Mjolnir guardian and yolo modes, direct `api.deepseek.com` Responses
providers use an adapter-owned loopback forwarder. It moves PostToolUse
developer context after the complete tool call/result batch before forwarding
the request, preserving actual outputs, parallel batches, reasoning items,
authentication, and streamed responses. Complete requests retain their original
body bytes. Incomplete or unfamiliar batches pass through unchanged; the bridge
never fabricates a result or reruns a tool. Stock Codex remains the pinned
upstream package. This works around [openai/codex#46193](https://github.com/openai/codex/issues/46193).

The forwarder is created for new, resumed, loaded, and forked sessions, closes
with their app-server connection, and keeps mailbox delivery enabled. Other
providers and ACP modes retain their existing routing. DeepSeek uses HTTP/SSE
through this forwarder; WebSocket transport is disabled for that provider only.
No separate service or persistent provider configuration changes are needed.

### Unsupported skills

The adapter disables Codex skills whose output ACP clients cannot show, and leaves them out of the skill commands and
`/skills`. The list is in `src/UnsupportedSkills.ts`. Today it holds Codex's bundled Visualize skill: it ends a reply
with a content reference that only the OpenAI apps render, so ACP clients show raw `visualize{...}` text.

The adapter matches skills by name, so it needs no `skills/list` request when a session starts. The cost: a skill from
another plugin with the same qualified name, such as a `visualize` skill in some other plugin named `visualize`, is
disabled too.

### App-server recovery

The adapter restarts the Codex app-server when it dies (for example, killed for lack of memory). Its code is in
`src/app-server-recovery/`.

- A request that was waiting on the dead app-server fails with error `1001` and the cause, such as "was killed by
  SIGKILL, which usually means it ran out of memory". A running prompt ends at once: open tool calls become `failed`,
  open permission dialogs are cancelled, and an AIR client gets the `transport_lost` session failure.
- An app-server that exits before its `initialize` handshake succeeded, such as one that rejects its startup config,
  fails the request with "Codex process has exited with code N:" and its stderr, and no promise of a restart.
- The next request starts a new app-server with the same `initialize` handshake and provider routing. A session that
  was open is resumed on its next use, with the model, mode and settings that the adapter kept.
- Codex writes a thread to disk only with its first message, so a session without messages cannot be resumed in a new
  app-server, after a crash or a provider restart. Its next use fails with "had no messages yet and was lost"; the
  client starts a new session. A provider restart still completes for the agent and the other sessions.
- After `CODEX_ACP_APP_SERVER_CRASH_LIMIT` crashes in the crash window the adapter stops restarting it and says so,
  with the stderr of the last crash.
  A session that the app-server died opening twice in 30 minutes is not opened again for the rest of that time, so
  one session that is too large for the memory cannot take the other sessions down with it.

### ACP v2 support

The agent speaks both ACP v1 and the unstable ACP v2 (Draft) protocol from the same process; the
version is negotiated on the first `initialize` request and fixed for the connection's lifetime.

The v2 chain registers: `initialize`, `session/new|list|close|delete|resume` (v2 folds `session/load`
into `session/resume` with `replayFrom`), `session/set_config_option`, `session/cancel`,
`auth/login|logout`, `session/prompt` (plus `$/cancel_request`), `session/fork`, and
`providers/list|set|disable`. Unstable extension methods on top of that: `_session/steering`,
`_session/goal` (set/pause/resume/clear), `_session/async_task/stop`, and the AIR session index
requests (`_session/rename`, `_session/archive|unarchive`, `_session/list/subscribe|unsubscribe`).
`session/fork` drops the
v1 `modes` field (v2 removed the modes API in favor of config options), and forked sessions do not
get an `available_commands_update`, matching v1. There are no new environment/config knobs specific
to v2; it reuses the runtime environment variables above.

#### Client system prompts

Both ACP versions advertise `systemPrompt: {}`: text-only `append` mode. Override and non-text
content are rejected with `-32602` before a session is created or a fork is made.
Text blocks are joined with a blank line and appended to the existing developer-instruction
baseline: AIR `customInstructions` when supplied, otherwise configured Codex developer instructions.
Codex's base instructions and workspace context remain intact. Requests without `systemPrompt`
keep the legacy AIR behavior.

New sessions use the instructions on their first turn. A changed prompt on an idle, persisted
session detaches and reloads that thread under the same session ID. **The retained model context
changes at the next compaction**, not immediately after resume; the adapter does not force a
compaction. Forks with changed instructions have the same deferred behavior.

Changed prompts are rejected while session work or background terminals are running, when a live
session has no saved rollout yet, or when Codex cannot confirm a reload. Existing work is not
cancelled. Retry after work finishes, or create a new session for immediate instructions.
New prompts, steering, and config changes cannot race an instruction reload.

Omitted/null prompts keep the instructions known to the currently open adapter session, including
through app-server recovery and provider restarts. After closing a session or restarting the
adapter, clients should resend their prompt on load/resume/fork; without it, Codex's retained
context and configured defaults determine the instructions.

#### Manual compaction

`/compact` finishes foreground work only after Codex reports `turn/completed` for the compact
turn. Item completion still reports compaction progress, but does not release the next prompt.
The v1 prompt response and v2 idle state wait for the turn to finish; v2's early prompt-acceptance
response is unchanged.

#### AIR v2 client contract

These are behaviors the AIR (JetBrains) ACP client relies on that aren't obvious from the wire
schema alone:

- Initial commands come from `availableCommands` in v2 `session/new`, `session/resume`, and
  `session/fork` responses, not an initial `available_commands_update`. Later command changes still
  use notifications. Text inputs use `type: "text"`, and AIR command actions and skill paths are
  preserved. Skill discovery is best-effort: setup succeeds without initial commands if it fails.
- Failed foreground work ends with `state: "idle"`, `stopReason: "error"` and a standard `error`
  object containing `code` and a user-facing `message`. Before insertion, the prompt also fails
  with a JSON-RPC error; after insertion, its successful `messageId` response is not revoked.
  Cancellation remains `cancelled`. Retries, individual failed tools, and idle background errors
  do not become terminal session failures. Raw process stderr and opaque error data are not sent
  in the standard error object.
- On a failed prompt, read `sessionFailure` (`_meta.jetbrains.air.sessionFailure`) and `quota`
  (`_meta.quota`) from the idle `state_update` that ends the turn, not from a separate error
  channel. The same `_meta` v1 attaches to `PromptResponse` is copied onto the v2 idle update.
- Custom session updates are renamed on v2: `subagent_spawned`/`subagent_state_update` become a
  single `_subagent_update` (gated on the AIR `nativeSubagentSessions` capability; this contract is
  retained independently of standard subagent sessions), and
  `async_task_spawned`/`async_task_state_update` become `_async_task_spawned`/`_async_task_state_update`
  (gated on the AIR `asyncTasks` capability). Payload shapes are unchanged.
- Foreground state is independent of prompt acceptance. `running` can precede the user-message
  echo, including while Codex runs hooks. A successful prompt response still waits for insertion.
- Every successful `session/resume` sends a current-state snapshot after any replay and before its
  response. An idle snapshot is not another completed turn and repeats no usage or failure metadata.
- Permission and elicitation requests affect aggregate foreground state: another runnable item keeps
  the session running, and answering one wait does not resume work that remains blocked. Withdrawing
  a request on cancellation does not resume the workflow; late answers cannot revive an ended turn.
- A steer (`_session/steering`) shows up as a `user_message` once it actually lands in the turn.
- On cancel, any permission or elicitation request still waiting on a client response is withdrawn
  with `$/cancel_request`, not just the underlying Codex turn.
- Turns Codex starts on its own (goal auto-turns, e.g. after `session/resume` or `session/new`) are
  rendered the same as prompted turns (`running` then one `idle`) but with no corresponding
  `session/prompt` call — clients should not assume every `running`/`idle` pair has a matching
  outbound prompt.
- After a tool call streams terminal output as `terminal_output_chunk`s, completion does not resend a
  full `output` snapshot; the streamed chunks are the only copy of the output.
- The AIR tool call contract (`docs/air-extensions.md`) does not apply on v2: every v2 client gets
  the standard tool call reports, so `rawInputRendering`, `planContentDelta` and `diffPatch` are not
  offered there. A read, search or list command has no terminal; its output arrives as `content`
  text when it completes. A file change sends one diff per file whose Git patch is built from the
  Codex diff.
- The AIR `sessionIndex` extension (`docs/air-extensions.md`, "Session index") works as on v1: a
  client that declares `sessionIndex` gets it, `session/list` reads `_meta.jetbrains.air.list`, and
  rows, `session_info_update`s and `_session/list/changes` carry the same `_meta`.
- Other AIR `_meta` keys (goal, message phase, mode kind, permission presentation) go only to AIR
  clients, as on v1. Every v2 permission request still gets its prompt `title` and `description`.

#### Live standard subagent sessions

Non-AIR v1 clients opt in with `clientCapabilities.subagents: {}`. Non-AIR v2 clients use
standard `subagent_update` associations automatically. AIR keeps its existing opt-in, updates,
and generation-based identities; clients do not receive both contracts.

A standard child keeps one opaque conversation ID across assignments and parent handler changes.
Its ancestors are announced before its output, tool updates, or interactions. Permissions and
elicitation use the child's ID and survive parent replay; actual work endings withdraw obsolete
requests locally, even if the client returns a late answer. Child tools, terminals, plans, titles,
and observed configuration stay separate from the parent.

Only cancellation is advertised, and only while an owned, observable child's current turn can be
identified. Send `session/cancel` with its opaque ACP child ID to interrupt that work and observed
owned descendant work, not its parent or siblings. Raw provider IDs cannot bypass the restriction.
Prompting, loading, configuration changes, closing, and other child mutations remain disabled.
Parent cancellation still interrupts observed live descendants.
An observed work ending reports `idle`; loss of observability reports `unknown`, not a fabricated
failure or a permanently closed conversation.

Cancellation withdraws affected permission/elicitation requests, but an interrupt acknowledgement
does not fabricate a cancelled outcome. Actual provider completion reports the ending; the same
conversation may receive later work. Idle or unobservable children have no cancel capability.
Reattachment suspends child controls until the latest successful response is actually written,
including complete JSON-RPC batches; historical or copied child records never grant control.

Child `config_option_update` notifications contain complete reported snapshots. Observed model and
reasoning effort use singleton selects, including changes between assignments. Unknown or unset values
are omitted; no values are inferred from the parent or requested spawn arguments. These reports do not
enable configuration changes, even to the current value. Replayed configuration is historical, not
confirmed current. Reattachment drops cached confirmation and refreshes loaded children after the
response. Optional reads do not block child delivery; newer observations or attachment changes discard
stale results.

Replay follows both recorded spawn formats and replays available child transcripts once per conversation,
including nested children, using legacy or paginated history. Announcements and all selected history
precede the response. Completed snapshots reconcile tool and rendering state before duplicate live
payloads are suppressed; live bookkeeping still runs. In-progress commands retain classification without
resetting streamed output. Incomplete text has no safe delta cursor; it and other records without a safe
partial representation are omitted rather than replayed over newer content. Agent-owned input is not
rendered as human input. Missing, omitted, or incomplete child history produces a parent advisory;
an empty transcript alone does not invent a gap.

Replay reports the latest recorded child turn's known success, cancellation, or failure as historical
`idle` before the response. A missing or still-running turn invents no outcome. Legacy history reuses
its turn data; paginated history reads the latest turn summary separately, retaining available text
and reporting a gap if that summary is unavailable. Recorded outcomes do not enter the live foreground
cache, withdraw current interactions, confirm runtime ownership, or grant controls.
Rejoining a loaded child still requires current provider parentage; copied fork history can be displayed
but cannot acquire the original runtime's subscriptions.
After replay, current child work/configuration snapshots follow the actual response write, including whole
JSON-RPC batches. Parent setup operations serialize without waiting on each other's batch delivery.

#### Models of a `providers/set` gateway

`providers/set` lists the models of the gateway (`GET {baseUrl}/models`, with the headers Codex sends to it)
before it responds. The models reported to the client are then only the Codex models whose `model` or `id` the
gateway lists, matched without case and date suffix. A session whose thread model the gateway does not list uses
the default of these models; a thread model that the gateway lists but Codex does not know is kept. A gateway that
lists none of the Codex models leaves no model option at all, and the session keeps the thread's model as current.
Sessions already open get the models of the new routing when the provider restart resumes them, after
`providers/disable` too. A 4xx answer means the gateway has no listing: `providers/set` succeeds and nothing is
narrowed. A failed listing (network error, a status other than 2xx or 4xx, malformed body, or the timeout) fails
`providers/set` with `internal_error` and keeps the current routing; a base URL that is not http(s) fails with
`invalid_params`. A listing that finishes after a newer `providers/set` or `providers/disable` was applied is
dropped. The `gateway` auth method and providers from
the Codex config are not listed.

#### Known gaps

- After `providers/disable("openai")`, `providers/list` still reports native OpenAI routing as the
  current provider. The providers RFD says a disabled provider's `current` should be `null`; this is
  left as-is and documented here rather than fixed.
- Open question for AIR: AIR's fork points match Codex item ids, but on v2 a user message's
  rendered id is the client-minted `clientId` (when the client supplied one), not the Codex item id.
  A fork at a user message would not resolve. This is flagged for AIR, not fixed here.

### BrokkAi merge compatibility (1.14.0)

ACP v1 remains supported by the same negotiated router as v2. Mjolnir continues to opt into AIR native child sessions, typed session failures, and execution/goal metadata. AIR children keep the `_session/subagent/cancel` extension and generation identities; standard children use upstream's opaque IDs and `session/cancel`. An ordinary goal set or resume relies on Codex's native automatic continuation. Mjolnir's identity-checked recovery retains its guarded continuation path.

Prompt usage keeps `mjolnir.dev/usage-scope`: `turn` means all observed prompt turns have complete attributed coverage; `unspecified` means the baseline or attribution is incomplete. Fresh input now follows upstream ACP accounting and excludes cache reads and writes; the separate cache fields preserve those counts. Repeated inherited counters before model output establish a resume baseline. Counter resets fall back to the reported request usage and cannot claim complete coverage.

Startup hooks, including a caller's `hooks.state` trust hashes, move intact from `CODEX_CONFIG` into the app-server startup override and are reused on internal restart. The adapter neither globally trusts hooks nor automatically calls the new trust extension. Goal mutations continue to omit Codex's optional `origin`, as upstream does; no user authorization is inferred by this adapter.
