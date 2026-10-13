import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { api, appError } from "./api.ts";
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
	const authorizationError = useRef(false);
	const state = useMemo(
		() =>
			createSettingState<Defaults>(
				async () => {
					try {
						const value = await api("/api/access-defaults");
						authorizationError.current = false;
						return value;
					} catch (cause) {
						authorizationError.current =
							appError(cause).code === "managementAuthorizationRequired";
						throw cause;
					}
				},
				async (value) => {
					try {
						await api("/api/access-defaults", "PATCH", value);
					} catch (cause) {
						authorizationError.current =
							appError(cause).code === "managementAuthorizationRequired";
						throw cause;
					}
				},
				setValue,
			),
		[],
	);
	const save = useCallback(
		(patch: Defaults) => {
			setSaving(true);
			const operation = state
				.save(patch)
				.then((result) => {
					if (result === "saved") {
						for (const key of ["fileAccess", "networkAccess"] as const) {
							if (
								patch[key] !== undefined &&
								retryPatch.current?.[key] === patch[key]
							)
								delete retryPatch.current[key];
						}
						if (!Object.keys(retryPatch.current ?? {}).length)
							retryPatch.current = null;
					}
					const ok = result === "saved" && !retryPatch.current;
					setFailed(!ok);
					return ok;
				})
				.finally(() => setSaving(false));
			pending.current = operation;
			return operation;
		},
		[state],
	);
	useEffect(() => {
		if (!open) return;
		const refresh = () => {
			reading.current = state.refresh().then((ok) => {
				setLoading(false);
				setFailed(!ok || !!retryPatch.current);
				return ok;
			});
		};
		refresh();
		window.addEventListener("settings-changed", refresh);
		return () => window.removeEventListener("settings-changed", refresh);
	}, [open, state]);
	useEffect(() => {
		commitRef.current = async () => {
			await pending.current;
			if (retryPatch.current) return save({ ...retryPatch.current });
			return reading.current;
		};
		return () => {
			commitRef.current = null;
		};
	}, [commitRef, save]);
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
						value={retryPatch.current?.[key] ?? value?.[key] ?? "restricted"}
						onChange={(event) => {
							const chosen = event.target.value as Defaults[typeof key];
							retryPatch.current = { ...retryPatch.current, [key]: chosen };
							// Only the changed field is sent, preserving choices saved on another page.
							void save({ [key]: chosen });
						}}
					>
						<option value="restricted">{t("accessRestricted")}</option>
						<option value="full">{t("accessFull")}</option>
					</select>
				</label>
			))}
			{(failed || (!loading && !value)) && (
				<div role="alert">
					{t(
						authorizationError.current
							? "managementAuthorizationRequired"
							: "accessDefaultsFailed",
					)}{" "}
					<button
						type="button"
						disabled={saving}
						onClick={() => {
							if (retryPatch.current) void save({ ...retryPatch.current });
							else {
								setSaving(true);
								setLoading(true);
								reading.current = state
									.refresh()
									.then((ok) => {
										setLoading(false);
										setFailed(!ok);
										return ok;
									})
									.finally(() => setSaving(false));
							}
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
