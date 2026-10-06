import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
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
	active,
	commitRef,
}: {
	open: boolean;
	active: boolean;
	settings: ModelSettings | null;
	readFailed: boolean;
	refresh: () => Promise<void>;
	commitRef: RefObject<(() => Promise<boolean>) | null>;
}) {
	const { t } = useTranslation();
	const [key, setKey] = useState("");
	const [query, setQuery] = useState("");
	const [catalog, setCatalog] = useState<ManagedModel[] | null>(null);
	const [pending, setPending] = useState(false);
	const [adding, setAdding] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const returnAdditionFocus = useRef(false);
	const searchInput = useRef<HTMLInputElement>(null);
	const section = useRef<HTMLDivElement>(null);
	const saving = useRef(false);
	const modelSave = useRef<Promise<boolean> | null>(null);
	const modelFailed = useRef(false);
	const modelRetry = useRef<(() => Promise<boolean> | null) | null>(null);
	const credential = useRef({ draft: "", saved: "", loaded: false, error: "" });
	const keyRead = useRef<Promise<boolean> | null>(null);
	const keySave = useRef<Promise<boolean> | null>(null);
	const [keyLoaded, setKeyLoaded] = useState(false);
	const [popup, setPopup] = useState<{
		dialog: HTMLDialogElement;
		left: number;
		width: number;
		top: number;
		maxHeight: number;
		above: boolean;
	} | null>(null);
	useLayoutEffect(() => {
		if (!adding || !open || !active || !expanded) {
			setPopup(null);
			return;
		}
		const search = searchInput.current;
		const dialog = section.current?.closest("dialog");
		const content = section.current?.closest(".settings-content");
		if (!search || !dialog || !content) return;
		const position = () => {
			const anchor = search.getBoundingClientRect();
			const bounds = content.getBoundingClientRect();
			if (anchor.top < bounds.top || anchor.bottom > bounds.bottom) {
				setPopup(null);
				return;
			}
			const below = Math.max(0, bounds.bottom - anchor.bottom - 8);
			const above = Math.max(0, anchor.top - bounds.top - 8);
			const upwards = below < 192 && above > below;
			setPopup({
				dialog,
				left: anchor.left,
				width: anchor.width,
				top: upwards ? anchor.top - 4 : anchor.bottom + 4,
				maxHeight: Math.min(320, upwards ? above : below),
				above: upwards,
			});
		};
		position();
		const observer = new ResizeObserver(position);
		observer.observe(dialog);
		observer.observe(search);
		if (section.current) observer.observe(section.current);
		content.addEventListener("scroll", position);
		window.addEventListener("resize", position);
		return () => {
			observer.disconnect();
			content.removeEventListener("scroll", position);
			window.removeEventListener("resize", position);
		};
	}, [adding, open, active, expanded]);
	const [error, setError] = useState("");
	const [additionError, setAdditionError] = useState("");
	const [keyError, setKeyError] = useState("");
	const [keySaving, setKeySaving] = useState(false);
	const [keySaved, setKeySaved] = useState(false);
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
	function mutate(path: string, method: string, body?: unknown) {
		if (saving.current) return modelSave.current;
		saving.current = true;
		setPending(true);
		setError("");
		modelFailed.current = false;
		modelRetry.current = null;
		const operation = (async () => {
			try {
				await request(path, method, body);
				await refresh();
				return true;
			} catch {
				modelFailed.current = true;
				modelRetry.current = () => mutate(path, method, body);
				setError("configurationSaveFailed");
				return false;
			} finally {
				saving.current = false;
				setPending(false);
				modelSave.current = null;
			}
		})();
		modelSave.current = operation;
		return operation;
	}
	async function saveKey(): Promise<boolean> {
		if (keyRead.current && !(await keyRead.current)) return false;
		if (!credential.current.loaded) return false;
		while (keySave.current) {
			if (!(await keySave.current)) return false;
		}
		const value = credential.current.draft;
		if (value === credential.current.saved) return !credential.current.error;
		credential.current.error = "";
		setKeyError("");
		setKeySaved(false);
		setKeySaving(true);
		const operation = (async () => {
			try {
				await request("/api/model-settings", "PUT", { apiKey: value });
				credential.current.saved = value;
				setKeySaved(credential.current.draft === value);
				await refresh();
				return true;
			} catch {
				credential.current.error = "credentialSaveFailed";
				setKeyError("credentialSaveFailed");
				return false;
			} finally {
				setKeySaving(false);
				keySave.current = null;
			}
		})();
		keySave.current = operation;
		return operation;
	}
	useLayoutEffect(() => {
		commitRef.current = async () => {
			const modelOperation = modelSave.current ?? modelRetry.current?.();
			let keyOk = await saveKey();
			while (keyOk && credential.current.draft !== credential.current.saved) {
				keyOk = await saveKey();
			}
			let modelOk = modelOperation ? await modelOperation : true;
			do {
				while (modelSave.current) {
					if (!(await modelSave.current)) modelOk = false;
				}
				if (keyOk && credential.current.draft !== credential.current.saved) {
					keyOk = await saveKey();
				}
			} while (
				modelSave.current ||
				(keyOk && credential.current.draft !== credential.current.saved)
			);
			return keyOk && modelOk && !modelFailed.current && !readFailed;
		};
		return () => {
			commitRef.current = null;
		};
	});
	function readCredential() {
		if (keyRead.current) return keyRead.current;
		const previousSaved = credential.current.saved;
		const operation = (async () => {
			try {
				const data = await request("/api/settings/credential", "GET");
				const state = credential.current;
				if (
					!state.loaded ||
					(!keySave.current &&
						state.error !== "credentialSaveFailed" &&
						state.saved === previousSaved &&
						state.draft === state.saved)
				) {
					state.draft = data.apiKey;
					state.saved = data.apiKey;
					setKey(data.apiKey);
				}
				state.loaded = true;
				if (state.error === "credentialReadFailed") {
					state.error = "";
					setKeyError("");
				}
				setKeyLoaded(true);
				return true;
			} catch {
				credential.current.error = "credentialReadFailed";
				setKeyError("credentialReadFailed");
				return false;
			} finally {
				keyRead.current = null;
			}
		})();
		keyRead.current = operation;
		return operation;
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh clean credentials on shared settings synchronization
	useEffect(() => {
		if (
			open &&
			!keySave.current &&
			credential.current.draft === credential.current.saved &&
			credential.current.error !== "credentialSaveFailed"
		)
			void readCredential();
	}, [open, settings]);
	function cancelAddition() {
		if (saving.current) return;
		setAdding(false);
		setQuery("");
		setAdditionError("");
		modelFailed.current = false;
		modelRetry.current = null;
		setHighlighted(null);
		returnAdditionFocus.current = true;
	}
	useLayoutEffect(() => {
		if (returnAdditionFocus.current && active && open && !adding && !pending) {
			returnAdditionFocus.current = false;
			addButton.current?.focus();
		}
	}, [adding, pending, active, open]);
	function addModel(id: string) {
		if (saving.current || pending) return modelSave.current;
		saving.current = true;
		setPending(true);
		setAdditionError("");
		modelFailed.current = false;
		modelRetry.current = null;
		const operation = (async () => {
			try {
				await request("/api/models", "POST", { id });
				await refresh();
				saving.current = false;
				cancelAddition();
				return true;
			} catch {
				modelFailed.current = true;
				modelRetry.current = () => addModel(id);
				setAdditionError("configurationSaveFailed");
				return false;
			} finally {
				saving.current = false;
				setPending(false);
				modelSave.current = null;
			}
		})();
		modelSave.current = operation;
		return operation;
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: cancellation reads pending from the dispatch guard
	useEffect(() => {
		if (!adding || !open || !active) return;
		searchInput.current?.focus();
		const dialog = section.current?.closest("dialog");
		const cancel = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancelAddition();
		};
		const cancelModal = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			cancelAddition();
		};
		dialog?.addEventListener("keydown", cancel);
		dialog?.addEventListener("cancel", cancelModal);
		return () => {
			dialog?.removeEventListener("keydown", cancel);
			dialog?.removeEventListener("cancel", cancelModal);
		};
	}, [adding, open, active]);
	useEffect(() => {
		if (!active) setExpanded(false);
	}, [active]);
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
	const matches = catalog?.filter(
		(model) =>
			!settings?.models.some((saved) => saved.id === model.id) &&
			`${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
	);
	return (
		<div ref={section}>
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
					<section aria-label={t("credentials")}>
						<h3 className="font-semibold">{t("apiKey")}</h3>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void saveKey();
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
								<span className="sr-only">{t("apiKey")}</span>
								<input
									className={input}
									placeholder={t(
										settings.apiKeyConfigured ? "replaceKey" : "enterKey",
									)}
									type="password"
									autoComplete="new-password"
									value={key}
									disabled={!keyLoaded}
									onChange={(event) => {
										credential.current.draft = event.target.value;
										credential.current.error = "";
										setKey(event.target.value);
										setKeyError("");
										setKeySaved(false);
									}}
									onBlur={() => void saveKey()}
								/>
							</label>
							<p className="mt-2 text-sm text-neutral-600">
								{t(
									settings.apiKeyConfigured
										? "apiKeyConfigured"
										: "apiKeyMissing",
								)}
							</p>
							<div className="mt-2 min-h-10">
								{(keySaving || keySaved) && (
									<p role="status" className="text-sm text-neutral-600">
										{t(keySaving ? "settingsSaving" : "settingsSaved")}
									</p>
								)}
								{keyError && (
									<p role="alert" className="break-words text-red-700">
										{t(keyError)}
										{keyError === "credentialReadFailed" && (
											<button
												type="button"
												className={button}
												onClick={() => void readCredential()}
											>
												{t("retry")}
											</button>
										)}
									</p>
								)}
							</div>
						</form>
					</section>
					<section
						aria-label={t("modelConfiguration")}
						className="mt-6 border-t border-neutral-200 pt-4"
					>
						<h3 className="font-semibold">{t("modelConfiguration")}</h3>
						<ul aria-label={t("enabledModels")} className="mt-4 space-y-2">
							{settings.models.map((model) => (
								<li
									key={model.id}
									className="flex items-center justify-between gap-3"
								>
									<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
										{model.name}
										<small className="block text-neutral-600">{model.id}</small>
									</span>
									{settings.defaultModelId === model.id ? (
										<span className="shrink-0 text-sm text-neutral-600">
											{t("default")}
										</span>
									) : (
										<button
											type="button"
											className={`${button} shrink-0`}
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
										onClick={() =>
											void mutate(
												`/api/models/${encodeURIComponent(model.id)}`,
												"DELETE",
											)
										}
									>
										×
									</button>
								</li>
							))}
						</ul>
						<div className="mt-4">
							{!adding ? (
								<button
									ref={addButton}
									type="button"
									className={button}
									disabled={pending}
									onClick={() => setAdding(true)}
								>
									{t("addModel")}
								</button>
							) : (
								<>
									<div className="flex items-center gap-2">
										<input
											ref={searchInput}
											role="combobox"
											aria-label={t("filterModels")}
											placeholder={t("filterModels")}
											aria-autocomplete="list"
											aria-expanded={expanded && popup !== null}
											aria-controls="model-candidates"
											aria-activedescendant={
												matches?.some((model) => model.id === highlighted)
													? `candidate-${highlighted}`
													: undefined
											}
											className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2"
											value={query}
											onFocus={() => setExpanded(true)}
											onBlur={(event) => {
												if (
													event.relatedTarget &&
													!(
														event.relatedTarget instanceof Element &&
														event.relatedTarget.closest(".model-popup")
													)
												)
													setExpanded(false);
											}}
											disabled={pending}
											onChange={(event) => {
												setQuery(event.target.value);
												setHighlighted(null);
											}}
											onKeyDown={(event) => {
												if (pending) return;
												if (
													event.key === "ArrowDown" ||
													event.key === "ArrowUp"
												) {
													event.preventDefault();
													if (!matches?.length) return;
													const index = matches.findIndex(
														(model) => model.id === highlighted,
													);
													const next =
														index < 0
															? event.key === "ArrowDown"
																? 0
																: matches.length - 1
															: (index +
																	(event.key === "ArrowDown" ? 1 : -1) +
																	matches.length) %
																matches.length;
													setHighlighted(matches[next].id);
													requestAnimationFrame(() =>
														document
															.getElementById(`candidate-${matches[next].id}`)
															?.scrollIntoView({ block: "nearest" }),
													);
												} else if (event.key === "Enter") {
													event.preventDefault();
													if (
														matches?.some((model) => model.id === highlighted)
													)
														void addModel(highlighted as string);
												}
											}}
										/>
										<button
											type="button"
											className={`${button} shrink-0`}
											disabled={pending}
											onClick={cancelAddition}
										>
											{t("cancel")}
										</button>
									</div>
									{popup &&
										expanded &&
										createPortal(
											<div
												className="model-popup"
												style={{
													left: popup.left,
													top: popup.top,
													width: popup.width,
													maxHeight: popup.maxHeight,
													transform: popup.above
														? "translateY(-100%)"
														: undefined,
												}}
											>
												{catalogLoading && (
													<p role="status" className="px-3 py-2">
														{t("loading")}
													</p>
												)}
												{catalogError && (
													<p role="alert" className="px-3 py-2 text-red-700">
														{t("catalogReadFailed")}
													</p>
												)}
												{additionError && (
													<p role="alert" className="px-3 py-2 text-red-700">
														{t(additionError)}
													</p>
												)}
												{matches?.length === 0 && (
													<p role="status" className="px-3 py-2">
														{t("noMatchingModels")}
													</p>
												)}
												<div
													id="model-candidates"
													role="listbox"
													aria-label={t("popularModels")}
													className="min-h-0 overflow-y-auto overscroll-contain"
												>
													{matches?.map((model) => (
														<li key={model.id} role="presentation">
															<button
																id={`candidate-${model.id}`}
																type="button"
																role="option"
																aria-selected={highlighted === model.id}
																disabled={pending}
																tabIndex={-1}
																className={`w-full px-3 py-2 text-left [overflow-wrap:anywhere] hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 ${highlighted === model.id ? "bg-blue-50 outline-2 -outline-offset-2 outline-blue-600" : ""}`}
																onClick={() => void addModel(model.id)}
															>
																{model.name}
																<small className="block text-neutral-600">
																	{model.id}
																</small>
															</button>
														</li>
													))}
												</div>
											</div>,
											popup.dialog,
										)}
								</>
							)}
						</div>
						{catalogLoading && (
							<p
								role="status"
								aria-hidden={adding}
								className={adding ? "invisible" : undefined}
							>
								{t("loading")}
							</p>
						)}
						{catalogError && (
							<p
								role="alert"
								aria-hidden={adding}
								className={`mt-2 text-red-700 ${adding ? "invisible" : ""}`}
							>
								{t("catalogReadFailed")}
							</p>
						)}
						{error && (
							<p role="alert" className="mt-3 break-words text-red-700">
								{t(error)}
							</p>
						)}
					</section>
				</>
			)}
		</div>
	);
}
