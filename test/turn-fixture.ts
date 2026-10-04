import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

export async function waitForIdle(base: string, id: number) {
	for (let attempt = 0; attempt < 6000; attempt++) {
		const response = await fetch(`${base}/api/turns/${id}`);
		assert.equal(response.status, 200);
		const state = await response.json();
		if (!state.busy) return state.turns[0];
		await setTimeout(5);
	}
	assert.fail(`Turn ${id} did not release its chat lock`);
}

export async function waitForTurn(base: string, id: number) {
	const turn = await waitForIdle(base, id);
	assert.notEqual(turn.status, "pending");
	return turn;
}
