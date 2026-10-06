import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";

const keys = ["modelCallLimit", "subAgentLimit"] as const;
type Key = (typeof keys)[number];
type Limits = Record<Key, number>;
const control =
	"mt-2 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

export function ExecutionLimits({
	open,
	commitRef,
}: {
	open: boolean;
	commitRef: RefObject<(() => Promise<boolean>) | null>;
}) {
	const { t } = useTranslation();
	const [drafts, setDrafts] = useState<Record<Key, string>>({
		modelCallLimit: "",
		subAgentLimit: "",
	});
	const draftRef = useRef(drafts);
	const saved = useRef<Limits | null>(null);
	const loading = useRef<Promise<void> | null>(null);
	const pending = useRef<Partial<Record<Key, Promise<boolean>>>>({});
	const [ready, setReady] = useState(false);
	const [readFailed, setReadFailed] = useState(false);
	const [feedback, setFeedback] = useState<Partial<Record<Key, string>>>({});
	const report = useCallback((key: Key, message: string) => {
		setFeedback((current) => ({ ...current, [key]: message }));
	}, []);
	const refresh = useCallback(async () => {
		setReadFailed(false);
		setReady(false);
		saved.current = null;
		try {
			const response = await fetch("/api/execution-limits");
			if (!response.ok) throw new Error();
			const value: Limits = await response.json();
			if (
				!keys.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)
			)
				throw new Error();
			saved.current = value;
			draftRef.current = {
				modelCallLimit: String(value.modelCallLimit),
				subAgentLimit: String(value.subAgentLimit),
			};
			setDrafts(draftRef.current);
			setFeedback({});
			setReady(true);
		} catch {
			setReadFailed(true);
		}
	}, []);
	useEffect(() => {
		if (open) loading.current = refresh();
	}, [open, refresh]);
	const commit = useCallback(
		async (key: Key): Promise<boolean> => {
			if (pending.current[key] && !(await pending.current[key])) return false;
			if (!saved.current) return false;
			const draft = draftRef.current[key];
			const value = Number(draft);
			if (!draft.trim() || !Number.isSafeInteger(value) || value <= 0) {
				report(key, "invalidExecutionLimit");
				return false;
			}
			if (value === saved.current[key]) return true;
			// Another blur/Close may have resumed while waiting for the same write.
			if (pending.current[key]) return pending.current[key];
			report(key, "settingsSaving");
			const operation = (async () => {
				try {
					const response = await fetch("/api/execution-limits", {
						method: "PATCH",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ [key]: value }),
					});
					if (!response.ok) throw new Error();
					if (saved.current) saved.current[key] = value;
					report(key, draftRef.current[key] === draft ? "settingsSaved" : "");
					return true;
				} catch {
					report(key, "executionLimitsFailed");
					return false;
				} finally {
					delete pending.current[key];
				}
			})();
			pending.current[key] = operation;
			return operation;
		},
		[report],
	);
	useEffect(() => {
		commitRef.current = async () => {
			await loading.current;
			for (;;) {
				const results = await Promise.all(keys.map((key) => commit(key)));
				if (!results.every(Boolean)) return false;
				if (
					keys.every(
						(key) => Number(draftRef.current[key]) === saved.current?.[key],
					)
				)
					return true;
			}
		};
		return () => {
			commitRef.current = null;
		};
	}, [commit, commitRef]);
	return (
		<section aria-labelledby="execution-limits-title">
			<h3 id="execution-limits-title" className="font-semibold">
				{t("executionLimits")}
			</h3>
			<p className="mt-2 text-sm text-neutral-600">
				{t("executionLimitsHelp")}
			</p>
			{keys.map((key) => (
				<div key={key} className="mt-4">
					<label>
						<span>
							{t(
								key === "modelCallLimit"
									? "modelCallLimitSetting"
									: "subAgentLimitSetting",
							)}
						</span>
						<input
							className={control}
							type="number"
							min="1"
							step="1"
							required
							value={drafts[key]}
							disabled={!ready}
							aria-invalid={
								feedback[key] === "invalidExecutionLimit" ||
								feedback[key] === "executionLimitsFailed"
							}
							aria-describedby={`execution-${key}-help execution-${key}-feedback`}
							onChange={(event) => {
								draftRef.current = {
									...draftRef.current,
									[key]: event.target.value,
								};
								setDrafts(draftRef.current);
								report(key, "");
							}}
							onBlur={() => void commit(key)}
						/>
					</label>
					<p
						id={`execution-${key}-help`}
						className="mt-2 text-sm text-neutral-600"
					>
						{t(
							key === "modelCallLimit"
								? "modelCallLimitHelp"
								: "subAgentLimitHelp",
						)}
					</p>
					<p
						id={`execution-${key}-feedback`}
						role={
							feedback[key] === "invalidExecutionLimit" ||
							feedback[key] === "executionLimitsFailed"
								? "alert"
								: "status"
						}
						className={`mt-2 min-h-5 text-sm ${feedback[key] === "invalidExecutionLimit" || feedback[key] === "executionLimitsFailed" ? "text-red-700" : "text-neutral-600"}`}
					>
						{feedback[key] && t(feedback[key])}
					</p>
				</div>
			))}
			{readFailed && (
				<div role="alert" className="mt-2 text-red-700">
					{t("executionLimitsFailed")}{" "}
					<button
						type="button"
						onClick={() => {
							loading.current = refresh();
						}}
					>
						{t("retry")}
					</button>
				</div>
			)}
		</section>
	);
}
