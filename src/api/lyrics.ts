import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getLyrics as getSunoLyrics, LyricsStatusResponse } from "./suno"; // Import Suno functions
import { songWrite } from "./cf"; // Import songWrite

// Define the unified response type
interface UnifiedLyricsResponse {
    title: string | null;
    lyrics: string | null;
    style: string[];
    service: string;
}

// Service definition for cleaner iteration
interface LyricsService {
    name: string;
    fetch: (prompt: string, requestBody: string, env: Env) => Promise<UnifiedLyricsResponse | null>;
}

const lyricsServices: LyricsService[] = [
    {
        name: "aisonggenerator.io",
        fetch: async (prompt, _requestBody, env) => {
            const res = await fetch('https://aisonggenerator.io/api/lyrics-generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    prompt,
                    model: "openai/gpt-5.2-chat",
                    userId: env.AISONGGENERATOR_USER_ID,
                }),
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            }
            const response: any = await res.json();
            if (response?.lyrics && response?.title) {
                return {
                    title: response.title,
                    service: "aisonggenerator.io",
                    lyrics: response.lyrics,
                    style: response.tags ? response.tags.split(',').map((s: string) => s.trim()) : (response.style ? response.style.split(',').map((s: string) => s.trim()) : []),
                };
            }
            throw new Error("Response missing lyrics or title");
        }
    },
    {
        name: "suno",
        fetch: async (prompt) => {
            const sunoResponse: LyricsStatusResponse = await getSunoLyrics(prompt);
            if (sunoResponse.status === 'complete' && sunoResponse.text && sunoResponse.title) {
                return {
                    title: sunoResponse.title,
                    service: "suno",
                    lyrics: sunoResponse.text,
                    style: sunoResponse.tags || [],
                };
            }
            throw new Error(`Suno status: ${sunoResponse.status}, error: ${sunoResponse.error_message || 'no lyrics/title'}`);
        }
    },
    {
        name: "cloudflare-ai",
        fetch: async (prompt, _requestBody, env) => {
            const cfApiResponse = await songWrite(env, prompt || "");
            if (!cfApiResponse || typeof (cfApiResponse as any).response !== 'string') {
                throw new Error("Cloudflare AI returned invalid response type");
            }
            const cfAiOutput = cfApiResponse as { response: string };
            let parsedCfResponse: any;
            try {
                parsedCfResponse = JSON.parse(
                    cfAiOutput.response.replace(
                        /"lyrics":\s*"(.*?)"(?=,|"style")/s,
                        (_, lyrics) => {
                            const escaped = lyrics
                                .replace(/\\/g, '\\\\')
                                .replace(/"/g, '\\"')
                                .replace(/\r?\n/g, '\\n');
                            return `"lyrics": "${escaped}"`;
                        }
                    )
                );
            } catch (parseErr) {
                throw new Error(`Failed to parse Cloudflare AI response: ${cfAiOutput.response.substring(0, 200)}`);
            }
            if (parsedCfResponse.title && parsedCfResponse.lyrics && Array.isArray(parsedCfResponse.style)) {
                return {
                    title: parsedCfResponse.title.trim(),
                    service: "cloudflare-ai",
                    lyrics: parsedCfResponse.lyrics.trim(),
                    style: parsedCfResponse.style,
                };
            }
            throw new Error("Cloudflare AI response missing title, lyrics, or style array");
        }
    }
];

export async function lyrics(ctx: Context<{ Bindings: Env }>) {
    const { req } = ctx;
    const requestBody = await req.text();
    let prompt: string | undefined;

    try {
        const parsedBody = JSON.parse(requestBody);
        prompt = parsedBody.prompt;
    } catch (e) {
        // If parsing fails, assume the body itself is the prompt string
        prompt = requestBody;
    }

    const errors: string[] = [];

    for (const service of lyricsServices) {
        try {
            console.log(`Attempting lyrics generation with ${service.name}...`);
            const result = await service.fetch(prompt || "", requestBody, ctx.env);
            if (result) {
                console.log(`Successfully generated lyrics with ${service.name}`);
                return ctx.json(result);
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`${service.name} failed: ${errorMsg}`);
            errors.push(`${service.name}: ${errorMsg}`);
            // Continue to next service
        }
    }

    // All services failed
    console.error("All lyrics services failed:", errors);
    throw new HTTPException(500, { message: `All lyric generation services failed. Errors: ${errors.join('; ')}` });
}
