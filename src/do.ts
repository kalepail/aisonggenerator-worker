import { DurableObject } from 'cloudflare:workers';
import { aisgAuthHeaders } from './api/aisonggenerator';
import { normalizeDiffrhythmCookie, refreshDiffrhythmCookie } from './api/diffrhythm';

export class DO extends DurableObject<Env> {
    private refreshingDiffrhythmToken = false;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async getDiffrhythmSession(refresh = false) {
        if (refresh && !this.refreshingDiffrhythmToken) {
            this.refreshingDiffrhythmToken = true;
            try {
                await this.refreshDiffrhythmSession();
            } finally {
                this.refreshingDiffrhythmToken = false;
            }
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
    }

    // The site session is a Better Auth cookie. It has no refresh token.
    // This check confirms the stored session still signs in.
    async checkAisgSession() {
        const token = this.env.AISONGGENERATOR_SESSION_TOKEN?.trim();
        if (!token) {
            throw new Error('AISONGGENERATOR_SESSION_TOKEN is missing');
        }

        const response = await fetch('https://aisonggenerator.io/api/auth/get-session', {
            method: 'GET',
            headers: aisgAuthHeaders(this.env),
        });

        if (!response.ok) {
            throw new Error(`AISG session check failed: ${response.status}`);
        }

        const json = await response.json() as { user?: { id?: string } };
        if (!json?.user) {
            throw new Error('AISG session check returned no user');
        }
    }
}