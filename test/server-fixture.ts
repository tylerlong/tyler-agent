import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createProductionServer } from "../src/server.ts";
import { localFetch, managementTokens } from "./local-fetch.ts";
import { withSafetyReview } from "./model-fixture.ts";

export const createServer: typeof createProductionServer = (...args) => {
	// Tests never read the developer's real user instructions or installed skills.
	args[5] ??= join(tmpdir(), "weft-test-no-user-config");
	// Unrelated lifecycle tests still exercise default-on review through mocked HTTP.
	const model = args[0];
	args[0] = withSafetyReview(
		!model || model === fetch || model === localFetch
			? async () => {
					throw new Error("Model HTTP request has no configured mock");
				}
			: model,
	);
	const server = createProductionServer(...args);
	let origin: string | undefined;
	server.on("listening", () => {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture address");
		origin = `http://127.0.0.1:${address.port}`;
		managementTokens.set(origin, server.managementToken);
	});
	server.on("close", () => {
		if (origin) managementTokens.delete(origin);
	});
	return server;
};
