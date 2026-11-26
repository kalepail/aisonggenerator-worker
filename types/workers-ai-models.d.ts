// Model definitions for Workers AI & AI Gateway Unified Billing models not yet present in generated worker-configuration.d.ts.
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

interface AnthropicMessagesInput {
	system?: string;
	messages: Array<{
		role: "user" | "assistant";
		content: string;
	}>;
	max_tokens: number;
	temperature?: number;
	thinking?: {
		type: "adaptive" | "enabled" | "disabled";
		budget_tokens?: number;
	};
	output_config?: {
		effort?: "low" | "medium" | "high" | "xhigh" | "max";
		format?: {
			type: "json_schema";
			schema: Record<string, unknown>;
		};
	};
}

interface AnthropicMessagesOutput {
	id?: string;
	type?: string;
	role?: string;
	stop_reason?: string | null;
	content?: Array<{
		type?: string;
		text?: string;
		thinking?: string;
	}>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
}

interface AiModels {
	"anthropic/claude-fable-5.2": {
		inputs: AnthropicMessagesInput;
		postProcessedOutputs: AnthropicMessagesOutput;
	};
	"anthropic/claude-opus-5.5": {
		inputs: AnthropicMessagesInput;
		postProcessedOutputs: AnthropicMessagesOutput;
	};
	"@cf/deepseek-ai/deepseek-v4.1-flash-1017": {
		inputs: ReasoningChatInput;
		postProcessedOutputs: ChatCompletionOutput;
	};
}
