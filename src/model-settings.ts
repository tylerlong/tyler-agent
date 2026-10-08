import type { DatabaseSync } from "node:sqlite";

export type ManagedModel = {
	id: string;
	name: string;
	supportedEfforts?: string[] | null;
	reasoningRequired: boolean;
	catalogMissing: boolean;
};
export type ModelSettings = {
	apiKeyConfigured: boolean;
	defaultModelId: string | null;
	models: ManagedModel[];
};

export class ModelSettingsError extends Error {
	code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export function createModelSettings(
	database: DatabaseSync,
	fetchCatalog: typeof fetch,
	notifyChange: () => void,
) {
	function read(): ModelSettings {
		const settings = database
			.prepare("SELECT api_key,default_model_id FROM settings WHERE id=1")
			.get();
		return {
			apiKeyConfigured: !!settings?.api_key,
			defaultModelId:
				settings?.default_model_id === null
					? null
					: String(settings?.default_model_id),
			models: database
				.prepare("SELECT id,name,metadata FROM managed_models ORDER BY rowid")
				.all()
				.map((row) => ({
					id: String(row.id),
					name: String(row.name),
					...JSON.parse(String(row.metadata)),
				})),
		};
	}
	let catalog: ManagedModel[] | undefined;
	let catalogLoading: Promise<ManagedModel[]> | undefined;
	const loadCatalog = (refresh = false): Promise<ManagedModel[]> => {
		if (!refresh && catalog) return Promise.resolve(catalog);
		if (catalogLoading) return catalogLoading;
		catalogLoading = (async () => {
			const response = await fetchCatalog(
				"https://openrouter.ai/api/v1/models?sort=most-popular&limit=100&output_modalities=text",
				{ method: "GET" },
			);
			if (!response.ok) throw new ModelSettingsError("modelCatalogFailed");
			const body = await response.json();
			if (!Array.isArray(body?.data))
				throw new ModelSettingsError("modelCatalogFailed");
			const rows = body.data as {
				id: string;
				name: string;
				architecture?: { output_modalities?: string[] };
				reasoning?: { supported_efforts?: unknown; mandatory?: boolean };
			}[];
			if (
				rows.some(
					(row) =>
						typeof row?.id !== "string" ||
						!row.id.trim() ||
						typeof row.name !== "string" ||
						!Array.isArray(row.architecture?.output_modalities),
				)
			)
				throw new ModelSettingsError("modelCatalogFailed");
			const next: ManagedModel[] = rows
				.filter(
					(row) =>
						typeof row?.id === "string" &&
						row.id.trim() &&
						typeof row.name === "string" &&
						Array.isArray(row.architecture?.output_modalities) &&
						row.architecture.output_modalities.includes("text"),
				)
				.slice(0, 100)
				.map((row) => ({
					id: row.id,
					name: row.name,
					...(row.reasoning &&
					Object.hasOwn(row.reasoning, "supported_efforts") &&
					(row.reasoning.supported_efforts === null ||
						(Array.isArray(row.reasoning.supported_efforts) &&
							row.reasoning.supported_efforts.every(
								(effort: unknown) => typeof effort === "string",
							)))
						? { supportedEfforts: row.reasoning.supported_efforts }
						: {}),
					reasoningRequired: row.reasoning?.mandatory === true,
					catalogMissing: false,
				}));
			database.exec("BEGIN");
			try {
				// Read membership after the network wait, preserving concurrent additions/removals.
				for (const model of read().models) {
					const found = next.find((row) => row.id === model.id);
					if (!found) continue;
					const { id, name, ...metadata } = found;
					database
						.prepare("UPDATE managed_models SET name=?,metadata=? WHERE id=?")
						.run(name, JSON.stringify(metadata), id);
				}
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			catalog = next;
			notifyChange();
			return next;
		})().finally(() => {
			catalogLoading = undefined;
		});
		return catalogLoading;
	};

	const readCredential = () =>
		database.prepare("SELECT api_key FROM settings WHERE id=1").get()
			?.api_key ?? "";
	const update = (input: Record<string, unknown>) => {
		if (
			input.apiKey !== undefined &&
			(typeof input.apiKey !== "string" || /[\r\n]/.test(input.apiKey))
		)
			throw new ModelSettingsError("invalidApiKey");
		if (
			input.removeApiKey !== undefined &&
			typeof input.removeApiKey !== "boolean"
		)
			throw new ModelSettingsError("invalidInput");
		if (
			input.defaultModelId !== undefined &&
			input.defaultModelId !== null &&
			(typeof input.defaultModelId !== "string" ||
				!database
					.prepare("SELECT 1 FROM managed_models WHERE id=?")
					.get(input.defaultModelId))
		)
			throw new ModelSettingsError("invalidModel");
		database.exec("BEGIN");
		try {
			if (input.removeApiKey === true)
				database.prepare("UPDATE settings SET api_key=NULL WHERE id=1").run();
			else if (typeof input.apiKey === "string")
				database
					.prepare("UPDATE settings SET api_key=? WHERE id=1")
					.run(input.apiKey.trim() || null);
			if (input.defaultModelId !== undefined)
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(input.defaultModelId as string | null);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		notifyChange();
		return read();
	};
	const add = (id: unknown) => {
		if (typeof id !== "string" || !id.trim())
			throw new ModelSettingsError("invalidModel");
		const existing = read();
		if (existing.models.some((model) => model.id === id)) {
			return { ...existing, firstModelAdded: false };
		}
		const model = catalog?.find((model) => model.id === id);
		if (!model) throw new ModelSettingsError("invalidModel");
		const { name, ...metadata } = model;
		delete (metadata as Partial<ManagedModel>).id;
		let firstModelAdded = false;
		database.exec("BEGIN");
		try {
			const wasEmpty = read().models.length === 0;
			const inserted = database
				.prepare(
					"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
				)
				.run(id, name, JSON.stringify(metadata));
			firstModelAdded = wasEmpty && inserted.changes > 0;
			if (firstModelAdded)
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(id);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		notifyChange();
		return { ...read(), firstModelAdded };
	};
	const remove = (id: string) => {
		database.exec("BEGIN");
		try {
			const settings = read();
			database
				.prepare("UPDATE chats SET reasoning_effort=NULL WHERE model_id=?")
				.run(id);
			database.prepare("DELETE FROM managed_models WHERE id=?").run(id);
			if (settings.defaultModelId === id) {
				const remaining = settings.models.filter((model) => model.id !== id);
				const replacement =
					catalog?.find((model) =>
						remaining.some((enabled) => enabled.id === model.id),
					) ?? remaining[0];
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(replacement?.id ?? null);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		notifyChange();
		return read();
	};
	return { read, readCredential, update, loadCatalog, add, remove };
}
