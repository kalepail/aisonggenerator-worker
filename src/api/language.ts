const HAN_SCRIPT_RE = /\p{Script=Han}/u;
const KANA_SCRIPT_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const EXPLICIT_HAN_LANGUAGE_RE =
	/\b(chinese|mandarin|cantonese|taiwanese|hokkien|c-?pop|mandopop|cantopop|zhongwen|putonghua|guoyu|hanzi|japanese|j-?pop|j-?rock|kanji|nihongo)\b/i;

export interface LyricsCandidate {
	title?: string | null;
	lyrics?: string | null;
	style?: string[];
}

export function containsHan(text: string | null | undefined): boolean {
	return typeof text === "string" && HAN_SCRIPT_RE.test(text);
}

/**
 * Returns true when Han characters (Chinese characters / Japanese kanji) are
 * expected or explicitly requested by the prompt.
 * Note: Korean uses Hangul (\p{Script=Hangul}), so Korean/K-pop prompts return
 * false here and will still reject accidental Chinese output.
 */
export function promptAllowsHan(prompt: string): boolean {
	if (!prompt) {
		return false;
	}
	return (
		HAN_SCRIPT_RE.test(prompt) ||
		KANA_SCRIPT_RE.test(prompt) ||
		EXPLICIT_HAN_LANGUAGE_RE.test(prompt)
	);
}

export function hasUnexpectedChinese(prompt: string, candidate: LyricsCandidate): boolean {
	if (promptAllowsHan(prompt)) {
		return false;
	}
	if (containsHan(candidate.title) || containsHan(candidate.lyrics)) {
		return true;
	}
	if (Array.isArray(candidate.style) && candidate.style.some((tag) => containsHan(tag))) {
		return true;
	}
	return false;
}
