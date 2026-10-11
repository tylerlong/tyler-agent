# Tyler Agent

A local coding agent with a web interface. Ask it to explore a project, edit files, run development commands, or delegate work to sub-agents.

The goal is to make agent behavior inspectable and controllable: see how your tokens are spent, and choose how models work together.

## Features

- **Transparent model communication.** Inspect each model HTTP request and response, request counts, and provider-reported usage. Credentials are redacted from communication records.
- **Flexible delegation.** Run concurrent sub-agents with different models and reasoning levels, and inspect or stop their tasks individually.
- **Local development tools.** Read and patch files, run commands, and inspect saved command output.
- **Access controls.** Limit file access to project folders and approve extra file or network permissions when needed.
- **Persistent workspace.** Keep projects, chats, settings, and task history locally. The interface supports English and Chinese.

## Quick start

Requires **macOS**, **Node.js 24 or newer**, **pnpm 11**, and a browser window of at least **1280 × 720**. Local execution currently supports macOS only.

```sh
pnpm install
pnpm start
```

Open the management URL printed in the terminal. Keep this URL private: it authorizes changes in the app. After restarting the service, open the newly printed URL.

1. Open **Settings → Models**, enter your OpenRouter API key, and add a model.
2. Create a **Project** and select its target folders. These folders are on the machine running the service.
3. Create a **Chat**, choose a model and reasoning level, and submit a task.

Use **Ctrl+C** in the terminal to stop the service. Frontend changes require running `pnpm start` again to rebuild the interface.

To use another port:

```sh
pnpm start --port 3001
```

The default port is 3000. Startup stops an existing listener on the selected port, so choose an unused port when running other services.

## Permissions

File and network access are restricted by default. Project folders and each agent's temporary workspace are writable; necessary system and toolchain paths are readable. Other access requires approval.

For extra permissions, choose **deny**, **allow once**, or **always allow for this Project**. Manage saved permissions in **Project Edit**; they are shared by that project's chats and sub-agents.

Each chat can independently enable full file or full network access. **Settings → Execution** sets defaults for new chats; changing defaults leaves existing chats unchanged. Full file access still follows your operating system's permissions.

Temporary workspaces are disposable. Save results you want to keep in your project folders.

## Local data

Data is stored in `data/tyler-agent.sqlite`, including chat history, settings, and the API key. The API key is stored unencrypted; keep the database private.

To select another database:

```sh
pnpm start --db /absolute/path/to/chat.sqlite
```

Its parent directory must already exist and be accessible only to your user (for example, permissions `0700`).

Unsupported databases are rejected without deletion or automatic migration. When an update requires a new database, use a fresh path and keep the old database if you need its records.
