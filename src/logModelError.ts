import OpenAI from 'openai';

export function logModelError(
	error: unknown,
	context: { command: string; model: string },
	secrets: string[],
) {
	// Serialize explicitly: Workers may render an Error as only its stack.
	// Select diagnostic fields instead of logging headers or request payloads.
	const details = {
		message: 'AI request failed',
		...context,
		error_name: error instanceof Error ? error.name : 'UnknownError',
		error_message: error instanceof Error ? error.message : String(error),
		...(error instanceof OpenAI.APIError ? {
			status: error.status,
			code: error.code,
			type: error.type,
			param: error.param,
			request_id: error.requestID,
		} : {}),
	};
	let serialized = JSON.stringify(details);
	// Providers can echo credentials in their error messages.
	for (const secret of secrets.filter(Boolean)) {
		const escapedSecret = JSON.stringify(secret).slice(1, -1);
		serialized = serialized.split(escapedSecret).join('[REDACTED]');
	}
	console.error(serialized);
}
