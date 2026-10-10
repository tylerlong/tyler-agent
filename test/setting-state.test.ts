import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingState } from "../src/setting-state.ts";

test("a delayed PUT response cannot replace a newer SSE refresh", async () => {
	let releasePut: (() => void) | undefined;
	const putResponse = new Promise<void>((resolve) => {
		releasePut = resolve;
	});
	let serverEnabled = false;
	let displayed: boolean | null = null;
	const state = createSettingState(
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
	const state = createSettingState(
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

test("a superseded confirmation read reports unknown when the newer refresh failed", async () => {
	let release!: (value: boolean) => void;
	let readCount = 0;
	let displayed: boolean | null = false;
	const state = createSettingState<boolean>(
		async () => {
			if (++readCount === 1)
				return new Promise<boolean>((resolve) => {
					release = resolve;
				});
			throw new Error("newer read failed");
		},
		async () => {},
		(value) => {
			displayed = value;
		},
	);
	const saving = state.save(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await state.refresh(), false);
	release(true);
	assert.equal(await saving, "unknown");
	assert.equal(displayed, null);
});

test("a superseded confirmation waits for the pending newer refresh before judging a save", async () => {
	const reads: Array<(value: string) => void> = [];
	let displayed: string | null = null;
	const state = createSettingState(
		() => new Promise<string>((resolve) => reads.push(resolve)),
		async () => {},
		(value) => {
			displayed = value;
		},
	);
	let settled = false;
	const saving = state.save("en").then((result) => {
		settled = true;
		return result;
	});
	await new Promise((resolve) => setImmediate(resolve));
	const newer = state.refresh();
	reads[0]("en");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		settled,
		false,
		"a pending newer read is not a failed confirmation",
	);
	reads[1]("zh-CN");
	assert.equal(await newer, true);
	assert.equal(await saving, "saved");
	assert.equal(displayed, "zh-CN");
});
