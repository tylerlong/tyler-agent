import assert from "node:assert/strict";
import { test } from "node:test";
import { createDebugState } from "../src/debug-state.ts";

test("a delayed PUT response cannot replace a newer SSE refresh", async () => {
	let releasePut: (() => void) | undefined;
	const putResponse = new Promise<void>((resolve) => {
		releasePut = resolve;
	});
	let serverEnabled = false;
	let displayed: boolean | null = null;
	const state = createDebugState(
		async () => serverEnabled,
		async (enabled) => {
			serverEnabled = enabled;
			await putResponse;
		},
		(enabled) => {
			displayed = enabled;
		},
	);

	const saving = state.save(true);
	serverEnabled = false; // Another tab changes the setting after this PUT is applied.
	assert.equal(await state.refresh(), true); // Its SSE notification arrives first.
	assert.equal(displayed, false);
	releasePut?.(); // The older PUT response arrives last.
	assert.equal(await saving, "saved");
	assert.equal(displayed, false);
});

test("reordered reads and a failed PUT reconcile to the latest server setting", async () => {
	const pending: Array<(enabled: boolean) => void> = [];
	let displayed: boolean | null = null;
	const state = createDebugState(
		() =>
			new Promise<boolean>((resolve) => {
				pending.push(resolve);
			}),
		async () => {
			throw new Error("write failed");
		},
		(enabled) => {
			displayed = enabled;
		},
	);
	const oldRead = state.refresh();
	const newRead = state.refresh();
	pending[1]?.(false);
	assert.equal(await newRead, true);
	pending[0]?.(true);
	assert.equal(await oldRead, true);
	assert.equal(displayed, false);

	const failedSave = state.save(true);
	await Promise.resolve();
	pending[2]?.(false);
	assert.equal(await failedSave, "failed");
	assert.equal(displayed, false);
});
