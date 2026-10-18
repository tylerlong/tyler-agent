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
import { createSettingState } from "./setting-state.ts";

type ReviewSetting = { safetyReview: boolean };
export function SafetyReview({
	open,
	commitRef,
}: {
	open: boolean;
	commitRef: RefObject<(() => Promise<boolean>) | null>;
}) {
	const { t } = useTranslation();
	const [value, setValue] = useState<ReviewSetting | null>(null);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const [loading, setLoading] = useState(true);
	const pending = useRef<Promise<boolean>>(Promise.resolve(true));
	const reading = useRef<Promise<boolean>>(Promise.resolve(true));
	const retryPatch = useRef<ReviewSetting | null>(null);
	const authorizationError = useRef(false);
	const state = useMemo(
		() =>
			createSettingState<ReviewSetting>(
				async () => {
					try {
						const value: ReviewSetting = await api("/api/safety-review");
						if (typeof value.safetyReview !== "boolean")
							throw new Error("Invalid safety review setting");
						if (!retryPatch.current) authorizationError.current = false;
						return value;
					} catch (cause) {
						authorizationError.current ||=
							appError(cause).code === "managementAuthorizationRequired";
						throw cause;
					}
				},
				async (value) => {
					try {
						await api("/api/safety-review", "PATCH", value);
					} catch (cause) {
						authorizationError.current ||=
							appError(cause).code === "managementAuthorizationRequired";
						throw cause;
					}
				},
				setValue,
			),
		[],
	);
	const save = useCallback(
		(patch: ReviewSetting) => {
			setSaving(true);
			const operation = state
				.save(patch)
				.then((result) => {
					if (result === "saved") {
						if (retryPatch.current?.safetyReview === patch.safetyReview)
							retryPatch.current = null;
						if (!retryPatch.current) authorizationError.current = false;
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
		<section className="mb-6" aria-labelledby="safety-review-title">
			<h3 id="safety-review-title" className="font-semibold">
				{t("safetyReview")}
			</h3>
			<p className="mt-2 text-sm text-neutral-600">{t("safetyReviewHelp")}</p>
			<label className="mt-4 flex items-center gap-2">
				<input
					type="checkbox"
					disabled={!value || saving}
					checked={
						retryPatch.current?.safetyReview ?? value?.safetyReview ?? true
					}
					onChange={(event) => {
						retryPatch.current = { safetyReview: event.target.checked };
						void save(retryPatch.current);
					}}
				/>
				{t("safetyReview")}
			</label>
			{(failed || (!loading && !value)) && (
				<div role="alert">
					{t(
						authorizationError.current
							? "managementAuthorizationRequired"
							: "safetyReviewSettingsFailed",
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
