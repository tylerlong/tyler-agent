import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createProductionServer } from "../src/server.ts";
import { managementTokens } from "./local-fetch.ts";

export const createServer: typeof createProductionServer = (...args) => {
	// Tests never read the developer's real user instructions or installed skills.
	args[5] ??= join(tmpdir(), "weft-test-no-user-config");
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
