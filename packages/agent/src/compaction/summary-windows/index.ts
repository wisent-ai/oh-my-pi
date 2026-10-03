/**
 * Fitting a span of conversation into the summarizer's window.
 *
 * Every local summarization call sends one serialized span of conversation. A
 * span can be larger than anything the summarizer accepts — one turn can hold
 * thousands of tool results and hook continuations — and a provider rejects
 * such a request whole, with no retry able to shrink it. Every summarizer
 * therefore goes through this module: a span that fits is sent as it is, one
 * that does not is folded window by window, each call carrying the summary out
 * of the previous one.
 */

import type { Message, Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { Tokenizer } from "../../tokenizer";
import { serializeConversationForSummary } from "../utils";

/**
 * Fallback window for a model whose catalog entry carries no usable context
 * window; matches the smallest window any compaction-capable model ships with.
 */
const DEFAULT_SUMMARY_INPUT_WINDOW = 200_000;

/**
 * Floor for one summarization window, so a tiny model still makes progress.
 * Scaled down (never below 1k) for models whose window cannot host the full
 * floor next to the carried summary and output reserves.
 */
const MIN_SUMMARY_INPUT_TOKENS = 16_384;

/** Smallest window worth planning for `model`; below this, overflow recovery gives up. */
function minSummaryInputTokens(model: Model): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	return Math.min(MIN_SUMMARY_INPUT_TOKENS, Math.max(1_024, Math.floor(window / 8)));
}

/**
 * Usable conversation input for ONE summarization call: the summarizer's window
 * minus the summary it must emit, the carried summary it may bring forward, and
 * prompt scaffolding. Providers tokenize differently from the local cl100k
 * estimate, so the window is discounted before the fixed reserves come off.
 */
function summaryInputBudgetTokens(model: Model, maxTokens: number, carriedTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	// 0.8, not "window minus reserves": provider tokenizers disagree with the
	// local cl100k estimate by a few percent, and being wrong here is a hard
	// 400 on the one call that is supposed to rescue an oversized session.
	return Math.max(minSummaryInputTokens(model), Math.floor(window * 0.8) - maxTokens - carriedTokens);
}

/** How many characters of `text` fit `budgetTokens`, given its exact token count. */
function charactersWithinBudget(text: string, budgetTokens: number, tokens: number): number {
	return Math.max(1024, Math.floor((text.length * budgetTokens * 0.95) / tokens));
}

/**
 * Clamp one serialized window to the budget. Only reachable when a SINGLE
 * message serializes above the budget (an oversized paste): the alternative is
 * a provider rejection that no retry can clear, which strands the session with
 * a full window forever.
 */
function clampConversationToBudget(text: string, budgetTokens: number, tokens: number): string {
	if (tokens <= budgetTokens) return text;
	const keep = charactersWithinBudget(text, budgetTokens, tokens);
	if (keep >= text.length) return text;
	return `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`;
}

/** One planned summarization call: its messages and the budget they were packed for. */
interface SummaryWindow {
	messages: Message[];
	budgetTokens: number;
	/** Serialization reused from the fit check, so the common path serializes once. */
	text?: string;
}

/**
 * Partition a conversation into windows that each fit `budgetTokens`, splitting
 * on message boundaries. Only called when the whole conversation does not fit —
 * the common single-window path never pays this per-message sizing pass.
 */
function planSummaryWindows(
	messages: Message[],
	tokenizer: Tokenizer,
	dialect: Dialect | undefined,
	budgetTokens: number,
): Message[][] {
	const windows: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = tokenizer.countTokens(serializeConversationForSummary([message], dialect));
		if (currentTokens > 0 && currentTokens + tokens > budgetTokens) {
			windows.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

/** One summarization call over one window's serialized text and the summary carried into it. */
export type SummarizeWindow = (conversationText: string, carried: string | undefined) => Promise<string>;

/**
 * Summarize `messages` in as many calls as the summarizer's window requires.
 *
 * `carriedTokens` reserves room for the summary each call brings forward (the
 * previous summary the first call receives, or the output of the call before).
 * Returns the summary out of the last call, or `carried` when there was nothing
 * to summarize.
 */
export async function foldSummaryWindows(
	messages: Message[],
	model: Model,
	maxTokens: number,
	carriedTokens: number,
	carried: string | undefined,
	summarize: SummarizeWindow,
): Promise<string | undefined> {
	const dialect = preferredDialect(model.id);
	const tokenizer = new Tokenizer(model);
	const wholeConversation = serializeConversationForSummary(messages, dialect);
	const budgetTokens = summaryInputBudgetTokens(model, maxTokens, carriedTokens);
	// One window is the common case and costs exactly the one call it always did.
	const pending: SummaryWindow[] = tokenizer.checkTokenBudget(wholeConversation, budgetTokens).fits
		? [{ messages, budgetTokens, text: wholeConversation }]
		: planSummaryWindows(messages, tokenizer, dialect, budgetTokens).map(window => ({
				messages: window,
				budgetTokens,
			}));

	let summary = carried;
	while (pending.length > 0) {
		const window = pending[0];
		const text = window.text ?? serializeConversationForSummary(window.messages, dialect);
		// A budget probe, not a raw count: a window whose bytes already fit needs
		// neither an exact count nor the clamp, and the bust path hands back the
		// exact count the proportional clamp needs as its denominator.
		const budget = tokenizer.checkTokenBudget(text, window.budgetTokens);
		try {
			summary = await summarize(
				budget.fits ? text : clampConversationToBudget(text, window.budgetTokens, budget.tokens),
				summary,
			);
		} catch (error) {
			// The catalog window can overstate what the provider actually accepts:
			// `claude-sonnet-4-5` advertises 1M but is beta-gated to 200k on OAuth
			// credentials (see `anthropic.ts` — the 1M beta is never advertised).
			// Halve what was actually SENT, not the budget it was planned against:
			// the rejection proves the plan was fiction, so converging on the real
			// cap must not spend a call per level of an imaginary ladder. The cheap
			// fit path never counted this window, so pay for the exact size here —
			// one tokenization is nothing against the provider round trip already lost.
			const sentTokens = budget.exact ? budget.tokens : tokenizer.countTokens(text, "strict");
			const halved = Math.floor(Math.min(window.budgetTokens, sentTokens) / 2);
			if (!AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow) || halved < minSummaryInputTokens(model)) {
				throw error;
			}
			pending.splice(
				0,
				1,
				...planSummaryWindows(window.messages, tokenizer, dialect, halved).map(messages => ({
					messages,
					budgetTokens: halved,
				})),
			);
			continue;
		}
		pending.shift();
	}
	return summary;
}

/**
 * The serialization of `messages` clamped to one summarizer call, for a call
 * that must stay a single request: a short summary is one bounded answer, not a
 * fold. The clamp keeps the most recent text, which is what a short summary of
 * recent work is about.
 */
export function fitConversationText(messages: Message[], model: Model, maxTokens: number, carriedTokens: number): string {
	const tokenizer = new Tokenizer(model);
	const text = serializeConversationForSummary(messages, preferredDialect(model.id));
	const budgetTokens = summaryInputBudgetTokens(model, maxTokens, carriedTokens);
	const budget = tokenizer.checkTokenBudget(text, budgetTokens);
	if (budget.fits) return text;
	const keep = charactersWithinBudget(text, budgetTokens, budget.tokens);
	if (keep >= text.length) return text;
	return `[... ${text.length - keep} earlier characters truncated]\n\n${text.slice(text.length - keep)}`;
}
