import { useEffect, useState } from "react";
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
	open,
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
	const [membershipChange, setMembershipChange] = useState<{
		id: string;
		enabled: boolean;
	} | null>(null);
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
	async function changeMembership(id: string, enabled: boolean) {
		setMembershipChange({ id, enabled });
		await (enabled
			? mutate("/api/models", "POST", { id })
			: mutate(`/api/models/${encodeURIComponent(id)}`, "DELETE"));
		setMembershipChange(null);
	}
	const [catalogLoading, setCatalogLoading] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only modal openings refresh discovery
	useEffect(() => {
		if (!open) return;
		let current = true;
		setCatalogLoading(true);
		setCatalogError(false);
		void fetch("/api/model-catalog", { method: "POST" })
			.then(async (response) => {
				if (!response.ok) throw new Error("catalogReadFailed");
				const data = await response.json();
				if (current) setCatalog(data.models);
				await refresh();
			})
			.catch(() => {
				if (current) setCatalogError(true);
			})
			.finally(() => {
				if (current) setCatalogLoading(false);
			});
		return () => {
			current = false;
		};
		// Only closed-to-open transitions refresh discovery, not configuration saves.
	}, [open]);
	const matches = catalog?.filter((model) =>
		`${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
	);
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
					<ul aria-label={t("enabledModels")} className="mt-4 space-y-2">
						{settings.models.map((model) => (
							<li
								key={model.id}
								className="flex items-center justify-between gap-3"
							>
								<span className="min-w-0 flex-1 break-words">
									{model.name}
									<small className="block text-neutral-600">{model.id}</small>
								</span>
								{settings.defaultModelId === model.id ? (
									<span className="text-sm text-neutral-600">
										{t("default")}
									</span>
								) : (
									<button
										type="button"
										className={button}
										disabled={pending}
										onClick={() =>
											void mutate("/api/model-settings", "PUT", {
												defaultModelId: model.id,
											})
										}
									>
										{t("setDefault")}
									</button>
								)}
								<button
									type="button"
									className={button}
									disabled={pending}
									aria-label={t("disableModel")}
									title={t("disableModel")}
									onClick={() => void changeMembership(model.id, false)}
								>
									×
								</button>
							</li>
						))}
					</ul>
					<label className="mt-4 block">
						{t("filterModels")}
						<input
							type="search"
							className={input}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<p className="mt-2 text-sm text-neutral-600">
						{t("popularModelsScope")}
					</p>
					{catalogLoading && <p role="status">{t("loading")}</p>}
					{catalogError && (
						<p role="alert" className="mt-2 text-red-700">
							{t("catalogReadFailed")}
						</p>
					)}
					{catalog && (
						<>
							{matches?.length === 0 && <p>{t("noMatchingModels")}</p>}
							<ul
								aria-label={t("popularModels")}
								className="mt-3 max-h-64 space-y-2 overflow-y-auto"
							>
								{matches?.map((model) => {
									const enabled = settings.models.some(
										(saved) => saved.id === model.id,
									);
									return (
										<li key={model.id}>
											<label className="flex items-center gap-3">
												<input
													type="checkbox"
													checked={
														membershipChange?.id === model.id
															? membershipChange.enabled
															: enabled
													}
													disabled={pending || enabled}
													onChange={() =>
														void changeMembership(model.id, !enabled)
													}
												/>
												<span className="min-w-0 break-words">
													{model.name}
													<small className="block text-neutral-600">
														{model.id}
													</small>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						</>
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
