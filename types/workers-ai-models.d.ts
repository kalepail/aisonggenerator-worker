// Model definitions for Workers AI models not yet present in generated worker-configuration.d.ts.
interface ReasoningChatInput {
	messages: Array<{
		role: "system" | "user" | "assistant";
		content: string;
	}>;
	max_completion_tokens?: number;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	reasoning_effort?: "max" | "high" | "medium" | "low" | "minimal" | "none";
	response_format?: {
		type: "json_object" | "json_schema" | "text";
		json_schema?: Record<string, unknown>;
	};
	chat_template_kwargs?: {
		thinking?: boolean;
		enable_thinking?: boolean;
	};
}

interface ChatCompletionOutput {
	response?: unknown;
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | null;
			reasoning_content?: string | null;
		};
		finish_reason?: string | null;
	}>;
	result?: {
		response?: unknown;
		choices?: Array<{
			message?: {
				role?: string;
				content?: string | null;
				reasoning_content?: string | null;
			};
			finish_reason?: string | null;
		}>;
	};
}

interface AiModels {
	"@cf/deepseek-ai/deepseek-v4.1-flash-1017": {
		inputs: ReasoningChatInput;
		postProcessedOutputs: ChatCompletionOutput;
	};
}
