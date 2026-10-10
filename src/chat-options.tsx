import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { supportedReasoningEfforts } from "./model-options.ts";
import type { ManagedModel } from "./model-settings.ts";

export type ChatOptions = {
	modelId: string | null;
	reasoningEffort: string | null;
	fileAccess: "restricted" | "full";
	networkAccess: "restricted" | "full";
};
function reasoningEfforts(model: ManagedModel | undefined) {
	return model ? (supportedReasoningEfforts(model) ?? []) : [];
}
export function normalizeChatOptions(
	options: ChatOptions,
	models: ManagedModel[],
): ChatOptions {
	const model = models.find((model) => model.id === options.modelId);
	if (!model)
		return options.modelId === null && options.reasoningEffort === null
			? options
			: { ...options, modelId: null, reasoningEffort: null };
	return options.reasoningEffort === null ||
		reasoningEfforts(model).includes(options.reasoningEffort)
		? options
		: { ...options, reasoningEffort: null };
}
export function validChatOptions(options: ChatOptions, models: ManagedModel[]) {
	return (
		options.modelId !== null &&
		normalizeChatOptions(options, models) === options
	);
}
export function ChatOptionPicker({
	options,
	models,
	change,
	disabled = false,
	saving = false,
}: {
	options: ChatOptions;
	models: ManagedModel[];
	change: (options: ChatOptions) => void;
	disabled?: boolean;
	saving?: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({
		left: 0,
		top: 0,
		width: 320,
		maxHeight: 400,
	});
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const id = useId();
	const model = models.find((model) => model.id === options.modelId);
	const efforts = reasoningEfforts(model);
	const effortLabel = (value: string) =>
		t(`reasoningEffort_${value}`, { defaultValue: value });
	const summary = model
		? `${model.name}${efforts.length ? ` · ${options.reasoningEffort ? effortLabel(options.reasoningEffort) : t("reasoningDefault")}` : ""}`
		: t("chooseModel");
	function close(returnFocus: boolean) {
		setOpen(false);
		if (returnFocus) trigger.current?.focus();
	}
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			const bounds = trigger.current?.getBoundingClientRect();
			if (!bounds) return;
			const width = Math.min(420, window.innerWidth - 24);
			const above = bounds.top - 12;
			const below = window.innerHeight - bounds.bottom - 12;
			const maxHeight = Math.min(440, Math.max(above, below) - 8);
			const height = Math.min(popup.current?.scrollHeight ?? 440, maxHeight);
			setPosition({
				width,
				maxHeight,
				left: Math.max(
					12,
					Math.min(bounds.left, window.innerWidth - width - 12),
				),
				top: below >= height ? bounds.bottom + 8 : bounds.top - height - 8,
			});
		}
		place();
		const observer = new ResizeObserver(place);
		if (popup.current) observer.observe(popup.current);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);
	useEffect(() => {
		if (!open) return;
		(
			popup.current?.querySelector<HTMLInputElement>("input:checked") ??
			popup.current?.querySelector<HTMLInputElement>('input[type="radio"]')
		)?.focus();
		function outside(event: PointerEvent) {
			if (
				event.target instanceof Node &&
				!popup.current?.contains(event.target) &&
				!trigger.current?.contains(event.target)
			)
				setOpen(false);
		}
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);
	function group(
		label: string,
		values: { value: string | null; label: string }[],
		selected: string | null,
		select: (value: string | null) => void,
		layout: "plain" | "scroll" | "inline" = "plain",
	) {
		return (
			<div
				role="radiogroup"
				aria-label={label}
				className={
					layout === "scroll"
						? "min-h-24 overflow-y-auto"
						: layout === "inline"
							? "flex shrink-0 gap-2"
							: "shrink-0"
				}
			>
				{values.map((item) => (
					<label
						key={item.value ?? "default"}
						className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm hover:bg-gray-100 has-focus-visible:outline-2 has-focus-visible:outline-blue-600"
					>
						<input
							type="radio"
							disabled={saving}
							name={`${id}-${label}`}
							checked={selected === item.value}
							onChange={() => select(item.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									select(item.value);
								}
							}}
							className="shrink-0 accent-blue-600"
						/>
						<span className="min-w-0 break-words">{item.label}</span>
					</label>
				))}
			</div>
		);
	}
	return (
		<>
			<button
				ref={trigger}
				type="button"
				title={summary}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				disabled={disabled}
				className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-blue-600"
				onClick={() => (open ? close(true) : setOpen(true))}
			>
				<span className="truncate">{summary}</span>
				<svg
					aria-hidden="true"
					className="h-4 w-4 shrink-0"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="m4 6 4 4 4-4" />
				</svg>
			</button>
			{open &&
				createPortal(
					<div
						ref={popup}
						id={id}
						role="dialog"
						aria-label={t("model")}
						style={position}
						className="picker-popup fixed z-50 flex flex-col overflow-y-auto p-2"
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								close(true);
							}
						}}
					>
						<div className="shrink-0 px-3 py-1 text-sm font-semibold">
							{t("model")}
						</div>
						{group(
							t("model"),
							models.map((item) => ({ value: item.id, label: item.name })),
							options.modelId,
							(modelId) =>
								change(
									normalizeChatOptions(
										{
											...options,
											modelId,
											reasoningEffort: options.reasoningEffort,
										},
										models,
									),
								),
							"scroll",
						)}
						{efforts.length > 0 && (
							<>
								<div className="mt-2 shrink-0 border-t border-gray-200 px-3 pt-2 text-sm font-semibold">
									{t("reasoningLabel")}
								</div>
								{group(
									t("reasoningLevel"),
									[
										{ value: null, label: t("reasoningDefault") },
										...efforts.map((value) => ({
											value,
											label: effortLabel(value),
										})),
									],
									options.reasoningEffort,
									(reasoningEffort) => change({ ...options, reasoningEffort }),
								)}
							</>
						)}
						{(["fileAccess", "networkAccess"] as const).map((key) => (
							<div
								key={key}
								className="mt-2 shrink-0 border-t border-gray-200 pt-2"
							>
								<div className="px-3 text-sm font-semibold">{t(key)}</div>
								{group(
									t(key),
									[
										{ value: "restricted", label: t("accessRestricted") },
										{ value: "full", label: t("accessFull") },
									],
									options[key],
									(value) => change({ ...options, [key]: value }),
									"inline",
								)}
							</div>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
