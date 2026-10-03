import { useTranslation } from "react-i18next";
import type { ManagedModel } from "./database.ts";
import { supportedReasoningEfforts } from "./model-options.ts";

export type TurnOptions = {
	modelId: string | null;
	reasoningEffort: string | null;
};
function reasoningEfforts(model: ManagedModel | undefined) {
	return model ? (supportedReasoningEfforts(model) ?? []) : [];
}
export function validTurnOptions(options: TurnOptions, models: ManagedModel[]) {
	const model = models.find((model) => model.id === options.modelId);
	return (
		!!model &&
		(options.reasoningEffort === null ||
			reasoningEfforts(model).includes(options.reasoningEffort))
	);
}
export function TurnOptionPicker({
	options,
	models,
	change,
	disabled = false,
}: {
	options: TurnOptions;
	models: ManagedModel[];
	change: (options: TurnOptions) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation();
	const model = models.find((model) => model.id === options.modelId);
	const efforts = reasoningEfforts(model);
	const invalid =
		options.reasoningEffort !== null &&
		!efforts.includes(options.reasoningEffort);
	const control =
		"min-w-0 max-w-full rounded-md bg-transparent px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-blue-600";
	return (
		<>
			<select
				aria-label={t("model")}
				className={control}
				value={options.modelId ?? ""}
				disabled={disabled || models.length === 0}
				onChange={(event) => {
					const modelId = event.target.value || null;
					const compatible = reasoningEfforts(
						models.find((item) => item.id === modelId),
					);
					change({
						modelId,
						reasoningEffort:
							options.reasoningEffort !== null &&
							compatible.includes(options.reasoningEffort)
								? options.reasoningEffort
								: null,
					});
				}}
			>
				<option value="">
					{t(models.length === 0 ? "noConfiguredModels" : "chooseModel")}
				</option>
				{models.map((model) => (
					<option key={model.id} value={model.id}>
						{model.name}
					</option>
				))}
			</select>
			{(efforts.length > 0 || invalid) && (
				<label className="flex min-w-0 max-w-full items-center gap-1">
					<span>{t("reasoningLabel")}</span>
					<select
						aria-label={t("reasoningLevel")}
						aria-invalid={invalid}
						className={control}
						value={options.reasoningEffort ?? ""}
						disabled={disabled}
						onChange={(event) =>
							change({
								...options,
								reasoningEffort: event.target.value || null,
							})
						}
					>
						<option value="">{t("reasoningDefault")}</option>
						{invalid && (
							<option value={options.reasoningEffort ?? ""} disabled>
								{t("unsupportedReasoning", { effort: options.reasoningEffort })}
							</option>
						)}
						{efforts.map((effort) => (
							<option key={effort} value={effort}>
								{effort}
							</option>
						))}
					</select>
				</label>
			)}
		</>
	);
}
