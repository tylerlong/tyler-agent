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

Stop with **Ctrl+C**. The default port is 3000; use `pnpm start --port 3001` to change it. Startup stops existing listeners on the selected port, so choose an unused port.

## Permissions

File and network access are restricted by default. Project folders and each agent's temporary workspace are writable; necessary system and toolchain paths are readable. Extra access can be denied, allowed once, or saved for the Project. Manage saved permissions in **Project Edit**; all chats and sub-agents in that project share them.

Each chat can independently enable full file or full network access. **Settings → Execution** sets defaults for new chats only. Full file access remains subject to OS permissions. Temporary workspaces are disposable; save wanted results in project folders.

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

Command Output, including PTY bytes and text, stays with the launching Tool Call. Refresh its details to see current process state and new logs; `read_tool_output` gives the model bounded historical pages. Output budgets affect the returned text only (four characters per requested token), never the saved log. Cancellation, Agent completion, and service shutdown clean up owned processes; sessions do not survive restart. New schema versions reject incompatible existing databases without deleting or migrating them.
