// Legacy DiffRhythm (aisinging.ai) compatibility adapter retained during Step-2 expand rollout
// while deployed smol-workflow still falls back to and polls source=diffrhythm.
// Scheduled for removal in Step-6 contraction after workflow cutover, drain, and rollback window close.

import { ProviderError, isTimeoutError } from './errors';

const ORIGIN = 'https://aisinging.ai';
const API = `${ORIGIN}/api`;
const SESSION_URL = `${API}/auth/session`;
const ACCOUNT_URL = `${API}/user/info`;
const TASKS_URL = `${API}/app/tasks`;
const CLIENT_VERSION = 'v0.2.7';
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SESSION_COOKIE = '__Secure-next-auth.session-token';

const TEXT_TO_MUSIC = 'text-to-music';
const LYRICS_TO_MUSIC = 'lyrics-to-music';

export interface DiffRhythmGenerateParams {
	title: string;
	tags: string;
	isPublic?: boolean;
	instrumental: boolean;
	lyrics?: string;
	description?: string;
	userId?: string;
	fingerprint?: string;
}

export interface TransformedSong {
	music_id: string;
	status: number;
	audio: string | null;
	service: 'diffrhythm';
}

interface TaskOutput {
	status?: number;
	url?: string | null;
	index?: number;
}

interface TaskItem {
	_id?: string;
	id?: string;
	status?: number;
	outputs?: TaskOutput[];
}

interface TaskListResponse {
	status?: number;
	error?: string;
	data?: {
		items?: TaskItem[];
		taskId?: string;
	};
}

export function normalizeDiffrhythmCookie(value: string | undefined): string {
	const trimmed = value?.trim() || '';
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
		return trimmed;
	}
	return `${SESSION_COOKIE}=${trimmed}`;
}

function cookieHeaders(cookie: string, json = false): Headers {
	const headers = new Headers({
		Accept: 'application/json',
		Cookie: cookie,
		Origin: ORIGIN,
		Referer: `${ORIGIN}/text-to-song`,
		'User-Agent': USER_AGENT,
		'x-client-version': CLIENT_VERSION,
	});
	if (json) {
		headers.set('Content-Type', 'application/json');
	}
	return headers;
}

async function diffrhythmFetch(url: string, cookie: string, init: RequestInit = {}): Promise<Response> {
	const headers = cookieHeaders(cookie, init.body != null);
	const extra = new Headers(init.headers);
	extra.forEach((value, key) => headers.set(key, value));
	const options = { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10000) };
	const response = await fetch(url, options);
	if (response.status !== 426) {
		return response;
	}
	const nextVersion = response.headers.get('x-app-version');
	if (!nextVersion || nextVersion === CLIENT_VERSION) {
		return response;
	}
	await response.body?.cancel();
	headers.set('x-client-version', nextVersion);
	return fetch(url, options);
}

function sessionCookieFromResponse(response: Response): string {
	const rows =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: [response.headers.get('Set-Cookie') || ''];
	for (const row of rows) {
		const match = row.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
		if (match?.[1]) {
			return `${SESSION_COOKIE}=${match[1]}`;
		}
	}
	return '';
}

async function readJsonSafe<T>(response: Response): Promise<{ ok: true; value: T | null } | { ok: false }> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { ok: false };
	}
	if (!text) {
		return { ok: true, value: null };
	}
	try {
		return { ok: true, value: JSON.parse(text) as T };
	} catch {
		return { ok: false };
	}
}

export async function refreshDiffrhythmCookie(candidates: string[]): Promise<string> {
	const seen = new Set<string>();
	let lastStatus: number | undefined;
	let reason = 'DiffRhythm session cookie is missing';

	for (const candidate of candidates) {
		const cookie = normalizeDiffrhythmCookie(candidate);
		if (!cookie || seen.has(cookie)) {
			continue;
		}
		seen.add(cookie);

		let response: Response;
		try {
			response = await diffrhythmFetch(SESSION_URL, cookie);
		} catch (error) {
			reason = 'DiffRhythm session check failed (network or timeout)';
			lastStatus = isTimeoutError(error) ? 504 : 502;
			continue;
		}

		const parsed = await readJsonSafe<{ user?: { id?: string } }>(response);
		if (!response.ok || !parsed.ok || !parsed.value?.user?.id) {
			reason = `DiffRhythm session has no user (HTTP ${response.status})`;
			lastStatus = response.status;
			continue;
		}

		let account: Response;
		try {
			account = await diffrhythmFetch(ACCOUNT_URL, cookie);
		} catch (error) {
			reason = 'DiffRhythm account check failed (network or timeout)';
			lastStatus = isTimeoutError(error) ? 504 : 502;
			continue;
		}

		const accountParsed = await readJsonSafe<{ data?: { credits?: number } }>(account);
		if (account.ok && accountParsed.ok && accountParsed.value?.data && 'credits' in accountParsed.value.data) {
			return sessionCookieFromResponse(response) || cookie;
		}
		reason = `DiffRhythm account check failed (HTTP ${account.status})`;
		lastStatus = account.status;
	}

	throw new ProviderError(reason, {
		status: lastStatus === 401 || lastStatus === 403 ? 401 : 502,
		provider: 'worker',
		code: lastStatus === 401 || lastStatus === 403 ? 'aisg_auth_error' : 'aisg_upstream_error',
		retryable: lastStatus !== 401 && lastStatus !== 403,
		outcome: 'rejected',
		upstreamStatus: lastStatus,
	});
}

function taskBody(params: DiffRhythmGenerateParams): { featureKey: string; input: Record<string, unknown> } {
	const isPublic = params.isPublic === undefined ? false : params.isPublic;
	if (params.instrumental) {
		return {
			featureKey: TEXT_TO_MUSIC,
			input: {
				description: params.description || params.lyrics || '',
				instrumental: true,
				isPublic,
			},
		};
	}
	return {
		featureKey: LYRICS_TO_MUSIC,
		input: {
			lyrics: params.lyrics || '',
			styleOfMusic: params.tags || '',
			title: params.title || '',
			instrumental: false,
			isPublic,
		},
	};
}

async function createTask(cookie: string, params: DiffRhythmGenerateParams): Promise<string> {
	let response: Response;
	try {
		response = await diffrhythmFetch(TASKS_URL, cookie, {
			method: 'POST',
			body: JSON.stringify(taskBody(params)),
		});
	} catch (error) {
		throw new ProviderError('DiffRhythm song submission outcome unknown after dispatch', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'worker',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
		});
	}

	const parsed = await readJsonSafe<TaskListResponse>(response);

	if (response.ok) {
		if (!parsed.ok || parsed.value === null) {
			throw new ProviderError('DiffRhythm song submission response lost after dispatch', {
				status: 502,
				provider: 'worker',
				code: 'aisg_dispatch_unknown',
				retryable: false,
				outcome: 'unknown',
				upstreamStatus: response.status,
			});
		}
		const taskId = typeof parsed.value.data?.taskId === 'string' ? parsed.value.data.taskId.trim() : '';
		if (taskId) {
			return taskId;
		}
		if (typeof parsed.value.error === 'string' && parsed.value.error.trim()) {
			throw new ProviderError(`DiffRhythm song submission failed (HTTP ${response.status})`, {
				status: 502,
				provider: 'worker',
				code: 'aisg_upstream_error',
				retryable: true,
				outcome: 'rejected',
				upstreamStatus: response.status,
			});
		}
		throw new ProviderError('DiffRhythm song submission returned unreadable acceptance response', {
			status: 502,
			provider: 'worker',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
			upstreamStatus: response.status,
		});
	}

	const isExplicit4xx = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 499;
	const hasExplicitOriginRejection =
		isExplicit4xx ||
		((response.status === 500 || response.status === 503) &&
			parsed.ok &&
			typeof parsed.value?.error === 'string' &&
			parsed.value.error.trim().length > 0);

	if (!hasExplicitOriginRejection) {
		throw new ProviderError(`DiffRhythm song submission outcome unknown after dispatch (HTTP ${response.status})`, {
			status: response.status === 504 ? 504 : response.status === 503 ? 503 : 502,
			provider: 'worker',
			code: 'aisg_dispatch_unknown',
			retryable: false,
			outcome: 'unknown',
			upstreamStatus: response.status,
		});
	}

	const isAuth = response.status === 401 || response.status === 403;
	throw new ProviderError(`DiffRhythm song submission failed (HTTP ${response.status})`, {
		status: isAuth ? 401 : response.status === 429 ? 429 : response.status === 503 ? 503 : 502,
		provider: 'worker',
		code: isAuth ? 'aisg_auth_error' : response.status === 429 ? 'aisg_rate_limited' : 'aisg_upstream_error',
		retryable: response.status === 429 || response.status >= 500,
		outcome: 'rejected',
		upstreamStatus: response.status,
	});
}

export async function generateDiffRhythmSong(params: DiffRhythmGenerateParams, env: Env): Promise<string[]> {
	const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
	const stub = env.DURABLE_OBJECT.get(doid);
	const sessionToken = await stub.getDiffrhythmSession(true);
	if (typeof sessionToken !== 'string' || !sessionToken) {
		throw new ProviderError('DiffRhythm session is missing', {
			status: 401,
			provider: 'worker',
			code: 'aisg_auth_error',
			retryable: false,
			outcome: 'rejected',
		});
	}

	// smol.xyz stores two song ids for every generation.
	const first = await createTask(sessionToken, params);
	const second = await createTask(sessionToken, params);
	return [first, second];
}

function mapTask(id: string, task: TaskItem | undefined): TransformedSong {
	if (!task) {
		return { music_id: id, status: 0, audio: null, service: 'diffrhythm' };
	}
	const outputs = Array.isArray(task.outputs) ? task.outputs : [];
	const withAudio = outputs.find((output) => output?.url);
	if (withAudio?.url) {
		return { music_id: id, status: 4, audio: withAudio.url, service: 'diffrhythm' };
	}
	const failed = task.status === 2 || outputs.some((output) => output?.status === 2);
	if (failed) {
		return { music_id: id, status: -1, audio: null, service: 'diffrhythm' };
	}
	return { music_id: id, status: 0, audio: null, service: 'diffrhythm' };
}

async function listTasks(cookie: string, featureKey: string): Promise<TaskItem[]> {
	const url = `${TASKS_URL}?${new URLSearchParams({
		featureKey,
		page: '1',
		limit: '20',
		includeTotal: 'false',
	})}`;
	let response: Response;
	try {
		response = await diffrhythmFetch(url, cookie);
	} catch (error) {
		throw new ProviderError('DiffRhythm song list request failed (network or timeout)', {
			status: isTimeoutError(error) ? 504 : 502,
			provider: 'worker',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
		});
	}

	if (!response.ok) {
		const isAuth = response.status === 401 || response.status === 403;
		throw new ProviderError(`DiffRhythm song list request failed (HTTP ${response.status})`, {
			status: isAuth ? 401 : response.status === 503 ? 503 : 502,
			provider: 'worker',
			code: isAuth ? 'aisg_auth_error' : 'aisg_upstream_error',
			retryable: !isAuth,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}

	const parsed = await readJsonSafe<TaskListResponse>(response);
	if (!parsed.ok || !parsed.value?.data) {
		throw new ProviderError('DiffRhythm song list returned unreadable payload', {
			status: 502,
			provider: 'worker',
			code: 'aisg_upstream_error',
			retryable: true,
			outcome: 'rejected',
			upstreamStatus: response.status,
		});
	}
	return Array.isArray(parsed.value.data.items) ? parsed.value.data.items : [];
}

export async function getDiffRhythmSongResults(uids: string[], env: Env): Promise<TransformedSong[]> {
	if (!uids || uids.length === 0) {
		return [];
	}

	const doid = env.DURABLE_OBJECT.idFromName('v0.0.0');
	const stub = env.DURABLE_OBJECT.get(doid);
	const sessionToken = await stub.getDiffrhythmSession(true);
	if (typeof sessionToken !== 'string' || !sessionToken) {
		throw new ProviderError('DiffRhythm session is missing', {
			status: 401,
			provider: 'worker',
			code: 'aisg_auth_error',
			retryable: false,
			outcome: 'rejected',
		});
	}

	const lists = await Promise.all([
		listTasks(sessionToken, TEXT_TO_MUSIC),
		listTasks(sessionToken, LYRICS_TO_MUSIC),
	]);
	const byId = new Map<string, TaskItem>();
	for (const task of lists.flat()) {
		const id = task._id || task.id;
		if (id) {
			byId.set(id, task);
		}
	}

	return uids.map((uid) => mapTask(uid, byId.get(uid)));
}
