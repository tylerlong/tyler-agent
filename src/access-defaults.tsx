import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { managementHeaders } from "./api.ts";
import type { ChatOptions } from "./chat-options.tsx";
import { createSettingState } from "./setting-state.ts";

type Defaults = Partial<Pick<ChatOptions, "fileAccess" | "networkAccess">>;
export function AccessDefaults({ open }: { open: boolean }) {
	const { t } = useTranslation();
	const [value, setValue] = useState<Defaults | null>(null);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
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
			void state.refresh();
		};
		refresh();
		window.addEventListener("settings-changed", refresh);
		return () => window.removeEventListener("settings-changed", refresh);
	}, [open, state]);
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
								setFailed((await state.save({ [key]: chosen })) !== "saved");
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
			{(failed || !value) && (
				<div role="alert">
					{t("accessDefaultsFailed")}{" "}
					<button type="button" onClick={() => void state.refresh()}>
						{t("retry")}
					</button>
				</div>
			)}
			{saving && <p role="status">{t("settingsSaving")}</p>}
		</section>
	);
}
