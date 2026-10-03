#!/usr/bin/env bun
/**
 * Report where the bytes of an omp session file (`~/.omp/agent/sessions/<cwd>/<id>.jsonl`)
 * go: by entry kind (entry type, message role, custom type), and by repeated text, so a
 * session that outgrew its provider's request limit shows what grew it.
 *
 *   bun scripts/context-bytes/session.ts <session.jsonl> [--top N]
 */
import * as path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Totals = Map<string, { count: number; bytes: number }>;

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

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function usage(message: string): never {
	process.stderr.write(`${message}\nusage: bun scripts/context-bytes/session.ts <session.jsonl> [--top N]\n`);
	process.exit(2);
}

function parseTop(args: string[]): number {
	const index = args.indexOf("--top");
	if (index < 0) return 15;
	const value = Number(args[index + 1]);
	if (!Number.isInteger(value) || value <= 0) {
		usage(`session-bytes: --top needs a positive integer, got ${String(args[index + 1])}`);
	}
	return value;
}

/** Entry type, then the message role and custom type when the entry carries them. */
function kindOf(entry: Record<string, Json>): string {
	const parts = [String(entry.type)];
	const message = entry.message;
	if (isObject(message) && typeof message.role === "string") parts.push(message.role);
	if (typeof entry.customType === "string") parts.push(entry.customType);
	if (isObject(message) && typeof message.customType === "string") parts.push(message.customType);
	return parts.join("/");
}

/** Text the entry carries, wherever it sits, so repeated injections can be grouped by their opening. */
function textsOf(value: Json | undefined, out: string[]): void {
	if (typeof value === "string") {
		if (value.length >= 4096) out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) textsOf(item, out);
		return;
	}
	if (isObject(value)) for (const child of Object.values(value)) textsOf(child, out);
}

const args = process.argv.slice(2);
const file = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--top");
if (!file) usage("session-bytes: a session file is required");
const top = parseTop(args);

let text: string;
try {
	text = await Bun.file(file).text();
} catch (err) {
	usage(`session-bytes: cannot read ${path.resolve(file)}: ${(err as Error).message}`);
}

const kinds: Totals = new Map();
const openings: Totals = new Map();
let total = 0;
let unparsed = 0;
for (const line of text.split("\n")) {
	if (line.length === 0) continue;
	const bytes = Buffer.byteLength(line, "utf8") + 1;
	total += bytes;
	let entry: Json;
	try {
		entry = JSON.parse(line);
	} catch {
		unparsed++;
		continue;
	}
	if (!isObject(entry)) continue;
	addTo(kinds, kindOf(entry), bytes);
	const texts: string[] = [];
	textsOf(entry, texts);
	for (const value of texts) addTo(openings, value.slice(0, 90).replaceAll("\n", " "), Buffer.byteLength(value, "utf8"));
}

console.log(`${path.resolve(file)}: ${mib(total)} in ${[...kinds.values()].reduce((n, k) => n + k.count, 0)} entries`);
if (unparsed > 0) console.log(`  ${unparsed} lines are not JSON`);
console.log("\nby entry kind:");
for (const [kind, { count, bytes }] of [...kinds].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)) {
	console.log(`  ${kind.padEnd(48)} ${String(count).padStart(7)} ${mib(bytes).padStart(12)}`);
}
console.log(`\nlargest groups of strings of 4 KiB or more, by their first 90 characters:`);
for (const [opening, { count, bytes }] of [...openings].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)) {
	console.log(`  ${String(count).padStart(6)}x ${mib(bytes).padStart(12)}  ${opening}`);
}
