# Tyler Agent

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

## Local data

`data/tyler-agent.sqlite` stores history, settings, and your **unencrypted API key**. Keep it private. To use another database, run `pnpm start --db /absolute/path/to/chat.sqlite`; its parent directory must already exist and be private to your user (for example, permissions `0700`).

Unsupported databases are rejected without deletion or automatic migration. If an update requires a new database, use a fresh path and keep the old database for its records.
