import type { ToolExecutor } from "../src/count-files.ts";
import { openDatabase } from "../src/database.ts";
import { createServer } from "../src/server.ts";

export function configureDatabase(
	path: string,
	apiKey = "test",
	model = "test",
) {
	const db = openDatabase(path, false);
	db.prepare(
		"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
	).run(
		model,
		model,
		JSON.stringify({
			reasoningRequired: false,
			catalogMissing: false,
			supportedEfforts: ["low", "medium", "high"],
		}),
	);
	db.prepare("UPDATE settings SET api_key=?,default_model_id=? WHERE id=1").run(
		apiKey,
		model,
	);
	db.close();
}
export function createTestServer(
	fetchModel: typeof fetch,
	path: string,
	apiKey = "test",
	model = "test",
	execute?: ToolExecutor,
) {
	configureDatabase(path, apiKey, model);
	return createServer(fetchModel, path, undefined, execute);
}
