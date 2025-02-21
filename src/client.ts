import axios from "axios";
import { Baker } from "./baker";
import * as cookie from 'cookie';

export async function getClient(env: Env, baker: Baker) {
    // Clerk (can get from client)
    // :method	POST
    // :scheme	https
    // :path	/v1/client/sessions/sess_2t0a7FTWk0uVYEbwX1elwJIEdGx/tokens?_is_native=true&_clerk_js_version=4.70.0
    // :authority	clerk.suno.com
    // content-type	application/x-www-form-urlencoded
    // accept	application/json
    // authorization	eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsaWVudF8ycVZPSW9mWk5NaWdkenUxb3k0SFhmVVZydGoiLCJyb3RhdGluZ190b2tlbiI6IjFnbjN0ZDE3ZG1vbm54NzlqcXdhOW52ZWI0aHV3eDJ0OGdqMnNlenkifQ.Auve9o5hL8U-ketCSwzrgWtX7s0CQflToliGy0XyiI6p7PB_eGHmlSTg_HAsVVj4u7_sEcrxnNQNhnx75igcXB-Il4Ht1rD8hw1t2rBlRm3IvXtEjfUS3LzQ2VuqdS4mz4lfazjNNosrYnpNpkm-0KeZtOZVpV_gvO6FjxokWF059kV6fshwUbIMQHbeaHWEJF7Tq6-SzuikF05C9o2YksfsIPRN1BrzHi3w2ITYtpiKTx2eZV6cBu3JNGCvFB--0pFOJ6VpFN7G6N0BQy2mPGIjx9Pvn85g7CsApg_xG_3hrO_gZhhY_TOLoz1nemel_VjJcnmIb4N40qMtbuVwkg
    // accept-language	en-US,en;q=0.9
    // accept-encoding	gzip, deflate, br
    // x-native-device-id	3021564B-4EB1-4F48-AB75-142EBED15199
    // x-ios-sdk-version	0.30.0
    // user-agent	suno/1.5.0 iPhone13,2 CFNetwork/1.0 Darwin/24.3.0 Mobile
    // content-length	0
    // x-clerk-client-id	client_2qVOIofZNMigdzu1oy4HXfUVrtj
    // clerk-api-version	2021-02-05
    // cookie	__cf_bm=1DY8WbZEbxqy84AGPc7ZsTriFTqOMOQYZJXbrG67cp8-1740158226-1.0.1.1-2b7wt9Uy5U9nDP2APH31DEUEx4U7eX_Eq45EdEpHIKaV6Jl06bsYHA6w078GAH2KsFz_WesUelfiBonCJHt5Xg
    // cookie	_cfuvid=eGO26Ri4YlixIeANAGNx.P6svH58vMHx_LiHbCIW0PI-1740157324757-0.0.1.1-604800000

    // Suno /token
    // :method	GET
    // :scheme	https
    // :path	/api/billing/info/
    // :authority	studio-api.prod.suno.com
    // accept	application/json
    // x-suno-client	iOS 1.5.0-8
    // accept-encoding	gzip, deflate, br
    // x-suno-region	US
    // anonymous-id	3021564B-4EB1-4F48-AB75-142EBED15199
    // user-agent	suno/8 CFNetwork/3826.400.120 Darwin/24.3.0
    // accept-language	en-US,en;q=0.9
    // authorization	Bearer eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQRDExMUFBQSIsImtpZCI6Imluc18yT1o2eU1EZzhscWRKRWloMXJvemY4T3ptZG4iLCJ0eXAiOiJKV1QifQ.eyJhdWQiOiJzdW5vLWFwaSIsImV4cCI6MTc0MDE1ODU0MywiZnZhIjpbMTExMjAsLTFdLCJodHRwczovL3N1bm8uYWkvY2xhaW1zL2NsZXJrX2lkIjoidXNlcl8ybkZQc0JxNzZoOFA2MURqVkRXeDV3WnBGekgiLCJodHRwczovL3N1bm8uYWkvY2xhaW1zL2VtYWlsIjoiaGlAdHl2ZGguY29tIiwiaHR0cHM6Ly9zdW5vLmFpL2NsYWltcy9waG9uZSI6bnVsbCwiaWF0IjoxNzQwMTU4NDgzLCJpc3MiOiJodHRwczovL2NsZXJrLnN1bm8uY29tIiwianRpIjoiNmMyYjJhOTIyMTFmZGVmMmNlMjEiLCJuYmYiOjE3NDAxNTg0NzMsInNpZCI6InNlc3NfMnQwYTdGVFdrMHVWWUVid1gxZWx3SklFZEd4Iiwic3ViIjoidXNlcl8ybkZQc0JxNzZoOFA2MURqVkRXeDV3WnBGekgifQ.TIbBvW-lfNWoAi-2rZrZKOOKa-kYNGALwSrObbzC4sBvpMt7gtkkl5nRe5JCpzrS0b2zf2TuEPZS-7qD8Egc-On7Jk9a70_LqF7AD07_B5YtXUNXmv7bntvUA4T7Vszdl-scN1TmXkfZQNwYlZgXGh3CeAd8aFovO0b1WnXQ440CaO0sQIhO2T1l4am5GN7iQQzMptOvy0EczyDBg86gtzdu6b_wkohzvc974eeX-YnR_dJDloASLdo3aQJ3fT4qJrssPd5i-4Yifzg17t0l9ZAGsax-o8JBNNfV6KLJjo9wLQ2mgYfybVJAcy2nKmCZ-6d5d0DArambsKgnY6-U_A

    // Suno /generate
    // :method	POST
    // :scheme	https
    // :path	/api/generate/v2/
    // :authority	studio-api.prod.suno.com
    // content-type	application/json; charset=utf-8
    // anonymous-id	3021564B-4EB1-4F48-AB75-142EBED15199
    // accept	application/json
    // authorization	Bearer eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQRDExMUFBQSIsImtpZCI6Imluc18yT1o2eU1EZzhscWRKRWloMXJvemY4T3ptZG4iLCJ0eXAiOiJKV1QifQ.eyJhdWQiOiJzdW5vLWFwaSIsImV4cCI6MTc0MDE1ODgxOCwiZnZhIjpbMTExMjQsLTFdLCJodHRwczovL3N1bm8uYWkvY2xhaW1zL2NsZXJrX2lkIjoidXNlcl8ybkZQc0JxNzZoOFA2MURqVkRXeDV3WnBGekgiLCJodHRwczovL3N1bm8uYWkvY2xhaW1zL2VtYWlsIjoiaGlAdHl2ZGguY29tIiwiaHR0cHM6Ly9zdW5vLmFpL2NsYWltcy9waG9uZSI6bnVsbCwiaWF0IjoxNzQwMTU4NzU4LCJpc3MiOiJodHRwczovL2NsZXJrLnN1bm8uY29tIiwianRpIjoiY2MzODc5YmE5M2UxZGNmMTNhYWQiLCJuYmYiOjE3NDAxNTg3NDgsInNpZCI6InNlc3NfMnQwYTdGVFdrMHVWWUVid1gxZWx3SklFZEd4Iiwic3ViIjoidXNlcl8ybkZQc0JxNzZoOFA2MURqVkRXeDV3WnBGekgifQ.xG9OsdXStPJZXIk8uQKqfHLX_WwgdOo1xOjMonknIQblNPfxWNOUwhXXVqNq1yU8PXvuHpJQGllIPn5Y-crHj3UTcIY8sLVwQRpx_3uUF6SNGpTCZLq7J4rE5GihP1nd-yE7M3hVQAGcmT2fs5pu-JHavhBujM7ecUmwviOYgUlGava1qiEUn2cGlEpYT1K_rJ1qLqXjLZ7BwBa_QZj3ZOwGYoPG6_14cVHtVbi70KUarLU4BiAvxim8QqQuRfDURolSNO2XG0cUOFw3S_O_vV4JeW8m1ykb0zSrsPNyvoxnEQbWdFGTH3VnOalo9OBfQ8PrWu7eUvwYPo7k3Prb7g
    // accept-encoding	gzip, deflate, br
    // upload-draft-interop-version	6
    // accept-language	en-US,en;q=0.9
    // x-suno-region	US
    // content-length	1957
    // user-agent	suno/8 CFNetwork/3826.400.120 Darwin/24.3.0
    // upload-complete	?1
    // x-suno-client	iOS 1.5.0-8

    const anonymous_id = baker.cookies.ajs_anonymous_id || crypto.randomUUID();
    const client = axios.create({
        withCredentials: true,
        headers: {
            'user-agent': env.USER_AGENT,

            // Suno
            'x-suno-client': 'iOS 1.5.0-8',
            'x-suno-region': 'US',
            'anonymous-id':	anonymous_id,

            // Clerk
            'x-native-device-id': anonymous_id,
            'x-ios-sdk-version': '0.30.0',
            'clerk-api-version': env.CLERK_API_VERSION,

            // 'Affiliate-Id': 'undefined',
            // 'Device-Id': device_id,
            // 'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
            // 'Sec-Ch-Ua-Mobile': '?0',
            // 'Sec-Ch-Ua-Platform': '"macOS"',
            // // 'Browser-Token': `'{"token":"${browser_token}"}'`,
            // // 'Content-Type': 'text/plain;charset=UTF-8',
            // 'Referer': 'https://suno.com/',
            // 'User-Agent': env.USER_AGENT,
        }
    });

    client.interceptors.request.use((req) => {
        req.headers.set('Cookie', baker.getCookieHeader(), true);
        return req;
    });

    client.interceptors.response.use((res) => {
        const set_cookie_header = res.headers["set-cookie"] as unknown as string | undefined;

        if (set_cookie_header) {
            baker.addCookies(cookie.parse(set_cookie_header));
        }

        return res;
    });

    return client;
}