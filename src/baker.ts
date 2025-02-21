import * as cookie from 'cookie';
import type { SerializeOptions } from 'cookie';

export class Baker {
    public cookies: Record<string, string | undefined>;

    constructor(env: Env) {
        this.cookies = {
            ...cookie.parse(env.SUNO_COOKIE),
        }
    }

    // NOTE update the page cookies?
        // Likely not necessary as we aren't sending custom fetch requests from inside the browser after making separate ones server side

    public addCookies(cookies: Record<string, string | undefined>) {
        this.cookies = { ...this.cookies, ...cookies };
    }
    public addCookie(name: string, val: string, options: SerializeOptions) {
        let cookie_str = cookie.serialize(name, val, options);
        let cookie_rec = cookie.parse(cookie_str);

        this.cookies = { ...this.cookies, ...cookie_rec };
    }
    public getCookieHeader() {
        const cookie_arr = Object
            .entries(this.cookies)
            .map(([key, value]) => value && cookie.serialize(key, value, {
                domain: '.suno.com',
                path: '/',
                sameSite: 'lax'
            }))
            .filter(Boolean);

        return cookie_arr.join('; ');
    }
    public getCookiesArray() {
        // Protocol.Network.CookieParam
        let cookie_array: any[] = [];

        for (let key in this.cookies) {
            cookie_array.push({
                name: key,
                value: this.cookies[key] + '',
                domain: '.suno.com',
                path: '/',
                sameSite: 'Lax'
            });
        }

        return cookie_array;
    }
}