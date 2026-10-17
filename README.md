# Weft

A local coding agent with a web interface. Ask it to explore projects, edit files, run commands, and delegate tasks.

- **Transparent model communication:** inspect model HTTP requests, responses, request counts, and provider-reported usage, with credentials redacted.
- **Flexible delegation:** run concurrent sub-agents with different models and reasoning levels; inspect and stop tasks individually.
- **Controlled local access:** approve extra file and network permissions when needed.
- **Local history:** keep projects, chats, settings, and task records on your machine. The interface supports English and Chinese.

## Quick start

Requires **macOS**, **Node.js 24+**, **pnpm 11**, and a browser window of at least **1280 × 720**.

```sh
pnpm install
pnpm start
```

Open the management URL printed in the terminal. Keep it private: it authorizes app changes. After restarting, open the newly printed URL.

1. In **Settings → Models**, enter your OpenRouter API key and add a model.
2. Create a **Project** and select folders on the machine running the service.
3. Create a **Chat**, choose a model and reasoning level, and submit a task.

While a Chat is running, **Queue** saves the next message without interrupting it. View or remove pending messages near the composer. Success starts the next message after cleanup; failure, Stop or an execution limit leaves the queue waiting. **Continue queue** or a new Send resumes the chain. Pending messages survive browser refresh but are lost when the service restarts, including watch restarts.

Stop with **Ctrl+C**. The default port is 3000; use `pnpm start --port 3001` to change it. Startup stops existing listeners on the selected port, so choose an unused port.

## Skills

Install standard `SKILL.md` skills in `~/.agents/skills` or project `.agents/skills` directories. Within a Git repository, discovery includes the directories from the repository root to each Target Folder; outside Git, it checks the Target itself. Same-name skills retain their individual source paths.

Type `/` in the prompt to filter by name, description, or source. Use ↑/↓ and Enter to select, Esc to dismiss, and the selected markers to remove skills. Selection does not send the task. On submission the complete selected `SKILL.md` is read, including skills marked `disable-model-invocation: true` or `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. Other skills expose only their summary until the model chooses to read them.

Every new root or sub-agent discovers its own catalog; selections are not inherited by sub-agents or later tasks. Discovery/read failures appear as diagnostics in the actual model request and the picker. There is no live filesystem watcher: reopen `/` to refresh the picker. Skill directories and installed symbolic link targets are readable without approval; scripts still use normal command permissions, and skills grant no extra writes or network access.

## Permissions

File and network access are restricted by default. Project folders and each agent's temporary workspace are writable; necessary system and toolchain paths are readable. Extra access can be denied, allowed once, or saved for the Project. Manage saved permissions in **Project Edit**; all chats and sub-agents in that project share them.

Each chat can independently enable full file or full network access. **Settings → Execution** sets defaults for new chats only. Full file access remains subject to OS permissions. Temporary workspaces are disposable; save wanted results in project folders.

When **both** file and network access are full, commands run without the native process sandbox, with your system user's permissions. If either dimension is restricted, the native sandbox remains. Scope validation, credential filtering, process ownership, cancellation and output records still apply. Failed commands never automatically gain permissions or retry.

## Browser diagnostics

The installation includes Playwright **1.63.0**'s official CLI and `playwright-cli` skill. Install its Chromium browser once from the Weft directory with `pnpm exec playwright install chromium`. Target repositories need no browser package. Select the skill with `/` or ask the model to use it; `playwright-cli` is available in command tools, forwarding every upstream argument. Installed Chromium can be selected with `playwright-cli open <url> --browser=chromium`. In this pinned version, `chromium` selects Chrome for Testing. CLI launches are headless by default; add `--headed` to show a browser window. The browser session remains available after `open` returns; inspect it with `playwright-cli list` and end it with `playwright-cli close`.

On macOS, Chromium needs both existing file and network modes set to full: the restricted native sandbox blocks browser Mach service registration even with localhost permission. The model starts and checks the website through ordinary command sessions, then chooses browser actions, console/network details and request/response bodies, trace, screenshots, `run-code`, and `read_image` as needed. Browser operations and full command output remain inspectable Tool Calls. Screenshots enter model context only when explicitly read.

Sessions, profiles and connections retain upstream behavior, using the Agent's isolated HOME for daemon/cache communication. The model should close its browser with `playwright-cli close` (or `-s=<name> close` for a named session); upstream detached browsers may outlive the launching command and retain their normal idle timeout. No Chat lifetime policy or personal browser takeover is added. [Compatibility and validation](docs/browser-tools.md) records the actual tested boundary.

## Images

Attach PNG, JPEG, GIF or WebP files with **Attach images**, or paste an image into the prompt. Preview and remove attachments before sending a text task. Up to ten images are accepted, each at most 10 MiB. A model known to lack image input is rejected without discarding the draft; unknown capabilities are left to the provider, whose failures are recorded without automatic retries or model changes.

The model can call `read_image` for local pictures and screenshots under the same file permissions as `read_file`. Actual image bytes are saved with the question or Tool Result, so changing or deleting the source does not change the record. Successful user questions retain their images in later Root Agent history; tool images stay within the Agent that read them. Images increase saved records and model input size. Model request details and Tool Call details retain the actual visual content; copying tool results includes the original data URL.

Automated checks use controlled model responses to verify the visual protocol and native file reading. They do not establish that a paid model interpreted an image.

## User and project instructions

Each new root task and sub-agent loads user instructions from the service user's `~/.weft/`, followed by each Project folder's nearest Git root through that folder. Outside Git, only the Project folder is checked. In a directory, `AGENTS.override.md` replaces `AGENTS.md`, including when empty; a read failure is reported without falling back. Shared sources load once with each applicable scope.

The initial UTF-8 text budget is 32 KiB, shared in user-first, saved-folder and ancestor-first order. Actual model requests show source paths, scopes, truncated content, omissions and read errors. Running agents keep their initial contents; new agents reload. The model must discover and read deeper local instructions before working on files, and decide how to handle unavailable rules. References such as README, CONTEXT and ADRs are read only when needed.

Only named initial instruction sources receive a read exception. Symlinks outside those sources require ordinary file authorization; referenced files, commands and writes retain their existing permissions. Command `HOME` points to scratch and does not change the user instruction directory.

## Local data

`data/tyler-agent.sqlite` stores history, settings, and your **unencrypted API key**. Keep it private. To use another database, run `pnpm start --db /absolute/path/to/chat.sqlite`; its parent directory must already exist and be private to your user (for example, permissions `0700`).

Unsupported databases are rejected without deletion or automatic migration. If an update requires a new database, use a fresh path and keep the old database for its records.

### Command sessions

The model can run `exec_command` with `cmd`, optional absolute `workdir` (Agent scratch by default), `shell`, `login`, `tty`, `yield_time_ms`, and `max_output_tokens`. Interactive commands yield without killing the process and return `session_id`; `write_stdin` polls, supplies PTY input, or sends Ctrl-C. Non-PTY input accepts only Ctrl-C, matching Codex 0.162.0. Explicit legacy `timeout_ms` selects OneShot execution and cannot combine with PTY or yield. Login defaults to true for interactive commands and preserves the previous false default for OneShot.

Command Output keeps complete decoded text, stream labels and chunk order with the launching Tool Call, including PTY output. Invalid or incomplete UTF-8 bytes appear as replacement characters; raw binary output is not archived. Refresh its details to see current process state and new logs; `read_tool_output` gives the model bounded historical pages. Output budgets affect the returned text only (four characters per requested token), never the saved log. Cancellation, Agent completion, and service shutdown clean up owned processes; sessions do not survive restart. New schema versions reject incompatible existing databases without deleting or migrating them.
## MCP / Jira

Settings → MCP stores global service definitions and env values in the existing SQLite database. Add Jira fills the editable Docker/PAT template; fill JIRA_URL and JIRA_PERSONAL_TOKEN. TOOLSETS=jira exposes the server’s Jira tools; READ_ONLY_MODE=false permits the account’s write tools. Docker must be running (for example the existing Colima instance). The template starts `ghcr.io/sooperset/mcp-atlassian:latest` over stdio with a 120-second startup timeout and `-e NAME` arguments; credentials are not placed in argv. Existing rows are never overwritten by template updates.

Custom stdio services use JSON `{ "command": "program", "args": [], "startup_timeout_sec": 120 }` and separate env name/password fields. URL services use `{ "url": "http://localhost:3000/mcp", "http_headers": { "Authorization": "Bearer <MCP_AUTH>" }, "startup_timeout_sec": 120 }`; HTTPS remote URLs work the same way. Add `MCP_AUTH` in that row’s masked env fields, use any API-key header such as `X-API-Key`, or omit `http_headers` for no authentication. Use either command/args or url/http_headers in a row. Startup timeout defaults to 120 seconds. Browser OAuth and legacy SSE transport fallback are not supported. JSON string values may contain `<NAME>` from that same row’s env; substitution happens once after parsing, including string fragments, without changing keys or expanding substituted values. Missing names prevent that service from starting. Invalid JSON and failed saves remain as drafts; Close retries retained saves and stays open on failure. No separate MCP configuration file is needed. Like the OpenRouter key, env values are stored in plaintext SQLite and edited with populated masked fields.

Enabled MCP services are trusted external integrations. Weft’s built-in Target/file/network sandbox does not restrict them; the server process, account and token determine access. Model calls receive every discovered tool and may invoke it directly without per-call approval. Errors return to the model without automatic retries or operation replay. Resource links remain unread links; unsupported content is retained with an explanation. Tool results preserve ordered text/images, structuredContent and isError.

Each Root Agent and Sub-agent starts its own connections, reuses them during its model loop and closes them on completion/cancellation. Agent details show that Agent’s connection status, errors and server stderr; Settings shows configuration feedback only. Editing or enabling applies to the next Agent. Disabling/deleting blocks subsequent calls immediately while in-flight calls can return; saving never restarts connections. Separate processes do not isolate shared Jira account data.

The official TypeScript client is pinned to 2.3.1. Current Jira compatibility was verified by discovering 49 tools and safely calling jira_search on 2026-10-14; actual Jira mutations were not used for verification. Controlled localhost Streamable HTTP tests verify Settings save, model tool discovery, fixed authentication, results/errors, cancellation and connection cleanup; no external HTTP service or paid model was used.
