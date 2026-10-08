import OpenAI from 'openai';
import type { RequestDiagnostics } from './requestDiagnostics';

function getErrorName(error: unknown): string {
	if (!(error instanceof Error)) return 'UnknownError';
	return error.name === 'Error' ? error.constructor.name : error.name;
}

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

export function formatSummaryError(
	error: unknown,
	context: { model: string; stage: string; request?: RequestDiagnostics },
	secrets: string[],
): string {
	const lines = [
		'概括失败。',
		`失败阶段：${context.stage}`,
		`模型：${context.model}`,
		`错误类型：${getErrorName(error)}`,
	];
	let reason = error instanceof Error ? error.message : typeof error === 'string' ? error : '未知错误，请查看服务日志。';
	if (error instanceof OpenAI.APIError) {
		if (error.status != null) lines.push(`HTTP 状态码：${error.status}`);
		if (error.code) lines.push(`错误代码：${error.code}`);
		if (error.type) lines.push(`服务错误类型：${error.type}`);
		if (error.param) lines.push(`相关参数：${error.param}`);
		if (error.requestID) lines.push(`请求 ID：${error.requestID}`);
		const retryAfter = error.headers?.get('retry-after');
		if (retryAfter) lines.push(`服务建议的重试时间（Retry-After）：${retryAfter}`);
		// The SDK can put the entire response body in error.message.
		// Select the provider's text message instead of publishing that body.
		if (error.error != null) {
			const message = (error.error as Record<string, unknown>).message;
			reason = typeof message === 'string' ? message : '服务未提供文本错误说明，请查看服务日志。';
		}
	}
	if (context.request) {
		const request = context.request;
		lines.push(
			`群消息数：${request.record_count}，图片数：${request.image_count}`,
			`内容片段数：${request.content_parts}，文本长度（UTF-16）：${request.text_chars}`,
			`请求大小：${request.request_bytes} 字节`,
		);
		if (request.max_completion_tokens != null) lines.push(`max_completion_tokens：${request.max_completion_tokens}`);
		if (request.reasoning_effort != null) lines.push(`reasoning_effort：${request.reasoning_effort}`);
	}
	lines.push(`错误原因：${reason || '未提供错误说明。'}`);
	if (error instanceof OpenAI.APIError && error.status === 400 && /^invalid request\.?$/i.test(reason.trim())) {
		lines.push('服务未说明具体原因。请用较少的消息测试，或将请求 ID 提供给 API 服务商查询。');
	}
	if (error instanceof Error && 'cause' in error && error.cause instanceof Error) {
		lines.push(`底层原因：${error.cause.message}`);
	}
	// Redact before truncation so a truncated credential cannot become visible.
	// Return plain text within Telegram's message limit. Escape it before adding markup.
	return sanitize(lines.join('\n'), secrets) as string;
}

export function logModelError(
	error: unknown,
	context: { command: string; model: string; stage?: string; request?: RequestDiagnostics },
	secrets: string[],
) {
	// Serialize explicitly: Workers may render an Error as only its stack.
	// Include provider diagnostics and selected headers, but never the request payload.
	const details = {
		message: 'AI request failed',
		...context,
		error_name: getErrorName(error),
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
