export async function songWrite(env: Env, prompt: string) {
    const messages = [
        {
            role: "system", content: `You are a creative and comedic song writer.

Your task is to write a song based on a prompt and a description of an image which the prompt generated.

Your output should be formatted with musical tags such as [Intro], [Verse], [Chorus], [Bridge], [Outro], etc. The key being each tag is a section of the song and denoted with brackets [].

Feel free to include instrumental, gender and genre clues in the tags should the song need it.

Songs should be relatively short, just 2-3 verses long.`
        },
        {
            role: "user",
            content: prompt,
        },
    ];

    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages,
        max_tokens: 1024,
        temperature: 0.8,
        frequency_penalty: 0.3,
        presence_penalty: 0.2,
        response_format: {
            type: "json_schema",
            json_schema: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    lyrics: { type: "string" },
                    style: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                required: ["title", "lyrics", "style"],
            },
        },
    });

    let draft: unknown = result && "response" in result ? result.response : undefined;
    if (typeof draft === "string") {
        const json = draft.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        try {
            draft = JSON.parse(json);
        } catch {
            throw new Error("Cloudflare AI returned invalid JSON");
        }
    }

    const song = draft as { title?: unknown; lyrics?: unknown; style?: unknown } | null;
    if (typeof song?.title !== "string" || !song.title.trim()
        || typeof song.lyrics !== "string" || !song.lyrics.trim()
        || !Array.isArray(song.style) || !song.style.every(tag => typeof tag === "string")) {
        throw new Error("Cloudflare AI response does not match the lyrics schema");
    }

    return {
        title: song.title.trim(),
        lyrics: song.lyrics.trim(),
        style: song.style.map(tag => tag.trim()).filter(Boolean),
    };
}
