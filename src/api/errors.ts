import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorProvider = 'aisonggenerator' | 'lyrics' | 'worker';
export type ErrorOutcome = 'rejected' | 'unknown';
export type UnexpectedErrorCategory = 'timeout' | 'type_error' | 'syntax_error' | 'range_error' | 'runtime_error';

export type ProviderErrorCode =
	| 'invalid_request'
	| 'idempotency_conflict'
	| 'aisg_auth_error'
	| 'aisg_forbidden'
	| 'aisg_insufficient_credits'
	| 'aisg_policy_rejected'
	| 'aisg_rate_limited'
	| 'aisg_upstream_error'
	| 'aisg_dispatch_unknown'
	| 'aisg_task_not_found'
	| 'lyrics_unavailable'
	| 'internal_error';

export interface ProviderErrorPayload {
	error: string;
	provider: ErrorProvider;
	code: ProviderErrorCode;
	retryable: boolean;
	outcome: ErrorOutcome;
	upstream_status?: number;
	task_id?: string;
}

export interface ProviderErrorOptions {
	status: ContentfulStatusCode;
	provider: ErrorProvider;
	code: ProviderErrorCode;
	retryable: boolean;
	outcome: ErrorOutcome;
	upstreamStatus?: number;
	taskId?: string;
}

export class ProviderError extends Error {
	readonly status: ContentfulStatusCode;
	readonly provider: ErrorProvider;
	readonly code: ProviderErrorCode;
	readonly retryable: boolean;
	readonly outcome: ErrorOutcome;
	readonly upstreamStatus?: number;
	readonly taskId?: string;

	constructor(message: string, options: ProviderErrorOptions) {
		super(message);
		this.name = 'ProviderError';
		this.status = options.status;
		this.provider = options.provider;
		this.code = options.code;
		this.retryable = options.retryable;
		this.outcome = options.outcome;
		this.upstreamStatus = options.upstreamStatus;
		this.taskId = options.taskId;
	}

	toJSON(): ProviderErrorPayload {
		const payload: ProviderErrorPayload = {
			error: this.message,
			provider: this.provider,
			code: this.code,
			retryable: this.retryable,
			outcome: this.outcome,
		};
		if (this.upstreamStatus !== undefined) {
			payload.upstream_status = this.upstreamStatus;
		}
		if (this.taskId !== undefined) {
			payload.task_id = this.taskId;
		}
		return payload;
	}

	toResponse(): Response {
		return Response.json(this.toJSON(), { status: this.status });
	}
}

export function isTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return error.name === 'TimeoutError' || error.name === 'AbortError';
}

/**
 * Closed-set error category for unexpected exceptions so arbitrary/custom error.name
 * values from external bindings or runtimes can never leak into structured logs.
 */
export function classifyUnexpectedErrorCategory(error: unknown): UnexpectedErrorCategory {
	if (isTimeoutError(error)) {
		return 'timeout';
	}
	if (error instanceof TypeError) {
		return 'type_error';
	}
	if (error instanceof SyntaxError) {
		return 'syntax_error';
	}
	if (error instanceof RangeError) {
		return 'range_error';
	}
	return 'runtime_error';
}
