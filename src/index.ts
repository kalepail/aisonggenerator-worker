import puppeteer, { Browser, Page } from "@cloudflare/puppeteer";
import * as cookie from 'cookie';
import axios, { AxiosInstance } from 'axios';
import { Solver } from "@2captcha/captcha-solver";
import { SerializeOptions } from "cookie";

const SUNO_BASE_URL = 'https://studio-api.prod.suno.com';
const CLERK_BASE_URL = 'https://clerk.suno.com';
const CLERK_JS_VERSION = '5.52.2';
const CLERK_API_VERSION = '2024-10-01';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// TODO move this all into a workflow and set some reasonable failsafes and timeouts

export default {
    async fetch(req, env, ctx): Promise<Response> {
        let timeout: NodeJS.Timeout | null = null;
        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
            const body = await req.json<{ prompt: string }>();

            // TODO there's at least one, maybe more, clerk calls being made and I should emulate those maybe in a cron to keep the tokens, auth and sessions fresh
            // environment
            // verify
            // touch

            // NOTE looks like there's also a honeypot of some sort https://suno.com/suno-prod-s8wir/58sj3ae84cd6
            // Could be regional though. IP based? Unsure but doesn't seem to be affecting anything atm

            const baker = new Cookies(env.SUNO_COOKIE);
            const solver = new Solver(env.TWOCAPTCHA_API_KEY);

            const client = await getAxiosClient(baker);
            const session_id = await getSessionId(client, baker);

            // `getToken` call required to set the `__session` cookie
            const current_token = await getToken(client, baker, session_id)
            const checkResponse = await client.post(`${SUNO_BASE_URL}/api/c/check`, {
                ctype: 'generation'
            }, {
                headers: {
                    Authorization: `Bearer ${current_token}`,
                },
            });

            console.log('CAPTCHA REQUIRED', checkResponse.data);

            const gpt_description_prompt = body.prompt || 'GROOT';

            // try without captcha
            try {
                const current_token = await getToken(client, baker, session_id);
                const generateResponse = await sunoGenerate(client, gpt_description_prompt, null, current_token);
                return Response.json(generateResponse.data)
            } 

            // try with captcha
            catch(err) {
                console.log('Failed without CAPTCHA');
                console.error(JSON.stringify(err, null, 2));

                const captcha_data = await env.KV.get('CAPTCHA_DATA');

                try {
                    const current_token = await getToken(client, baker, session_id);
                    const generateResponse = await sunoGenerate(client, gpt_description_prompt, captcha_data, current_token);
                    return Response.json(generateResponse.data)
                } 

                // try click
                catch(err) {
                    console.log('Failed with CAPTCHA');
                    console.error(JSON.stringify(err, null, 2));
                }
            }

            browser = await puppeteer.launch(env.BROWSER);
            const context = await browser.createIncognitoBrowserContext();

            page = await context.newPage();

            page.setDefaultTimeout(60000);
            await page.setUserAgent(USER_AGENT);
            await page.setViewport({ width: 0, height: 0 });
            await page.setCookie(...baker.getCookiesArray());

            await page.goto('https://suno.com/create', {
                referer: 'https://www.google.com/',
                waitUntil: 'domcontentloaded',
                timeout: 0
            });

            // return new Response(await page.screenshot(), {
            //     headers: { 'Content-Type': 'image/png' }
            // });

            await page.waitForSelector('[aria-label="Create"]')
            console.log('Found Create');

            // return new Response(await page.content(), {
            //     headers: { 'Content-Type': 'text/html' }
            // });

            const res = await new Promise(async (resolve, reject) => {
                await page!.setRequestInterception(true);

                // Limit attempt to 60 seconds
                // TODO reset this timeout as long as things are happening
                timeout = setTimeout(() => reject('Timeout'), 60000)

                page!.on('request', async (request) => {
                    const method = request.method()
                    const url = request.url()

                    // console.log(
                    //     method,
                    //     url,
                    //     `\n\n`
                    // );

                    // with captcha
                    // TODO not sure this is the best method to ensure captcha is required
                    // TODO I also think at this point captcha WILL be required so likely we're just waiting for /turnstile/ anyway
                    if (
                        method === 'GET'
                        && url.includes('/turnstile/')
                    ) {
                        try {
                            await request.continue();

                            console.log('Intercepted request to /turnstile/');

                            let sitekey;

                            const iframes = await page!.$$('iframe');

                            for (const iframe of iframes) {
                                const src = await iframe.evaluate(el => el.getAttribute('src'));

                                if (src && src.includes('sitekey')) {
                                    const frame = await iframe.contentFrame();

                                    if (frame) {
                                        const url = new URL(src);

                                        for (let kv of url.hash.split('&')) {
                                            const [key, val] = kv.split('=');

                                            if (key === 'sitekey') {
                                                sitekey = val;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }

                            if (!sitekey) {
                                return reject('Failed to get sitekey');
                            }

                            console.log('SITEKEY', sitekey);

                            const captcha = await solver.hcaptcha({
                                pageurl: page!.url(),
                                sitekey,
                                userAgent: USER_AGENT
                            })

                            await env.KV.put('CAPTCHA_DATA', captcha.data);

                            console.log(JSON.stringify(captcha, null, 2));

                            // TODO would it make any sense to actually generate the song inside the `browser` vs here on the server?
                            // Probably not if it works like this as-is

                            const gpt_description_prompt = await page!.$eval('.custom-textarea', (el) => el.getAttribute('placeholder'));

                            if (!gpt_description_prompt) {
                                return reject('Failed to get gpt_description_prompt');
                            }

                            const current_token = await getToken(client, baker, session_id);
                            const generateResponse = await sunoGenerate(client, gpt_description_prompt, captcha.data, current_token);

                            resolve(generateResponse.data)
                        } catch (err) {
                            reject(err);
                        }
                    }

                    // without captcha
                    // TODO not sure this would ever be needed. Either it works up front or a captcha is required
                    // else if (
                    //     method === 'POST'
                    //     && url.includes('/api/generate/v2/')
                    // ) {
                    //     try {
                    //         console.log('Intercepted request to /api/generate/v2/');

                    //         await request.abort();

                    //         const headers = request.headers();
                    //         const authorization = headers.authorization;
                    //         const current_token = authorization.split(' ')[1];

                    //         const gpt_description_prompt = await page!.$eval('.custom-textarea', (el) => el.getAttribute('placeholder'));

                    //         if (!gpt_description_prompt) {
                    //             throw new Error('Failed to get gpt_description_prompt');
                    //         }

                    //         const generateResponse = await sunoGenerate(client, gpt_description_prompt, null, current_token);
                    //         console.log(JSON.stringify(generateResponse.data, null, 2));

                    //         resolve(await page!.screenshot());
                    //     } catch (err) {
                    //         reject(err);
                    //     }
                    // }

                    else {
                        await request.continue();
                    }
                });

                await page!.click('[aria-label="Create"]');
                console.log('Clicked Create');
            })

            ctx.waitUntil(browser.close());

            return Response.json(res);
        } catch (err: any) {
            console.error(JSON.stringify(err, null, 2));

            if (page) {
                return new Response(await page.screenshot(), {
                    headers: { 'Content-Type': 'image/png' }
                });
            } else {
                return new Response(err?.statusText || err?.message || JSON.stringify(err), { status: 400 });
            }
        } finally {
            if (browser) {
                ctx.waitUntil(browser.close());
            }

            if (timeout) {
                clearTimeout(timeout);
            }
        }
    },
} satisfies ExportedHandler<Env>;

export async function sunoGenerate(
    client: AxiosInstance,
    gpt_description_prompt: string,
    captcha_token: string | null,
    current_token: string
) {
    // TODO can we generate to a specific workspace?

    return client.post(`${SUNO_BASE_URL}/api/generate/v2/`, {
        token: captcha_token,
        gpt_description_prompt,
        mv: "chirp-v4",
        prompt: "",
        metadata: {
            lyrics_model: "default"
        },
        make_instrumental: false,
        user_uploaded_images_b64: [],
        generation_type: "TEXT"
    }, {
        headers: {
            Authorization: `Bearer ${current_token}`,
        },
    });
}

export async function getSessionId(client: AxiosInstance, baker: Cookies) {
    const sessionUrl = `${CLERK_BASE_URL}/v1/client?_is_native=true&__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
    const sessionResponse = await client.get(sessionUrl, {
        headers: {
            Authorization: baker.cookies.__client
        }
    });

    if (!sessionResponse?.data?.response?.last_active_session_id) {
        throw new Error('Failed to get session id, you may need to update the SUNO_COOKIE');
    }

    return sessionResponse.data.response.last_active_session_id;
}

export async function getToken(
    client: AxiosInstance,
    baker: Cookies,
    session_id: string
) {
    const renewUrl = `${CLERK_BASE_URL}/v1/client/sessions/${session_id}/tokens?_is_native=true&__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
    const renewResponse = await client.post(
        renewUrl,
        {},
        {
            headers: {
                Authorization: baker.cookies.__client
            }
        }
    );

    if (!renewResponse?.data?.jwt) {
        throw new Error('Failed to get token, you may need to update the SUNO_COOKIE');
    }

    let current_token: string = renewResponse.data.jwt;

    baker.addCookie('__session', current_token, {
        domain: '.suno.com',
        path: '/',
        sameSite: 'lax',
    })

    return current_token;
}

export async function getAxiosClient(baker: Cookies) {
    const browser_token = btoa(`'{"timestamp": ${Date.now()}}'`);
    const device_id = baker.cookies.ajs_anonymous_id || crypto.randomUUID();

    const client = axios.create({
        withCredentials: true,
        headers: {
            'Affiliate-Id': 'undefined',
            'Device-Id': device_id,
            'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Browser-Token': `'{"token":"${browser_token}"}'`,
            'Content-Type': 'text/plain;charset=UTF-8',
            'Referer': 'https://suno.com/',
            'User-Agent': USER_AGENT,
        }
    });

    client.interceptors.request.use((req) => {
        req.headers.set('Cookie', baker.getCookie(), true);
        return req;
    });

    client.interceptors.response.use((res) => {
        const set_cookie_header = res.headers["set-cookie"] as unknown as string | undefined;

        if (set_cookie_header) {
            baker.addCookies(cookie.parse(set_cookie_header));
            // TODO should we be updating the SUNO_COOKIE here?
        }

        return res;
    });

    return client;
}

class Cookies {
    public cookies: Record<string, string | undefined>;

    constructor(SUNO_COOKIE: string) {
        this.cookies = cookie.parse(SUNO_COOKIE);
    }

    public addCookies(cookies: Record<string, string | undefined>) {
        this.cookies = { ...this.cookies, ...cookies };
    }
    public addCookie(name: string, val: string, options: SerializeOptions) {
        let cookie_str = cookie.serialize(name, val, options);
        let cookie_rec = cookie.parse(cookie_str);
        this.cookies = { ...this.cookies, ...cookie_rec };
    }
    public getCookie() {
        const cookie_arr = Object
            .entries(this.cookies)
            .map(([key, value]) => value && cookie.serialize(key, value))
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