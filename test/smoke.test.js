import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEnv } from "../lib/env-parse.js";
import { makeIsAllowedDir } from "../lib/paths.js";
import { createRingBuffer } from "../lib/sessions.js";
import { identifyServer } from "../lib/dev-servers.js";

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------
test("parseEnv reads simple KEY=value", () => {
  const result = parseEnv("FOO=bar\nBAZ=qux", new Set(["FOO", "BAZ"]));
  assert.equal(result.FOO, "bar");
  assert.equal(result.BAZ, "qux");
});

test("parseEnv strips inline comments on unquoted values", () => {
  const result = parseEnv("FOO=bar # trailing comment", new Set(["FOO"]));
  assert.equal(result.FOO, "bar");
});

test("parseEnv preserves '#' inside quoted values", () => {
  const result = parseEnv('FOO="bar#baz"', new Set(["FOO"]));
  assert.equal(result.FOO, "bar#baz");
});

test("parseEnv rejects keys not in validKeys", () => {
  const result = parseEnv("FOO=bar\nUNKNOWN=x", new Set(["FOO"]));
  assert.equal(result.FOO, "bar");
  assert.equal(result.UNKNOWN, undefined);
});

test("parseEnv skips comment-only and blank lines", () => {
  const result = parseEnv("# header\n\nFOO=bar\n", new Set(["FOO"]));
  assert.equal(result.FOO, "bar");
});

test("parseEnv handles CRLF line endings", () => {
  const result = parseEnv("FOO=bar\r\nBAZ=qux\r\n", new Set(["FOO", "BAZ"]));
  assert.equal(result.FOO, "bar");
  assert.equal(result.BAZ, "qux");
});

// ---------------------------------------------------------------------------
// makeIsAllowedDir
// ---------------------------------------------------------------------------
test("isAllowedDir allows subdirectories of prefix", () => {
  const isAllowed = makeIsAllowedDir(["/home/user/projects"]);
  assert.equal(isAllowed("/home/user/projects"), true);
  assert.equal(isAllowed("/home/user/projects/foo"), true);
  assert.equal(isAllowed("/home/user/projects/foo/bar"), true);
});

test("isAllowedDir rejects siblings and parents", () => {
  const isAllowed = makeIsAllowedDir(["/home/user/projects"]);
  assert.equal(isAllowed("/home/user"), false);
  assert.equal(isAllowed("/home/user/projects-other"), false);
  assert.equal(isAllowed("/etc"), false);
});

test("isAllowedDir supports multiple prefixes", () => {
  const isAllowed = makeIsAllowedDir(["/a", "/b"]);
  assert.equal(isAllowed("/a/x"), true);
  assert.equal(isAllowed("/b/y"), true);
  assert.equal(isAllowed("/c"), false);
});

// ---------------------------------------------------------------------------
// createRingBuffer
// ---------------------------------------------------------------------------
test("ring buffer truncates to maxBytes", () => {
  const buf = createRingBuffer(10);
  buf.append("abcdefghij");
  assert.equal(buf.toString(), "abcdefghij");
  buf.append("KLMN");
  assert.equal(buf.toString(), "efghijKLMN");
  assert.equal(buf.length, 10);
});

test("ring buffer handles single oversized append", () => {
  const buf = createRingBuffer(5);
  buf.append("0123456789");
  assert.equal(buf.toString(), "56789");
});

// ---------------------------------------------------------------------------
// identifyServer
// ---------------------------------------------------------------------------
test("identifyServer returns null on null probe", () => {
  assert.equal(identifyServer(null), null);
});

test("identifyServer detects Vite", () => {
  const probe = { port: 5173, headers: {}, body: "<script type=\"module\" src=\"/@vite/client\"></script>" };
  const result = identifyServer(probe);
  assert.equal(result.type, "vite");
});

test("identifyServer detects FastAPI via Uvicorn", () => {
  const probe = { port: 8000, headers: { server: "uvicorn" }, body: "" };
  const result = identifyServer(probe);
  assert.equal(result.type, "fastapi");
});

test("identifyServer detects Expo via Metro", () => {
  const probe = { port: 8081, headers: {}, body: "expo metro bundler" };
  const result = identifyServer(probe);
  assert.equal(result.type, "expo");
});

test("identifyServer falls back to unknown", () => {
  const probe = { port: 9999, headers: {}, body: "some random response" };
  const result = identifyServer(probe);
  assert.equal(result.type, "unknown");
});
