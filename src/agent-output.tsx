import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type ReaderItem = {
	id: string;
	callId: number;
	index: number;
	type: string;
	content: { index: number; type: string; text?: string }[];
};
// Page-local downloads and explicit choices survive switching chats until refresh.
const downloads = new Map<
	string,
	{ output: ReaderItem[]; status: string; stamp: string }
>();
const folds = new Map<string, boolean>();

export function AgentOutput({
	agentId,
	callId,
	status,
	output,
	revision,
	onLayoutChange,
}: {
	agentId: number;
	callId: number;
	status: string;
	output: ReaderItem[];
	revision: number;
	onLayoutChange: () => void;
}) {
	const { t } = useTranslation();
	useLayoutEffect(onLayoutChange);
	const cacheKey = `${agentId}-${callId}`;
	const [download, setDownload] = useState(() => downloads.get(cacheKey));
	const [choices, setChoices] = useState(() => new Map(folds));
	const [error, setError] = useState(false);
	const [retry, setRetry] = useState(0);
	const reasoning = output.filter(
		(item) => item.type === "reasoning" && item.content.length > 0,
	);
	const expanded = reasoning.some(
		(item) =>
			choices.get(`${agentId}-${callId}-${item.index}`) ?? status === "pending",
	);
	useEffect(() => {
		const cached = downloads.get(cacheKey);
		if (!reasoning.length || (!expanded && !cached)) return;
		const stamp = `${revision}-${retry}`;
		if (
			cached &&
			cached.status === status &&
			(cached.status !== "pending" || cached.stamp === stamp)
		)
			return;
		let current = true;
		void fetch(`/api/agents/${agentId}/reasoning?callId=${callId}`)
			.then(async (response) => {
				if (!response.ok) throw new Error("Read failed");
				const data = await response.json();
				if (!current) return;
				const next = { output: data.output as ReaderItem[], status, stamp };
				downloads.set(cacheKey, next);
				setDownload(next);
				setError(false);
			})
			.catch(() => {
				if (current) setError(true);
			});
		return () => {
			current = false;
		};
	}, [
		agentId,
		callId,
		cacheKey,
		status,
		revision,
		expanded,
		reasoning.length,
		retry,
	]);
	return output.map((item) => {
		if (item.type === "message") {
			if (
				!item.content.some(
					(part) =>
						(part.type === "output_text" || part.type === "refusal") &&
						part.text,
				)
			)
				return null;
			return (
				<div
					key={item.index}
					data-output-index={item.index}
					data-reading-anchor={`${agentId}-${callId}-output-${item.index}`}
				>
					{item.content
						.filter(
							(part) => part.type === "output_text" || part.type === "refusal",
						)
						.map((part) => (
							<div
								key={`${part.index}-${part.type}`}
								data-reading-anchor={`${agentId}-${callId}-output-${item.index}-${part.type}-${part.index}`}
							>
								{part.text}
							</div>
						))}
				</div>
			);
		}
		if (item.type !== "reasoning" || !item.content.length) return null;
		const key = `${agentId}-${callId}-${item.index}`;
		const open = choices.get(key) ?? status === "pending";
		const content = download?.output.find(
			(value) => value.index === item.index,
		)?.content;
		return (
			<div
				key={item.index}
				data-output-index={item.index}
				data-reading-anchor={`${agentId}-${callId}-output-${item.index}`}
				className="my-2 rounded border border-neutral-200 p-3"
			>
				<button
					type="button"
					aria-expanded={open}
					className="cursor-pointer font-medium"
					onClick={() => {
						folds.set(key, !open);
						setChoices(new Map(folds));
					}}
				>
					{open ? "▾ " : "▸ "}
					{t("thinking")}
				</button>
				{open && (
					<div className="mt-2 space-y-2 text-neutral-600">
						{content?.map((part) => (
							<div
								key={`${part.index}-${part.type}`}
								data-reading-anchor={`${agentId}-${callId}-output-${item.index}-${part.type}-${part.index}`}
							>
								<strong>
									{t(
										part.type === "summary_text"
											? "thinkingSummary"
											: "thinkingBody",
									)}
									{t("labelSeparator")}
								</strong>
								{part.text}
							</div>
						))}
						{!content && !error && <p role="status">{t("loading")}</p>}
						{error && (
							<p role="status">
								{t("reasoningReadFailed")}{" "}
								<button
									type="button"
									className="underline"
									onClick={() => setRetry((value) => value + 1)}
								>
									{t("retry")}
								</button>
							</p>
						)}
					</div>
				)}
			</div>
		);
	});
}
