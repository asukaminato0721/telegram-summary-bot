import OpenAI from 'openai';

// Providers sometimes include credentials or echoed request bodies in errors.
function sanitize(value: unknown, secrets: string[], depth = 0, budget = { left: 6000 }): unknown {
	if (budget.left <= 0) return '[TRUNCATED]';
	if (typeof value === 'string') {
		for (const secret of secrets.filter(Boolean)) value = (value as string).split(secret).join('[REDACTED]');
		const text = (value as string).replace(/data:image\/[^\s"']+/gi, '[IMAGE REDACTED]');
		const limit = Math.min(2000, budget.left);
		budget.left -= Math.min(text.length, limit);
		return text.length > limit ? text.slice(0, limit) + '[TRUNCATED]' : text;
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value !== 'object') return undefined;
	if (depth >= 5) return '[TRUNCATED]';
	if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, secrets, depth + 1, budget));
	return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
		key,
		/^(messages|content|text|prompt|input|request|request_body|body|headers|authorization|api[_-]?key|token|secret|image_url)$/i.test(key)
			? '[REDACTED]'
			: sanitize(item, secrets, depth + 1, budget),
	]));
}

export function logModelError(
	error: unknown,
	context: { command: string; model: string },
	secrets: string[],
) {
	// Serialize explicitly: Workers may render an Error as only its stack.
	// Include provider diagnostics and selected headers, but never the request payload.
	const details = {
		message: 'AI request failed',
		...context,
		error_name: error instanceof Error ? error.name : 'UnknownError',
		error_stack: error instanceof Error ? sanitize(error.stack, secrets) : undefined,
		error_message: error instanceof Error ? error.message : String(error),
		...(error instanceof Error && 'cause' in error ? {
			cause: sanitize(error.cause instanceof Error ? {
				name: error.cause.name,
				message: error.cause.message,
				code: 'code' in error.cause ? error.cause.code : undefined,
			} : error.cause, secrets),
		} : {}),
		...(error instanceof OpenAI.APIError ? {
			status: error.status,
			code: error.code,
			type: error.type,
			param: error.param,
			request_id: error.requestID,
			upstream_error: sanitize(error.error, secrets),
			response_headers: Object.fromEntries([
				'x-request-id', 'cf-ray', 'retry-after', 'openai-processing-ms',
				'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests',
				'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens',
				'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens',
			].flatMap(name => {
				const value = error.headers?.get(name);
				return value ? [[name, value]] : [];
			})),
		} : {}),
	};
	details.error_message = sanitize(details.error_message, secrets) as string;
	let serialized = JSON.stringify(details);
	// Providers can echo credentials in their error messages.
	for (const secret of secrets.filter(Boolean)) {
		const escapedSecret = JSON.stringify(secret).slice(1, -1);
		serialized = serialized.split(escapedSecret).join('[REDACTED]');
	}
	console.error(serialized);
}
