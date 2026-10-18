# Browser tools and compatibility

The installation pins `playwright` 1.63.0 as a runtime dependency. This is the
same version already installed for the application tests. It includes the
official `playwright cli` implementation and its `playwright-cli` skill; the
separate `@playwright/cli` 0.1.22 package would install a different
1.64.0-alpha build, so it is not needed.

The command environment provides `playwright-cli` as a transparent executable
alias for the installed `playwright cli`, forwarding every argument. The
unmodified upstream skill and references appear through the existing skill
catalog. Targets need no browser-tool installation.
Use the installed browser executables and independent task profiles rather than personal browser profiles. Commands inherit the normal user HOME, PATH and development environment, with
Weft’s CLI wrapper, Node and ripgrep paths prepended and
`TYLER_MANAGEMENT_TOKEN` removed. Agent scratch supplies `TMPDIR`, `TMP`, `TEMP`
and `XDG_CACHE_HOME` (`scratch/cache`). Only the `playwright-cli` wrapper sets
`HOME` to scratch, keeping CLI daemon state, temporary profiles and sockets
independent of personal browser profiles; the macOS CLI registry does not use
`XDG_CACHE_HOME`. Installed browser
binaries remain available through `PLAYWRIGHT_BROWSERS_PATH`. This is Full Access:
commands can read the account’s configuration and credentials. The exec-server
process retains its own minimal environment and separate HOME.
Install browser binaries from the Weft directory with
`pnpm exec playwright install chromium`; the model can select them with
`playwright-cli open <url> --browser=chromium`. The upstream CLI defaults to its
own browser choice, not to Weft's configuration. The model must choose when to start a server, navigate, inspect diagnostics,
read a screenshot with `read_image`, and close the browser. No readiness policy
or browser action filter is added.

## Execution and validation

Commands run through the existing `process/start` RPC with `sandbox: null`, as the current system user. The global Jev review switch applies to browser command Tool Calls just as it does to other tools. Parameter validation, cancellation, ownership and records remain in effect. This is best-effort review, not a browser or process sandbox.

`test/browser-tools.test.ts` checks the bundled skill and CLI from an unrelated temporary target. Browser validation uses the normal execution environment; obsolete restricted-mode launches that caused macOS Chromium startup aborts are removed. On macOS, lifecycle checks correlate newly written crash reports with this run’s Chromium PIDs and time window, excluding unrelated processes.

`test/browser-diagnostics.test.ts` uses the application HTTP API, controlled
model responses and real native execution. The model starts a localhost website
as a yielding command session, opens a named CLI browser session, starts trace,
clicks a page button, reads console and indexed network metadata, reads the
POST request and response bodies separately, and verifies the resulting DOM with
`run-code`. It takes a screenshot, explicitly invokes `read_image`, and verifies
the native `input_image` content array against the image bytes and persisted
Tool Result/Model Call records. It stops trace, closes and lists its browser
session, then interrupts its server command session. These operations cross
multiple CLI invocations and retain their actual command output and ownership.
The same HTTP-submitted task includes project instructions, a selected explicit-only
Skill and a user image. It discovers a configured Streamable HTTP MCP tool
alongside the built-ins, calls it after browser diagnosis, retains both image
entry points and actual request records, and checks MCP session cleanup.
The test explicitly selects upstream `outputMode: stdout` for inline diagnostic
assertions; production CLI defaults are unchanged. Native CI installs Chromium
and runs both tests on macOS, alongside the existing lifecycle tests.

Upstream detached CLI daemons can outlive a command and have their normal idle
timeout. The model must close browsers it owns; Weft does not add a Chat lifetime
policy or automatic personal-browser attachment. Browser artifacts use the
chosen cwd and normal file permissions, so save wanted screenshots and trace
files in a Target Folder. No paid model call or personal browser takeover was
used; protocol evidence does not prove that a paid model interpreted the image.

## Primary sources

- [Official Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Playwright 1.63.0 sources](https://github.com/microsoft/playwright/tree/v1.63.0)
- [Codex 0.162.0 process sandbox preparation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/process_sandbox.rs)
- [Codex 0.162.0 sandbox selection](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/sandbox_selection.rs)
- [Codex 0.162.0 sandbox manager](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/sandboxing/src/manager.rs)
