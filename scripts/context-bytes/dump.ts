#!/usr/bin/env bun
/**
 * Report where the bytes of a rejected-request dump (`~/.omp/logs/http-400-requests/*.json`)
 * go: the compact wire size of the body, its share per top-level field, per content
 * block type, and the heaviest messages. An HTTP 413 says the body was too big; this
 * says which part of it was.
 *
 *   bun scripts/context-bytes/dump.ts <dump.json> [--top N]
 */
import * as path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Totals = Map<string, { count: number; bytes: number }>;

function wireBytes(value: Json): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isObject(value: unknown): value is Record<string, Json> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addTo(totals: Totals, key: string, bytes: number): void {
	const entry = totals.get(key);
	if (entry) {
		entry.count++;
		entry.bytes += bytes;
	} else {
		totals.set(key, { count: 1, bytes });
	}
}

/** Every typed content block, including the ones nested inside tool results. */
function collectBlocks(value: Json | undefined, totals: Totals, depth: number): void {
	if (Array.isArray(value)) {
		for (const item of value) collectBlocks(item, totals, depth);
		return;
	}
	if (!isObject(value)) return;
	if (typeof value.type === "string" && depth > 0) addTo(totals, value.type, wireBytes(value));
	for (const [key, child] of Object.entries(value)) {
		if (key === "content" || Array.isArray(child)) collectBlocks(child, totals, depth + 1);
	}
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function usage(message: string): never {
	process.stderr.write(`${message}\nusage: bun scripts/context-bytes/dump.ts <dump.json> [--top N]\n`);
	process.exit(2);
}

function parseTop(args: string[]): number {
	const index = args.indexOf("--top");
	if (index < 0) return 10;
	const value = Number(args[index + 1]);
	if (!Number.isInteger(value) || value <= 0) {
		usage(`request-dump-bytes: --top needs a positive integer, got ${String(args[index + 1])}`);
	}
	return value;
}

const args = process.argv.slice(2);
const file = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--top");
if (!file) usage("request-dump-bytes: a dump file is required");
const top = parseTop(args);

let dump: Record<string, Json>;
try {
	dump = await Bun.file(file).json();
} catch (err) {
	usage(`request-dump-bytes: cannot read ${path.resolve(file)} as JSON: ${(err as Error).message}`);
}
const body = dump.body;
if (!isObject(body)) usage(`request-dump-bytes: ${path.resolve(file)} has no object "body"`);

const total = wireBytes(body);
const errorResponse = dump.errorResponse;
console.log(`provider=${String(dump.provider)} api=${String(dump.api)} model=${String(dump.model)}`);
if (isObject(errorResponse)) console.log(`status=${String(errorResponse.status)}`);
console.log(`body=${mib(total)} (${total} bytes, compact JSON)`);

console.log("\nbody fields:");
for (const [key, value] of Object.entries(body).sort((a, b) => wireBytes(b[1]) - wireBytes(a[1]))) {
	console.log(`  ${key.padEnd(24)} ${mib(wireBytes(value)).padStart(12)}`);
}

const blocks: Totals = new Map();
const messages = Array.isArray(body.messages) ? body.messages : body.input;
collectBlocks(messages, blocks, 0);
collectBlocks(body.system, blocks, 0);
console.log("\ncontent blocks by type (a nested block is also counted inside its parent):");
for (const [type, { count, bytes }] of [...blocks].sort((a, b) => b[1].bytes - a[1].bytes)) {
	console.log(`  ${type.padEnd(24)} ${String(count).padStart(6)} blocks ${mib(bytes).padStart(12)}`);
}

if (Array.isArray(messages)) {
	console.log(`\nheaviest ${top} of ${messages.length} messages:`);
	const ranked = messages.map((message, index) => ({ index, message, bytes: wireBytes(message) }));
	for (const { index, message, bytes } of ranked.sort((a, b) => b.bytes - a.bytes).slice(0, top)) {
		if (!isObject(message)) continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		const kinds = (parts.length > 0 ? parts : [message]).map(part => (isObject(part) ? String(part.type) : typeof part)).join(",");
		console.log(`  #${String(index).padStart(4)} ${String(message.role ?? message.type).padEnd(14)} ${mib(bytes).padStart(12)}  [${kinds.slice(0, 80)}]`);
	}
}
