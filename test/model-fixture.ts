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
