import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

export function getRequestDiagnostics(request: ChatCompletionCreateParamsNonStreaming, recordCount: number) {
	let contentParts = 0;
	let imageCount = 0;
	let textChars = 0;
	for (const message of request.messages) {
		if (typeof message.content === 'string') {
			contentParts++;
			textChars += message.content.length;
		} else if (Array.isArray(message.content)) {
			contentParts += message.content.length;
			for (const part of message.content) {
				if (part.type === 'image_url') imageCount++;
				if (part.type === 'text') textChars += part.text.length;
			}
		}
	}
	return {
		record_count: recordCount,
		content_parts: contentParts,
		image_count: imageCount,
		text_chars: textChars,
		request_bytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
		max_completion_tokens: request.max_completion_tokens,
		reasoning_effort: request.reasoning_effort,
	};
}

export type RequestDiagnostics = ReturnType<typeof getRequestDiagnostics>;
