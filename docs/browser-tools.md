# Browser tools and compatibility

The installation pins `playwright` 1.63.0 as a runtime dependency. This is the
same version already installed for the application tests. It includes the
official `playwright cli` implementation and its `playwright-cli` skill; the
separate `@playwright/cli` 0.1.22 package would install a different
1.64.0-alpha build, so it is not needed.

The command environment provides `playwright-cli` as a transparent executable
alias for the installed `playwright cli`, forwarding every argument. The
unmodified upstream skill and references appear through the existing skill
catalog and trusted read permissions. Targets need no browser-tool installation.
The installation's browser executables are read-only toolchain resources; cached
host browser profiles are not granted. CLI daemon state, temporary profiles and
sockets use the existing Agent HOME/scratch, retaining upstream session defaults.
Install browser binaries from the Weft directory with
`pnpm exec playwright install chromium`; the model can select them with
`playwright-cli open <url> --browser=chromium`. The upstream CLI defaults to its
own browser choice, not to Weft's configuration. The model must choose when to start a server, navigate, inspect diagnostics,
read a screenshot with `read_image`, and close the browser. No readiness policy
or browser action filter is added.

## Actual macOS result

On 2026-10-14, native Codex 0.162.0 sandbox probes reached the official CLI and
launched the installed Chromium 1243 executable, but the browser exited during
startup. The regular Chromium build aborted in LaunchServices
`_RegisterApplication`. A separate diagnostic using the upstream configuration
option to select Chromium headless shell, with generic local-network and
`/System/Library` read grants, exposed the underlying denial:

```text
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>:
Permission denied (1100)
```

A separate probe with both existing full file and full network permissions also
initially failed: exec-server selects `SandboxablePreference::Require` whenever
the request includes a sandbox object. Its public path/domain/local-network
permissions cannot grant Mach bootstrap registration. This is not a missing
executable, website-readiness failure or missing localhost grant.

The user confirmed that commands should pass `sandbox: null` on the same
`process/start` RPC only when both current file and network permissions are
full. If either dimension is restricted, the native sandbox remains. There is
no new toggle, execution path or browser-specific bypass, and a failed command
is never automatically retried with greater permissions. Parameter/scope
validation, credential filtering, cancellation, ownership and records still
apply; both-full commands run with the system user's permissions.

## Verified behavior

`test/browser-tools.test.ts` checks the unmodified bundled skill and CLI from an
unrelated temporary target, then verifies all four access-mode combinations:
an outside-target file is readable exactly when file access is full, and
localhost is reachable exactly when network access is full. Chromium launch
succeeds only in the both-full combination on the tested macOS sandbox.

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
and runs both tests on macOS, alongside the existing permission/lifecycle tests.

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
