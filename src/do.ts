import { DurableObject } from 'cloudflare:workers';
import { aisgAuthHeaders } from './api/aisonggenerator';
import { normalizeDiffrhythmCookie, refreshDiffrhythmCookie } from './api/diffrhythm';

export class DO extends DurableObject<Env> {
    private diffrhythmRefresh?: Promise<string>;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async getDiffrhythmSession(refresh = false) {
        if (refresh) {
            this.diffrhythmRefresh ??= this.refreshDiffrhythmSession().finally(() => {
                this.diffrhythmRefresh = undefined;
            });
            return this.diffrhythmRefresh;
        }

        const stored = await this.ctx.storage.get<string>('session_token');
        return stored || normalizeDiffrhythmCookie(this.env.DIFFRHYTHM_SESSION_COOKIE);
    }

    private async refreshDiffrhythmSession() {
        const stored = await this.ctx.storage.get<string>('session_token');
        const fromEnv = normalizeDiffrhythmCookie(this.env.DIFFRHYTHM_SESSION_COOKIE);
        const candidates = [stored, fromEnv].filter((value): value is string => Boolean(value));
        if (candidates.length === 0) {
            throw new Error('DIFFRHYTHM_SESSION_COOKIE is missing');
        }

        // The stored cookie can belong to an older host.
        // Keep the cookie that can read the aisinging.ai account.
        const sessionToken = await refreshDiffrhythmCookie(candidates);
        await this.ctx.storage.put('session_token', sessionToken);
        return sessionToken;
    }

    // The site session is a Better Auth cookie. It has no refresh token.
    // This check confirms the stored session still signs in.
    async checkAisgSession() {
        const response = await fetch('https://aisonggenerator.io/api/auth/get-session', {
            method: 'GET',
            headers: aisgAuthHeaders(this.env),
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            throw new Error(`AISG session check failed: ${response.status}`);
        }

        const json = await response.json().catch(() => null) as { user?: { id?: string } } | null;
        if (!json?.user?.id) {
            throw new Error('AISG session check returned no user');
        }
    }
}
