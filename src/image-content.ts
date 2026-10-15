export type InputImage = {
	type: "input_image";
	image_url: string;
	detail?: "auto" | "low" | "high";
};
export type InputContent = { type: "input_text"; text: string } | InputImage;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function imageMime(bytes: Uint8Array): string {
	const matches = (signature: number[], offset = 0) =>
		signature.every((byte, index) => bytes[offset + index] === byte);
	if (matches([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
	if (matches([255, 216, 255])) return "image/jpeg";
	if (
		matches([71, 73, 70, 56]) &&
		[55, 57].includes(bytes[4]) &&
		bytes[5] === 97
	)
		return "image/gif";
	if (matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8))
		return "image/webp";
	throw new Error("Expected a PNG, JPEG, GIF or WebP image");
}
export function imageFromBytes(bytes: Uint8Array): InputImage {
	if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
		throw new Error("Image must be between 1 byte and 10 MiB");
	return {
		type: "input_image",
		image_url: `data:${imageMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`,
	};
}
export function submittedImages(value: unknown): InputImage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 10)
		throw new Error("Expected at most 10 images");
	return value.map((image) => {
		if (
			!image ||
			typeof image !== "object" ||
			image.type !== "input_image" ||
			Object.keys(image).some(
				(key) => !["type", "image_url", "detail"].includes(key),
			) ||
			typeof image.image_url !== "string" ||
			(image.detail !== undefined &&
				!["auto", "low", "high"].includes(image.detail))
		)
			throw new Error("Invalid image input");
		const match =
			/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
				image.image_url,
			);
		if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
			throw new Error("Invalid image data");
		const bytes = Buffer.from(match[2], "base64");
		const saved = imageFromBytes(bytes);
		if (bytes.toString("base64") !== match[2] || imageMime(bytes) !== match[1])
			throw new Error("Invalid image data");
		return {
			...saved,
			...(image.detail === undefined ? {} : { detail: image.detail }),
		};
	});
}
export const userContent = (
	text: string,
	images: InputImage[] = [],
): string | InputContent[] =>
	images.length ? [{ type: "input_text", text }, ...images] : text;
// Encoded pixels are opaque data; textual credential replacement would corrupt them.
export const redactImageSafe = (
	text: string,
	redact: (text: string) => string,
): string => {
	// Mask JSON string values, preserving structural keys, booleans and pixels.
	if (/^\s*[[{]/.test(text)) {
		try {
			JSON.parse(text);
			return text.replace(/"(?:\\.|[^"\\])*"/g, (token, offset: number) => {
				if (/^\s*:/.test(text.slice(offset + token.length))) return token;
				const value: string = JSON.parse(token);
				if (/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value))
					return token;
				return JSON.stringify(redactImageSafe(value, redact));
			});
		} catch {
			/* Partial JSON and plain tool text use the streaming-safe path below. */
		}
	}
	return text
		.split(
			/((?<="image_url":")data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*)/g,
		)
		.map((part, index) => (index % 2 ? part : redact(part)))
		.join("");
};
