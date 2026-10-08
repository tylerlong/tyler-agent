import type { ManagedModel } from "./model-settings.ts";

export function supportedReasoningEfforts(
	model: ManagedModel,
): string[] | undefined {
	const efforts =
		model.supportedEfforts === null
			? ["none", "minimal", "low", "medium", "high", "xhigh"]
			: model.supportedEfforts;
	return efforts?.filter(
		(effort) => !model.reasoningRequired || effort !== "none",
	);
}
