import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

export async function waitForIdle(base: string, id: number) {
	for (let attempt = 0; attempt < 6000; attempt++) {
		const response = await fetch(`${base}/api/agents/${id}`);
		assert.equal(response.status, 200);
		const state = await response.json();
		if (!state.busy) return state.agents[0];
		await setTimeout(5);
	}
	assert.fail(`Agent ${id} did not release its chat lock`);
}

export async function waitForAgent(base: string, id: number) {
	const agent = await waitForIdle(base, id);
	assert.notEqual(agent.status, "pending");
	return agent;
}
