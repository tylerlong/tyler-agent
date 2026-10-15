import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { api, appError } from "./api.ts";
import {
	jiraMcpService,
	type McpService,
	validateMcpServices,
} from "./mcp-config.ts";

const input =
	"mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const button =
	"rounded-md border border-neutral-300 px-3 py-2 hover:bg-neutral-100 disabled:opacity-50";

export function McpSettings({
	open,
	commitRef,
}: {
	open: boolean;
	commitRef: RefObject<(() => Promise<boolean>) | null>;
}) {
	const { t } = useTranslation();
	const [services, setServices] = useState<McpService[]>([]);
	const draft = useRef(services);
	const saved = useRef<string | null>(null);
	const loading = useRef<Promise<boolean> | null>(null);
	const pending = useRef<Promise<boolean> | null>(null);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState("");
	const [invalid, setInvalid] = useState<Record<string, string>>({});
	const [status, setStatus] = useState("");
	const refresh = useCallback(async () => {
		setReady(false);
		saved.current = null;
		try {
			const data = await api("/api/mcp-settings");
			validateMcpServices(data.services);
			draft.current = data.services;
			saved.current = JSON.stringify(data.services);
			setServices(data.services);
			setInvalid({});
			setStatus("");
			setReady(true);
			setError("");
			return true;
		} catch (cause) {
			setError(
				appError(cause).code === "managementAuthorizationRequired"
					? "managementAuthorizationRequired"
					: "mcpReadFailed",
			);
			return false;
		}
	}, []);
	useEffect(() => {
		if (open) loading.current = refresh();
	}, [open, refresh]);
	const commit = useCallback(async (): Promise<boolean> => {
		await loading.current;
		while (pending.current) {
			if (!(await pending.current)) return false;
		}
		if (saved.current === null) return false;
		const rows = draft.current;
		const errors: Record<string, string> = {};
		for (const row of rows) {
			if (!row.name.trim()) errors[row.id] = "mcpNameRequired";
			else
				try {
					validateMcpServices([row]);
				} catch {
					errors[row.id] = "mcpInvalidConfig";
				}
		}
		setInvalid(errors);
		if (Object.keys(errors).length) return false;
		const serialized = JSON.stringify(rows);
		if (serialized === saved.current) {
			setError("");
			return true;
		}
		setStatus("settingsSaving");
		setError("");
		const operation = (async () => {
			try {
				await api("/api/mcp-settings", "PUT", { services: rows });
				saved.current = serialized;
				setStatus(
					JSON.stringify(draft.current) === serialized ? "settingsSaved" : "",
				);
				return true;
			} catch (cause) {
				setStatus("");
				setError(
					appError(cause).code === "managementAuthorizationRequired"
						? "managementAuthorizationRequired"
						: "mcpSaveFailed",
				);
				return false;
			} finally {
				pending.current = null;
			}
		})();
		pending.current = operation;
		return operation;
	}, []);
	useEffect(() => {
		commitRef.current = async () => {
			for (;;) {
				if (!(await commit())) return false;
				if (saved.current === JSON.stringify(draft.current)) return true;
			}
		};
		return () => {
			commitRef.current = null;
		};
	}, [commit, commitRef]);
	function update(rows: McpService[]) {
		draft.current = rows;
		setServices(rows);
		setStatus("");
	}
	function change(id: string, values: Partial<McpService>) {
		update(
			draft.current.map((row) => (row.id === id ? { ...row, ...values } : row)),
		);
		setInvalid((current) => ({ ...current, [id]: "" }));
	}
	return (
		<section aria-label={t("settingsMcp")}>
			<p className="text-sm text-neutral-600">{t("mcpHelp")}</p>
			<p className="mt-2 text-sm text-neutral-600">{t("mcpTrust")}</p>
			{open && !ready && !error && <p>{t("loading")}</p>}
			{services.map((row, index) => (
				<fieldset
					key={row.id}
					disabled={!ready}
					className="mt-4 min-w-0 space-y-3 rounded-md border border-neutral-200 p-3"
				>
					<legend>{t("mcpService", { number: index + 1 })}</legend>
					<label className="block">
						{t("mcpName")}
						<input
							className={input}
							value={row.name}
							onChange={(event) => change(row.id, { name: event.target.value })}
							onBlur={() => void commit()}
						/>
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={row.enabled}
							onChange={(event) => {
								change(row.id, { enabled: event.target.checked });
								void commit();
							}}
						/>
						{t("mcpEnabled")}
					</label>
					<label className="block">
						{t("mcpJson")}
						<textarea
							className={`${input} font-mono text-sm`}
							rows={8}
							value={row.config}
							aria-invalid={!!invalid[row.id]}
							onChange={(event) =>
								change(row.id, { config: event.target.value })
							}
							onBlur={() => void commit()}
						/>
					</label>
					<p className="text-sm text-neutral-600">{t("mcpJsonHelp")}</p>
					{row.env.map((variable, envIndex) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: env names are editable; inputs have no local state
							key={`${row.id}-${envIndex}`}
							className="flex flex-wrap items-end gap-2"
						>
							<label className="min-w-0 flex-1">
								{t("mcpEnvName")}
								<input
									className={input}
									value={variable.name}
									onChange={(event) =>
										change(row.id, {
											env: row.env.map((item, i) =>
												i === envIndex
													? { ...item, name: event.target.value }
													: item,
											),
										})
									}
									onBlur={() => void commit()}
								/>
							</label>
							<label className="min-w-0 flex-1">
								{t("mcpEnvValue")}
								<input
									className={input}
									type="password"
									autoComplete="new-password"
									value={variable.value}
									onChange={(event) =>
										change(row.id, {
											env: row.env.map((item, i) =>
												i === envIndex
													? { ...item, value: event.target.value }
													: item,
											),
										})
									}
									onBlur={() => void commit()}
								/>
							</label>
							<button
								type="button"
								className={button}
								aria-label={t("mcpRemoveEnv", { name: variable.name })}
								onClick={() => {
									change(row.id, {
										env: row.env.filter((_, i) => i !== envIndex),
									});
									void commit();
								}}
							>
								×
							</button>
						</div>
					))}
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							className={button}
							onClick={() =>
								change(row.id, { env: [...row.env, { name: "", value: "" }] })
							}
						>
							{t("mcpAddEnv")}
						</button>
						<button
							type="button"
							className={button}
							onClick={() => {
								update(draft.current.filter((item) => item.id !== row.id));
								setInvalid((current) => ({ ...current, [row.id]: "" }));
								void commit();
							}}
						>
							{t("mcpRemoveService")}
						</button>
					</div>
					{invalid[row.id] && (
						<p role="alert" className="text-red-700">
							{t(invalid[row.id])}
						</p>
					)}
				</fieldset>
			))}
			<div className="mt-4 flex flex-wrap gap-2">
				<button
					type="button"
					disabled={!ready}
					className={button}
					onClick={() => {
						update([...draft.current, jiraMcpService()]);
						void commit();
					}}
				>
					{t("mcpAddJira")}
				</button>
				<button
					type="button"
					disabled={!ready}
					className={button}
					onClick={() =>
						update([
							...draft.current,
							{
								id: crypto.randomUUID(),
								name: "",
								enabled: false,
								config: "",
								env: [],
							},
						])
					}
				>
					{t("mcpAddService")}
				</button>
			</div>
			<p className="mt-2 text-sm text-neutral-600">{t("mcpJiraHelp")}</p>
			{status && (
				<p role="status" className="mt-2 text-sm text-neutral-600">
					{t(status)}
				</p>
			)}
			{error && (
				<div role="alert" className="mt-2 text-red-700">
					{t(error)}{" "}
					<button
						type="button"
						className={button}
						onClick={() => {
							if (!ready) loading.current = refresh();
							else void commit();
						}}
					>
						{t("retry")}
					</button>
				</div>
			)}
		</section>
	);
}
