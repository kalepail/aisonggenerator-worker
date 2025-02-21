export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Clip {
    id: string
    title: string
    status: number
    created_at: string
    major_model_version: string
    model_name: string
    audio_url: string
    metadata: Record<string, any>
}

export function processClips(clips: any[]) {
    // {
    //     "id": "fbd673cf-fd49-4aa0-832c-b36c40b5a5c5",
    //     "video_url": "https://cdn1.suno.ai/fbd673cf-fd49-4aa0-832c-b36c40b5a5c5.mp4",
    //     "audio_url": "https://cdn1.suno.ai/fbd673cf-fd49-4aa0-832c-b36c40b5a5c5.mp3",
    //     "image_url": "https://cdn2.suno.ai/image_fbd673cf-fd49-4aa0-832c-b36c40b5a5c5.jpeg",
    //     "image_large_url": "https://cdn2.suno.ai/image_large_fbd673cf-fd49-4aa0-832c-b36c40b5a5c5.jpeg",
    //     "major_model_version": "v3.5",
    //     "model_name": "chirp-v3",
    //     "metadata": {
    //         "tags": "pop, driving, fast",
    //         "negative_tags": "orchestra, country",
    //         "prompt": "[Verse]\nWho sucks the most at Fortnite?\nBucky\nThey said it three times yesterday\nGuess who gets killed the fastest\nBucky\nAnd it isn't even close like wow like woah\n\n[Verse]\nWho's only kinda good at Fortnite?\nZone\nZone's good but keeps getting killed by Kale\nBucky's only kinda fast so guess who kills him in a race\nZone\nAnd it isn't even close like wow like woah\n\n[Verse]\nAnd who is by far the best out of all of them?\nBy a mile?\nBy a mile?\nKale\nBy many many many miles\nLike what is even going on?\nIt's Kale\n\n[Verse]\nThrough thick and through thin\nCome partyin'\nTo Bucky\nTo Bucky\nWe're riding to Bucky\nEven though he sucks\n\n[Verse]\nOkay but really who sucks the most at Fortnite?\nBucky\nThey said it three times yesterday\nWho's the only one brave enough to admit how bad they suck?\nBucky\nAnd it isn't even close like wow like woah\n\n[Chorus]\nAnd who is by far the best out of all of them?\nBy a mile?\nBy a mile?\nKale\nBy many many many miles\nLike what is even going on?\nIt's Kale",
    //         "type": "gen",
    //         "duration": 109.6,
    //         "refund_credits": false,
    //         "stream": true
    //     },
    //     "is_liked": false,
    //     "user_id": "ec0e549b-646c-465f-a634-06f18428b49c",
    //     "display_name": "SMOLBOX",
    //     "handle": "smolbox",
    //     "is_handle_updated": true,
    //     "avatar_image_url": "https://cdn1.suno.ai/defaultOrange.webp",
    //     "is_trashed": false,
    //     "comment_count": 0,
    //     "flag_count": 0,
    //     "created_at": "2025-02-20T20:22:24.939Z",
    //     "status": "complete",
    //     "title": "Bucky",
    //     "play_count": 0,
    //     "upvote_count": 0,
    //     "is_public": false,
    //     "allow_comments": true
    // }

    return clips.map((clip: Clip) => {
        return {
            id: clip.id,
            title: clip.title,
            status: clip.audio_url ? clip.audio_url.includes('audiopipe') ? 1 : 2 : 0, // 0: queued, 1: processing, 2: finished
            created_at: clip.created_at,
            major_model_version: clip.major_model_version,
            model_name: clip.model_name,
            audio_url: clip.audio_url,
            metadata: clip.metadata,
        }
    })
}