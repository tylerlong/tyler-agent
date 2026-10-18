import assert from "node:assert/strict";

export function withSafetyReview(fetchModel: typeof fetch): typeof fetch {
	return async (url, init) => {
		if (String(url) !== "https://openrouter.ai/api/alpha/decisions") {
			assert.equal(String(url), "https://openrouter.ai/api/v1/responses");
			return fetchModel(url, init);
		}
		const request = JSON.parse(String(init?.body));
		assert.equal(init?.method, "POST");
		assert.equal(request.model, "~typesafe/jev-latest");
		assert.equal(request.questions.safety.type, "choice");
		assert.deepEqual(Object.keys(request.questions.safety.criteria), [
			"allow",
			"block",
		]);
		assert.equal(typeof request.state, "object");
		return Response.json({
			id: "gen-decision-test",
			model: "typesafe/jev-mock-version",
			answers: { safety: { type: "choice", choice: "allow" } },
			usage: { input_tokens: 12, output_tokens: 0, cost: 0 },
		});
	};
}

export const frame = (type: string, fields: Record<string, unknown> = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

export function completedBody(response: unknown) {
	return frame("response.completed", {
		response: { status: "completed", ...(response as Record<string, unknown>) },
	});
}

export function completedResponse(response: unknown) {
	return new Response(completedBody(response), {
		headers: { "content-type": "text/event-stream" },
	});
}
