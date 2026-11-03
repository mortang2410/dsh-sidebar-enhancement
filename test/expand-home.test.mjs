/**
 * Contract test for the two pure helpers that decide which file the document
 * renderer opens and whether it may be saved.
 *
 * `client.js` is not an importable module: it is a browser bundle that calls
 * `window.__ModuleLoader__.load(...)` at top level, so `require` of it would
 * fail outside the harness. The helpers are therefore sliced out of the real
 * source text, which also means this test fails loudly if either helper is
 * renamed or removed rather than silently testing nothing.
 *
 * Run with `node --test test/`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, "client.js");
const source = readFileSync(CLIENT, "utf8");

/** Evaluate top-level function declarations, by name, out of the bundle. */
function helper(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from client.js`);
  let depth = 0;
  let index = source.indexOf("{", start);
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} has no closing brace in client.js`);
}

/**
 * The helpers depend on each other (`expandHomePrefix` joins with `childPath`,
 * `insideWorkspace` normalizes with `normalizeAbsolutePath`), so they are
 * evaluated together in one scope rather than separately; a slice that lost a
 * dependency would throw here instead of silently testing nothing.
 */
const { childPath, expandHomePrefix, insideWorkspace, normalizeAbsolutePath, editorStatusKey, editorHintKey } = new Function(
  `${helper("childPath")}\n${helper("normalizeAbsolutePath")}\n${helper("expandHomePrefix")}\n${helper("insideWorkspace")}\n${helper("editorStatusKey")}\n${helper("editorHintKey")}\nreturn { childPath, expandHomePrefix, insideWorkspace, normalizeAbsolutePath, editorStatusKey, editorHintKey };`,
)();

const HOME = "/home/wilder";
const CWD = "/home/wilder/.dsh";

test("a leading ~/ becomes the Host home directory", () => {
  assert.equal(expandHomePrefix("~/Trash/a.md", HOME), "/home/wilder/Trash/a.md");
  assert.equal(expandHomePrefix("~/a/b/c.txt", HOME), "/home/wilder/a/b/c.txt");
});

test("the bare shorthand and its slash form both name the home directory", () => {
  assert.equal(expandHomePrefix("~", HOME), HOME);
  assert.equal(expandHomePrefix("~/", HOME), HOME);
});

test("a repeated separator after the shorthand collapses", () => {
  assert.equal(expandHomePrefix("~//a.md", HOME), "/home/wilder/a.md");
});

test("a user name or an interior tilde is left alone", () => {
  assert.equal(expandHomePrefix("~other/x.md", HOME), "~other/x.md");
  assert.equal(expandHomePrefix("a/~/b.md", HOME), "a/~/b.md");
});

test("an already absolute or plain relative path is left alone", () => {
  assert.equal(expandHomePrefix("/home/wilder/Trash/a.md", HOME), "/home/wilder/Trash/a.md");
  assert.equal(expandHomePrefix("notes/x.md", HOME), "notes/x.md");
  assert.equal(expandHomePrefix("", HOME), "");
});

test("an unknown or empty home directory leaves the path as written", () => {
  assert.equal(expandHomePrefix("~/a.md", undefined), "~/a.md");
  assert.equal(expandHomePrefix("~/a.md", null), "~/a.md");
  assert.equal(expandHomePrefix("~/a.md", ""), "~/a.md");
});

test("a home directory with its own separators still joins correctly", () => {
  assert.equal(expandHomePrefix("~/a.md", "/home/wilder/"), "/home/wilder/a.md");
  assert.equal(expandHomePrefix("~/a.md", "C:\\Users\\w"), "C:/Users/w/a.md");
});

test("the editor's join resolves the reported failing click", () => {
  // Mirrors the component: expand first, then keep an absolute result and join
  // only a relative one. Joining after expansion would double the root.
  const resolve = (address, home, cwd) => {
    const raw = expandHomePrefix(address.replace(/\\/g, "/"), home);
    return raw.startsWith("/") ? raw : childPath(cwd, raw);
  };
  assert.equal(
    resolve("~/Trash/disk-cleanup-tier1-2026-11-01/investigation/01-bifrost-self-kills.md", HOME, CWD),
    "/home/wilder/Trash/disk-cleanup-tier1-2026-11-01/investigation/01-bifrost-self-kills.md",
  );
  assert.equal(resolve("notes/x.md", HOME, CWD), "/home/wilder/.dsh/notes/x.md");
});

test("the pre-fix join is what the fix replaces", () => {
  const address = "~/Trash/a.md";
  assert.equal(childPath(CWD, address), "/home/wilder/.dsh/~/Trash/a.md");
});

test("a target inside the workspace counts as writable, one outside does not", () => {
  assert.equal(insideWorkspace("/home/wilder/.dsh/notes/a.md", CWD), true);
  assert.equal(insideWorkspace("/home/wilder/Trash/a.md", CWD), false);
  assert.equal(insideWorkspace("/home/wilder/.dshother/a.md", CWD), false);
  assert.equal(insideWorkspace("/home/wilder/.dsh/a.md", `${CWD}/`), true);
});

test("the root itself is not writable, because the Host's save gate refuses it", () => {
  // `resolveInside` rejects an empty relative path, so the pane must agree.
  assert.equal(insideWorkspace(CWD, CWD), false);
});

test("a Windows case variant of an in-workspace path stays writable", () => {
  // The Host compares with `path.relative`, which folds case on win32.
  assert.equal(insideWorkspace("c:\\users\\wilder\\.dsh\\notes\\a.md", "C:\\Users\\Wilder\\.dsh"), true);
  assert.equal(insideWorkspace("C:/Users/Wilder/.dsh/notes/a.md", "c:/users/wilder/.dsh"), true);
  assert.equal(insideWorkspace("c:\\users\\wilder\\.dshother\\a.md", "C:\\Users\\Wilder\\.dsh"), false);
});

test("a traversal segment cannot walk a path out of the workspace", () => {
  // The Host resolves before it tests containment, so the pane must agree.
  assert.equal(insideWorkspace(`${CWD}/../Trash/a.md`, CWD), false);
  assert.equal(insideWorkspace(`${CWD}/a/../../Trash/a.md`, CWD), false);
  assert.equal(insideWorkspace(`${CWD}/notes/../a.md`, CWD), true);
  assert.equal(insideWorkspace(`${CWD}/./notes/a.md`, CWD), true);
  assert.equal(normalizeAbsolutePath(`${CWD}//a/./b/../c.md`), `${CWD}/a/c.md`);
});

test("a root of / contains every descendant, the way the Host gate does", () => {
  // `path.relative("/", "/home/wilder/a.md")` is a plain relative path, so the
  // Host save route accepts it; the pane must not claim a target is read-only.
  assert.equal(insideWorkspace("/home/wilder/a.md", "/"), true);
  assert.equal(insideWorkspace("/home/wilder/a.md", ""), false);
});

test("an unknown root or target is never treated as writable", () => {
  assert.equal(insideWorkspace(undefined, CWD), false);
  assert.equal(insideWorkspace("/home/wilder/.dsh/a.md", undefined), false);
  assert.equal(insideWorkspace("/a.md", ""), false);
  assert.equal(insideWorkspace("", CWD), false);
});

test("the editor wires the Host-resolved workspace root into the writable decision", () => {
  // The pure-helper tests above cannot fail if the component stops calling
  // them, so the wiring is pinned here: the root comes from the Host lookup
  // (which carries the no-cwd fallback), never from the session summary alone.
  const body = source.slice(source.indexOf("function EditorBody("));
  assert.match(body, /useWorkspaceRoot\(useSessions, fileSessionId, face\)/);
  assert.match(body, /insideWorkspace\(absPath, root\)/);
  assert.doesNotMatch(body, /byId\[fileSessionId\]\?\.cwd/);
});

test("the status line never reports an edit for a read-only target", () => {
  assert.equal(editorStatusKey(false, false, true), "editor.readOnly");
  assert.equal(editorStatusKey(false, true, true), "editor.readOnly");
  assert.equal(editorStatusKey(true, true, true), "editor.saving");
  assert.equal(editorStatusKey(true, false, true), "editor.dirty");
  assert.equal(editorStatusKey(true, false, false), "editor.clean");
});

test("the hint explains the missing save button only when there is no button", () => {
  assert.equal(editorHintKey(true), "editor.hint");
  assert.equal(editorHintKey(false), "editor.outsideWorkspace");
});
