import assert from "node:assert/strict";
import { test } from "node:test";
import { withSafetyReview } from "./model-fixture.ts";

test("mock Decisions HTTP preserves the task response sequence and rejects unknown requests", async () => {
	let taskCalls = 0;
	const model = withSafetyReview(async () =>
		Response.json({ taskCall: ++taskCalls }),
	);
	const taskUrl = "https://openrouter.ai/api/v1/responses";
	assert.deepEqual(await (await model(taskUrl)).json(), { taskCall: 1 });
	const response = await model("https://openrouter.ai/api/alpha/decisions", {
		method: "POST",
		body: JSON.stringify({
			model: "~typesafe/jev-latest",
			state: { name: "read_file", arguments: { path: "/tmp/mock.txt" } },
			questions: {
				safety: {
					type: "choice",
					criteria: { allow: "allow", block: "block" },
				},
			},
		}),
	});
	assert.equal((await response.json()).answers.safety.choice, "allow");
	assert.deepEqual(await (await model(taskUrl)).json(), { taskCall: 2 });
	await assert.rejects(model("https://example.test/unconfigured-model"));
	assert.equal(taskCalls, 2);
});
