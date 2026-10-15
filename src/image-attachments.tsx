import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { type InputImage, MAX_IMAGE_BYTES } from "./image-content.ts";
export type ImageInput = InputImage;
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function ImagePreviews({
	images,
	onRemove,
	onLoad,
}: {
	images: ImageInput[];
	onRemove?: (index: number) => void;
	onLoad?: () => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-wrap gap-2">
			{images.map((image, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: immutable image previews have no local state; duplicate attachments are allowed.
				<div key={index} className="relative">
					<img
						src={image.image_url}
						alt={t("attachedImage", { index: index + 1 })}
						onLoad={onLoad}
						className="max-h-48 max-w-64 rounded border border-neutral-200 object-contain"
					/>
					{onRemove && (
						<button
							type="button"
							className="absolute right-1 top-1 rounded bg-white px-2 py-1 text-sm shadow"
							aria-label={t("removeImage", { index: index + 1 })}
							onClick={() => onRemove(index)}
						>
							×
						</button>
					)}
				</div>
			))}
		</div>
	);
}

export function ImageAttachments({
	images,
	onChange,
	onReading,
	disabled,
	children,
}: {
	images: ImageInput[];
	onChange: (images: ImageInput[]) => void;
	onReading: (reading: boolean) => void;
	disabled: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const [error, setError] = useState(false);
	const [reading, setReading] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const current = useRef(images);
	current.current = images;
	async function add(files: File[]) {
		if (disabled || reading || !files.length) return;
		setError(false);
		setReading(true);
		onReading(true);
		try {
			if (current.current.length + files.length > 10)
				throw new Error("image count");
			const added = await Promise.all(
				files.map(async (file): Promise<ImageInput> => {
					if (
						file.size === 0 ||
						file.size > MAX_IMAGE_BYTES ||
						!imageTypes.includes(file.type)
					)
						throw new Error("image type");
					const image_url = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(file);
					});
					return { type: "input_image", image_url };
				}),
			);
			onChange([...current.current, ...added]);
		} catch {
			setError(true);
		} finally {
			setReading(false);
			onReading(false);
		}
	}
	return (
		<div
			onPaste={(event) => {
				const files = Array.from(event.clipboardData.files).filter((file) =>
					file.type.startsWith("image/"),
				);
				if (files.length) {
					event.preventDefault();
					void add(files);
				}
			}}
		>
			{children}
			<ImagePreviews
				images={images}
				onRemove={
					disabled || reading
						? undefined
						: (index) =>
								onChange(images.filter((_, position) => position !== index))
				}
			/>
			<input
				ref={input}
				type="file"
				multiple
				accept={imageTypes.join(",")}
				className="hidden"
				aria-label={t("attachImages")}
				disabled={disabled || reading}
				onChange={(event) => {
					void add(Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
			/>
			<button
				type="button"
				disabled={disabled || reading}
				className="mt-2 rounded border border-neutral-300 px-2 py-1 text-sm disabled:opacity-50"
				onClick={() => input.current?.click()}
			>
				{t(reading ? "loading" : "attachImages")}
			</button>
			{error && (
				<p role="alert" className="text-red-700">
					{t("imageAttachmentFailed")}
				</p>
			)}
		</div>
	);
}

export function toolImages(result: string | null | undefined): ImageInput[] {
	if (!result) return [];
	try {
		const value: unknown = JSON.parse(result);
		return Array.isArray(value)
			? value.filter(
					(part): part is ImageInput =>
						part?.type === "input_image" &&
						typeof part.image_url === "string" &&
						/^data:image\/(png|jpeg|gif|webp);base64,/.test(part.image_url),
				)
			: [];
	} catch {
		return [];
	}
}
