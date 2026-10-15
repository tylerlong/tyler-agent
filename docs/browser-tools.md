# Browser tools: compatibility checkpoint

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
The model must choose when to start a server, navigate, inspect diagnostics,
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
failed. This is not a missing executable, website-readiness failure or missing
localhost grant. Exec-server explicitly selects `SandboxablePreference::Require`
when the request includes a sandbox object; its manager applies the native
sandbox even when its file and network permissions are unrestricted. Its public
path/domain/local-network permissions cannot grant Mach bootstrap registration.
The application's sandbox behavior has not been changed or bypassed.

The CLI version, skill discovery and native read access are tested independently.
Successful page actions, console/network bodies, cross-command browser sessions,
screenshots, trace and close/cleanup **have not been demonstrated through the
application**. This checkpoint does not satisfy #166's browser end-to-end
acceptance. No paid model call or personal browser takeover was used.

## Primary sources

- [Official Playwright CLI](https://github.com/microsoft/playwright-cli)
- [Playwright 1.63.0 sources](https://github.com/microsoft/playwright/tree/v1.63.0)
- [Codex 0.162.0 process sandbox preparation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/process_sandbox.rs)
- [Codex 0.162.0 sandbox selection](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/exec-server/src/sandbox_selection.rs)
- [Codex 0.162.0 sandbox manager](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/sandboxing/src/manager.rs)
