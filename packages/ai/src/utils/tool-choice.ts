/**
 * Utility functions for mapping unified ToolChoice to provider-specific formats.
 */
import type { Model, ToolChoice } from "../types";

/** OpenAI Completions API tool choice format */
export type OpenAICompletionsToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } }
	| undefined;

/** OpenAI Responses API tool choice format (flat structure) */
export type OpenAIResponsesToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| { type: "computer" }
	| undefined;

/** Anthropic-compatible tool choice format */
export type AnthropicToolChoice = "auto" | "none" | "any" | { type: "tool"; name: string } | undefined;

/**
 * Extract function name from unified ToolChoice.
 */
function extractFunctionName(choice: ToolChoice): string | undefined {
	if (typeof choice === "string") return undefined;
	if (choice.type === "tool" && "name" in choice) return choice.name;
	if (choice.type === "function") {
		if ("function" in choice && choice.function && typeof choice.function === "object") {
			return (choice.function as { name?: string }).name;
		}
		if ("name" in choice) return choice.name;
	}
	return undefined;
}

/**
 * Map unified ToolChoice to OpenAI Completions API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 */
export function mapToOpenAICompletionsToolChoice(choice?: ToolChoice): OpenAICompletionsToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "function", function: { name } } : undefined;
}

/**
 * Returns true when an OpenAI-completions `tool_choice` value forces a tool
 * call (`"required"` or a function-name pin), as opposed to leaving it open
 * (`"auto"`, `"none"`, or unset). Accepts `unknown` because the param shape
 * pulled from the OpenAI SDK (`ChatCompletionToolChoiceOption`) widens with
 * each release; this check only needs the open/forced bit.
 */
export function isForcedToolChoice(choice: unknown): boolean {
	if (choice === undefined || choice === "auto" || choice === "none") return false;
	return true;
}

/**
 * Turns a forced OpenAI `tool_choice` (`"required"` or a named function) into
 * `"auto"`, for a model whose compat sets `supportsForcedToolChoice: false`:
 * such a model rejects the forced selector with a 400 whoever wrote it. The
 * tool stays offered.
 */
function relaxForcedOpenAIToolChoice(params: { tool_choice?: unknown }): void {
	if (isForcedToolChoice(params.tool_choice)) params.tool_choice = "auto";
}

/**
 * {@link relaxForcedOpenAIToolChoice} for an Anthropic Messages payload, where
 * `{ type: "any" }` and `{ type: "tool", name }` are the forced selectors.
 */
function relaxForcedAnthropicToolChoice(params: { tool_choice?: { type: string } }): void {
	const type = params.tool_choice?.type;
	if (type === "any" || type === "tool") params.tool_choice = { type: "auto" };
}

/**
 * {@link relaxForcedOpenAIToolChoice} for a Bedrock Converse request. Its
 * `toolConfig.toolChoice` holds exactly one of `auto`, `any` and `tool`, so
 * every choice other than `auto` is forced.
 */
function relaxForcedBedrockToolChoice(request: { toolConfig?: { toolChoice?: object } }): void {
	const toolConfig = request.toolConfig;
	const choice = toolConfig?.toolChoice;
	if (toolConfig && choice && !("auto" in choice)) toolConfig.toolChoice = { auto: {} };
}

/**
 * Puts a provider payload back inside the model's forced-tool-choice compat.
 * Providers fit the request they build; this fits the one an `onPayload`
 * hook hands back, in the wire shape of `model.api`. It changes nothing for a
 * model that accepts forced selection, or for a payload that is not an object.
 */
export function relaxForcedToolChoiceForModel(payload: unknown, model: Model): void {
	const compat = model.compat as { supportsForcedToolChoice?: boolean } | undefined;
	if (compat?.supportsForcedToolChoice !== false) return;
	if (!payload || typeof payload !== "object") return;
	if (model.api === "anthropic-messages") {
		relaxForcedAnthropicToolChoice(payload as { tool_choice?: { type: string } });
	} else if (model.api === "bedrock-converse-stream") {
		relaxForcedBedrockToolChoice(payload as { toolConfig?: { toolChoice?: object } });
	} else {
		relaxForcedOpenAIToolChoice(payload as { tool_choice?: unknown });
	}
}

/**
 * Map unified ToolChoice to OpenAI Responses API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", name } (flat structure)
 */
export function mapToOpenAIResponsesToolChoice(choice?: ToolChoice): OpenAIResponsesToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "computer") return { type: "computer" };
	const name = extractFunctionName(choice);
	return name ? { type: "function", name } : undefined;
}

/**
 * Map unified ToolChoice to Anthropic-compatible format.
 * - "required" → "any"
 * - { type: "function", ... } → { type: "tool", name }
 */
export function mapToAnthropicToolChoice(choice?: ToolChoice): AnthropicToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "tool", name } : undefined;
}
