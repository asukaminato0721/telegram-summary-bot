import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

// Preserve image positions and separate text fields with newlines.
export function compactContent(parts: ChatCompletionContentPart[]): string | ChatCompletionContentPart[] {
	const result: ChatCompletionContentPart[] = [];
	let text: string[] = [];
	const flushText = () => {
		if (text.length) result.push({ type: 'text', text: text.join('\n') });
		text = [];
	};
	for (const part of parts) {
		if (part.type === 'text') {
			text.push(part.text);
		} else {
			flushText();
			result.push(part);
		}
	}
	flushText();
	if (result.length === 0) return '';
	if (result.length === 1 && result[0].type === 'text') return result[0].text;
	return result;
}
