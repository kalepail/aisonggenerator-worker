import { AxiosInstance } from "axios";
import { Baker } from "./baker";

// TODO there's at least one, maybe more, clerk calls being made and I should emulate those maybe in a cron to keep the tokens, auth and sessions fresh
    // environment
    // verify
    // touch

export class Clerk {
    private static client_id: string
    private static session_id: string

    private env: Env
    private client: AxiosInstance
    private baker: Baker

    private constructor(env: Env, client: AxiosInstance, baker: Baker) {
        this.env = env;
        this.client = client;
        this.baker = baker;
    }

    public static async create(env: Env, client: AxiosInstance, baker: Baker): Promise<Clerk> {
        const {
            client_id,
            session_id,
        } = await this.getSessionId(env, client, baker);

        this.client_id = client_id;
        this.session_id = session_id;

        // `getToken` call required to set the `__session` cookie
        await this.getToken(env, client, baker);

        return new Clerk(env, client, baker);
    }

    public async getToken() {
        return Clerk.getToken(this.env, this.client, this.baker);
    }

    private static async getSessionId(env: Env, client: AxiosInstance, baker: Baker) {
        const url = `${env.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${env.CLERK_JS_VERSION}`;
        const res = await client.get(url, {
            headers: {
                Authorization: baker.cookies.__client
            }
        });
    
        if (!res?.data?.response?.last_active_session_id) {
            throw new Error('Failed to get session id, you may need to update the SUNO_COOKIE');
        }

        return {
            client_id: res.data.response.id,
            session_id: res.data.response.last_active_session_id,
        };
    }

    private static async getToken(env: Env, client: AxiosInstance, baker: Baker) {
        const url = `${env.CLERK_BASE_URL}/v1/client/sessions/${this.session_id}/tokens?_is_native=true&_clerk_js_version=${env.CLERK_JS_VERSION}`;
        const res = await client.post(url, {}, {
            headers: {
                Authorization: baker.cookies.__client,
                'x-clerk-client-id': this.client_id,
            }
        });
    
        if (!res?.data?.jwt) {
            throw new Error('Failed to get token, you may need to update the SUNO_COOKIE');
        }
    
        const token: string = res.data.jwt;
    
        baker.addCookie('__session', token, {
            domain: '.suno.com',
            path: '/',
            sameSite: 'lax',
        });
    
        return token;
    }
}