import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ManagedModel, ModelSettings } from "./database.ts";

const input =
	"mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2";
const button =
	"rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50";

export function ModelConfiguration({
	settings,
	readFailed,
	refresh,
}: {
	open: boolean;
	settings: ModelSettings | null;
	readFailed: boolean;
	refresh: () => Promise<void>;
}) {
	const { t } = useTranslation();
	const [key, setKey] = useState("");
	const [query, setQuery] = useState("");
	const [catalog, setCatalog] = useState<ManagedModel[] | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [catalogError, setCatalogError] = useState(false);
	async function request(path: string, method: string, body?: unknown) {
		const response = await fetch(path, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
		if (!response.ok) throw new Error("configurationSaveFailed");
		return response.json();
	}
	async function mutate(
		path: string,
		method: string,
		body?: unknown,
		clearKey = false,
	) {
		setPending(true);
		setError("");
		try {
			await request(path, method, body);
			if (clearKey) setKey("");
			await refresh();
		} catch {
			setError("configurationSaveFailed");
		} finally {
			setPending(false);
		}
	}
	async function loadCatalog(force = false) {
		setPending(true);
		setCatalogError(false);
		try {
			const data = await request("/api/model-catalog", force ? "POST" : "GET");
			setCatalog(data.models);
			if (force) await refresh();
		} catch {
			setCatalogError(true);
		} finally {
			setPending(false);
		}
	}
	return (
		<section
			className="mt-6 border-t border-neutral-200 pt-4"
			aria-label={t("modelConfiguration")}
		>
			<h3 className="font-semibold">{t("modelConfiguration")}</h3>
			{readFailed && (
				<div role="alert">
					{t("configurationReadFailed")}{" "}
					<button
						type="button"
						className={button}
						onClick={() => void refresh()}
					>
						{t("retry")}
					</button>
				</div>
			)}
			{!settings ? (
				<p>{t("loading")}</p>
			) : (
				<>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void mutate("/api/model-settings", "PUT", { apiKey: key }, true);
						}}
					>
						<input
							type="text"
							name="username"
							autoComplete="username"
							value="local-user"
							readOnly
							hidden
						/>
						<label className="mt-4 block">
							{t("apiKey")}
							<input
								className={input}
								type="password"
								autoComplete="new-password"
								value={key}
								disabled={pending}
								onChange={(event) => setKey(event.target.value)}
							/>
						</label>
						<p className="mt-2 text-sm text-neutral-600">
							{t(
								settings.apiKeyConfigured
									? "apiKeyConfigured"
									: "apiKeyMissing",
							)}
						</p>
						<div className="mt-2 flex gap-2">
							<button type="submit" className={button} disabled={pending}>
								{t("saveKey")}
							</button>
							<button
								type="button"
								className={button}
								disabled={pending || !settings.apiKeyConfigured}
								onClick={() =>
									void mutate("/api/model-settings", "PUT", {
										removeApiKey: true,
									})
								}
							>
								{t("removeKey")}
							</button>
						</div>
					</form>
					<label className="mt-4 block">
						{t("defaultModel")}
						<select
							className={input}
							disabled={pending}
							value={settings.defaultModelId ?? ""}
							onChange={(event) =>
								void mutate("/api/model-settings", "PUT", {
									defaultModelId: event.target.value || null,
								})
							}
						>
							<option value="">{t("noDefaultModel")}</option>
							{settings.models.map((model) => (
								<option key={model.id} value={model.id}>
									{model.name}
								</option>
							))}
						</select>
					</label>
					<ul className="mt-3 space-y-2">
						{settings.models.map((model) => (
							<li
								key={model.id}
								className="flex items-center justify-between gap-2"
							>
								<span className="min-w-0 break-words">
									{model.name}
									<small className="block text-neutral-600">{model.id}</small>
									{model.catalogMissing && (
										<small className="block text-amber-700">
											{t("catalogMissing")}
										</small>
									)}
								</span>
								<button
									type="button"
									className={button}
									disabled={pending}
									aria-label={t("removeModel", { name: model.name })}
									onClick={() =>
										void mutate(
											`/api/models/${encodeURIComponent(model.id)}`,
											"DELETE",
										)
									}
								>
									{t("remove")}
								</button>
							</li>
						))}
					</ul>
					<label className="mt-4 block">
						{t("searchModels")}
						<input
							type="search"
							className={input}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							className={button}
							disabled={pending}
							onClick={() => void loadCatalog()}
						>
							{t("searchModels")}
						</button>
						<button
							type="button"
							className={button}
							disabled={pending}
							onClick={() => void loadCatalog(true)}
						>
							{t("refreshCatalog")}
						</button>
					</div>
					{catalogError && (
						<div role="alert" className="mt-2 text-red-700">
							{t("catalogReadFailed")}{" "}
							<button
								type="button"
								className={button}
								disabled={pending}
								onClick={() => void loadCatalog(true)}
							>
								{t("retry")}
							</button>
						</div>
					)}
					{catalog && (
						<ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
							{catalog
								.filter(
									(model) =>
										`${model.id} ${model.name}`
											.toLowerCase()
											.includes(query.toLowerCase()) &&
										!settings.models.some((saved) => saved.id === model.id),
								)
								.map((model) => (
									<li
										key={model.id}
										className="flex items-center justify-between gap-2"
									>
										<span className="min-w-0 break-words">
											{model.name}
											<small className="block text-neutral-600">
												{model.id}
											</small>
										</span>
										<button
											type="button"
											className={button}
											disabled={pending}
											aria-label={t("addModel", { name: model.name })}
											onClick={() =>
												void mutate("/api/models", "POST", { id: model.id })
											}
										>
											{t("add")}
										</button>
									</li>
								))}
						</ul>
					)}
				</>
			)}
			{error && (
				<p role="alert" className="mt-3 text-red-700">
					{t(error)}
				</p>
			)}
		</section>
	);
}
