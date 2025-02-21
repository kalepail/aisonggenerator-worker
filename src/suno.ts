import type { AxiosInstance } from "axios";
import type { Clerk } from "./clerk";
import { RequestLike } from "itty-router";
import { sleep } from "./utils";

export class Suno {
    private env: Env
    private client: AxiosInstance
    private clerk: Clerk

    constructor(env: Env, client: AxiosInstance, clerk: Clerk) {
        this.env = env;
        this.client = client;
        this.clerk = clerk;
    }

    async captchaRequired() {
        return this.client.post(`${this.env.SUNO_BASE_URL}/api/c/check`, {
            ctype: 'generation'
        }, {
            headers: {
                Authorization: `Bearer ${await this.clerk.getToken()}`,
            },
        })
    }

    async get(req: RequestLike) {
        const url = new URL(`${this.env.SUNO_BASE_URL}/api/feed/v2`);

        // TODO consider forcing a limit on `ids` count and/or not allowing `page`

        if (req.query.ids) {
            url.searchParams.append('ids', req.query.ids);
        }
        if (req.query.page) {
            url.searchParams.append('page', req.query.page);
        }

        return this.client.get(url.href, {
            headers: {
                Authorization: `Bearer ${await this.clerk.getToken()}`,
            },
        });
    }

    async lyrics(prompt: string) {
        const url = `${this.env.SUNO_BASE_URL}/api/generate/lyrics`;
        const options = {
            headers: {
                Authorization: `Bearer ${await this.clerk.getToken()}`,
            },
        };
        
        // Initiate lyrics generation
        let lyrics_res = await this.client.post(url, { 
            prompt,
            lyrics_model: "remi-v1", // default | remi-v1
        }, options);

        const lyrics_id = lyrics_res.data.id;

        // Poll for lyrics completion
        lyrics_res = await this.client.get(`${url}/${lyrics_id}`, options);

        while (lyrics_res?.data?.status !== 'complete') {
            await sleep(2000);
            lyrics_res = await this.client.get(`${url}/${lyrics_id}`, options);
        }

        // Return the generated lyrics text
        return lyrics_res;
    }

    async generate(
        body: {
            title: string
            prompt: string
            tags: string[]
            negative_tags?: string[]
        },
        captcha_token?: string,
    ) {
        // TODO can we generate to a specific workspace?
        // https://suno.com/create?wid=1bb1552c-3d4b-4b7e-a1a6-d49bb87bbe39 (SMOL)

        // {
        //     "token": null,
        //     "prompt": "[Verse]\nWho sucks the most at Fortnite?\nBucky\nThey said it three times yesterday\nGuess who gets killed the fastest\nBucky\nAnd it isn't even close like wow like woah\n\n[Verse]\nWho's only kinda good at Fortnite?\nZone\nZone's good but keeps getting killed by Kale\nBucky's only kinda fast so guess who kills him in a race\nZone\nAnd it isn't even close like wow like woah\n\n[Verse]\nAnd who is by far the best out of all of them?\nBy a mile?\nBy a mile?\nKale\nBy many many many miles\nLike what is even going on?\nIt's Kale\n\n[Verse]\nThrough thick and through thin\nCome partyin'\nTo Bucky\nTo Bucky\nWe're riding to Bucky\nEven though he sucks\n\n[Verse]\nOkay but really who sucks the most at Fortnite?\nBucky\nThey said it three times yesterday\nWho's the only one brave enough to admit how bad they suck?\nBucky\nAnd it isn't even close like wow like woah\n\n[Chorus]\nAnd who is by far the best out of all of them?\nBy a mile?\nBy a mile?\nKale\nBy many many many miles\nLike what is even going on?\nIt's Kale",
        //     "generation_type": "TEXT",
        //     "tags": "pop, driving, fast",
        //     "negative_tags": "orchestra, country",
        //     "mv": "chirp-v3-5",
        //     "title": "Bucky",
        //     "continue_clip_id": null,
        //     "continue_at": null,
        //     "continued_aligned_prompt": null,
        //     "infill_start_s": null,
        //     "infill_end_s": null,
        //     "task": null,
        //     "persona_id": null,
        //     "artist_clip_id": null,
        //     "artist_start_s": null,
        //     "artist_end_s": null,
        //     "cover_clip_id": null,
        //     "metadata": {
        //         "create_session_token": "c5ebe99e-5c86-46ab-89f3-c2625a15d3a2"
        //     }
        // }

        // {
        //     "token": null,
        //     "gpt_description_prompt": "a syncopated folk song about a cozy rainy day",
        //     "mv": "chirp-v3-5",
        //     "prompt": "",
        //     "metadata": {
        //         "lyrics_model": "default"
        //     },
        //     "make_instrumental": false,
        //     "user_uploaded_images_b64": [],
        //     "generation_type": "TEXT"
        // }

        return this.client.post(`${this.env.SUNO_BASE_URL}/api/generate/v2`, {
            token: captcha_token,
            prompt: body.prompt,
            generation_type: "TEXT", // TODO might be other types here. The mobile app suggests Camera and Audio as well
            tags: body.tags.join(', '),
            // negative_tags: body.negative_tags?.join(', '),
            mv: "chirp-v3-5", // "chirp-v4", // chirp-v3-5
            title: body.title,
        }, {
            headers: {
                Authorization: `Bearer ${await this.clerk.getToken()}`,
            },
        });
    }
}