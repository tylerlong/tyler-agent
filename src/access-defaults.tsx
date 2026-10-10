import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { managementHeaders } from "./api.ts";
import type { ChatOptions } from "./chat-options.tsx";
import { createSettingState } from "./setting-state.ts";

type Defaults = Partial<Pick<ChatOptions, "fileAccess" | "networkAccess">>;
export function AccessDefaults({
	open,
	commitRef,
}: {
	open: boolean;
	commitRef: RefObject<(() => Promise<boolean>) | null>;
}) {
	const { t } = useTranslation();
	const [value, setValue] = useState<Defaults | null>(null);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const [loading, setLoading] = useState(true);
	const pending = useRef<Promise<boolean>>(Promise.resolve(true));
	const reading = useRef<Promise<boolean>>(Promise.resolve(true));
	const retryPatch = useRef<Defaults | null>(null);
	const writeFailed = useRef(false);
	const state = useMemo(
		() =>
			createSettingState<Defaults>(
				async () => {
					const response = await fetch("/api/access-defaults");
					if (!response.ok) throw new Error();
					return response.json();
				},
				async (value) => {
					const response = await fetch("/api/access-defaults", {
						method: "PATCH",
						headers: {
							"content-type": "application/json",
							...managementHeaders(),
						},
						body: JSON.stringify(value),
					});
					if (!response.ok) throw new Error();
				},
				setValue,
			),
		[],
	);
	useEffect(() => {
		if (!open) return;
		const refresh = () => {
			reading.current = state.refresh().then((ok) => {
				setLoading(false);
				setFailed(!ok || writeFailed.current);
				return ok;
			});
		};
		refresh();
		window.addEventListener("settings-changed", refresh);
		return () => window.removeEventListener("settings-changed", refresh);
	}, [open, state]);
	useEffect(() => {
		commitRef.current = async () => {
			const saved = await pending.current;
			return (await reading.current) && saved;
		};
		return () => {
			commitRef.current = null;
		};
	}, [commitRef]);
	return (
		<section className="mb-6" aria-labelledby="access-defaults-title">
			<h3 id="access-defaults-title" className="font-semibold">
				{t("accessDefaults")}
			</h3>
			<p className="mt-2 text-sm text-neutral-600">{t("accessDefaultsHelp")}</p>
			{(["fileAccess", "networkAccess"] as const).map((key) => (
				<label key={key} className="mt-4 block">
					{t(key)}
					<select
						aria-label={t(key)}
						className="mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2"
						disabled={!value || saving}
						value={value?.[key] ?? "restricted"}
						onChange={async (event) => {
							const chosen = event.target.value as Defaults[typeof key];
							setSaving(true);
							setFailed(false);
							// Only the changed field is sent, preserving choices saved on another page.
							try {
								retryPatch.current = { [key]: chosen };
								const operation = state
									.save(retryPatch.current)
									.then((result) => {
										const ok = result === "saved";
										if (ok) retryPatch.current = null;
										writeFailed.current = !ok;
										setFailed(!ok);
										return ok;
									});
								pending.current = operation;
								await operation;
							} catch {
								setFailed(true);
							} finally {
								setSaving(false);
							}
						}}
					>
						<option value="restricted">{t("accessRestricted")}</option>
						<option value="full">{t("accessFull")}</option>
					</select>
				</label>
			))}
			{(failed || (!loading && !value)) && (
				<div role="alert">
					{t("accessDefaultsFailed")}{" "}
					<button
						type="button"
						disabled={saving}
						onClick={() => {
							setSaving(true);
							setLoading(true);
							const retry = retryPatch.current
								? state
										.save(retryPatch.current)
										.then((result) => result === "saved")
								: state.refresh();
							reading.current = retry;
							pending.current = retry
								.then((ok) => {
									writeFailed.current = !ok;
									if (ok) retryPatch.current = null;
									setLoading(false);
									setFailed(!ok);
									return ok;
								})
								.finally(() => setSaving(false));
						}}
					>
						{t("retry")}
					</button>
				</div>
			)}
			{saving && <p role="status">{t("settingsSaving")}</p>}
		</section>
	);
}
