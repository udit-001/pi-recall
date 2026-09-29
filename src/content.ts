/**
 * Text extraction from a message's content.
 *
 * Content is a string in some entries and a part list in others, and only the
 * text parts are worth reading; tool calls become a marker so a reader can see
 * that something happened without the arguments.
 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				parts.push(part.text);
			} else if (part.type === "toolCall" && part.name) {
				parts.push(`[Tool: ${part.name}]`);
			}
		}
		return parts.join("\n");
	}
	return "";
}
