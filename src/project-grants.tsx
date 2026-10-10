import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, appError } from "./api.ts";
import type { ExecutionPermissions } from "./execution-permissions.ts";

export function ProjectGrants({
	projectId,
	grants,
	readOnly,
}: {
	projectId: number;
	grants: ExecutionPermissions;
	readOnly: boolean;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(grants);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const observed = useRef(grants);
	useEffect(() => {
		if (!dirty && grants !== observed.current) setDraft(grants);
		observed.current = grants;
	}, [grants, dirty]);
	function change(next: ExecutionPermissions) {
		setDraft(next);
		setDirty(true);
	}
	async function save() {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const saved = await api(`/api/projects/${projectId}/grants`, "PUT", {
				...draft,
				domains: draft.domains.filter((domain) => domain.trim()),
			});
			setDraft(saved.grants);
			setDirty(false);
		} catch (cause) {
			setError(appError(cause).code);
		} finally {
			setBusy(false);
		}
	}
	const disabled = readOnly || busy;
	return (
		<fieldset disabled={disabled} className="space-y-2 border-t pt-3">
			<legend className="font-semibold">{t("projectGrants")}</legend>
			<p className="text-sm text-neutral-600">{t("projectGrantsHelp")}</p>
			{draft.paths.map((scope, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: Rows contain only controlled fields, including newly added empty paths.
				<div key={index} className="flex gap-2">
					<label className="min-w-0 flex-1">
						{t("grantPath")}
						<input
							className="block w-full rounded border p-2"
							value={scope.path}
							onChange={(event) =>
								change({
									...draft,
									paths: draft.paths.map((item, i) =>
										i === index ? { ...item, path: event.target.value } : item,
									),
								})
							}
						/>
					</label>
					<label>
						{t("grantAccess")}
						<select
							aria-label={t("grantAccess")}
							className="block rounded border p-2"
							value={scope.access}
							onChange={(event) =>
								change({
									...draft,
									paths: draft.paths.map((item, i) =>
										i === index
											? {
													...item,
													access:
														event.target.value === "write" ? "write" : "read",
												}
											: item,
									),
								})
							}
						>
							<option value="read">{t("approvalAccess_read")}</option>
							<option value="write">{t("approvalAccess_write")}</option>
						</select>
					</label>
					<button
						type="button"
						className="rounded border px-2"
						aria-label={t("removeGrant", { path: scope.path })}
						onClick={() =>
							change({
								...draft,
								paths: draft.paths.filter((_, i) => i !== index),
							})
						}
					>
						{t("remove")}
					</button>
				</div>
			))}
			<button
				type="button"
				className="rounded border px-3 py-2"
				onClick={() =>
					change({
						...draft,
						paths: [...draft.paths, { path: "", access: "read" }],
					})
				}
			>
				{t("addGrantPath")}
			</button>
			<label className="block">
				{t("grantDomains")}
				<textarea
					className="block w-full rounded border p-2"
					value={draft.domains.join("\n")}
					onChange={(event) =>
						change({ ...draft, domains: event.target.value.split("\n") })
					}
				/>
			</label>
			<label className="block">
				<input
					type="checkbox"
					checked={draft.localNetwork}
					onChange={(event) =>
						change({ ...draft, localNetwork: event.target.checked })
					}
				/>{" "}
				{t("approvalLocalNetwork")}
			</label>
			{error && (
				<p role="alert" className="text-red-700">
					{t(error, { defaultValue: t("requestFailed") })}
				</p>
			)}
			<button
				type="button"
				disabled={disabled || !dirty}
				className="rounded border px-3 py-2 disabled:opacity-50"
				onClick={() => void save()}
			>
				{t("saveGrants")}
			</button>
		</fieldset>
	);
}
