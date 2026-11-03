/**
 * Contract test for the helpers that decide which file the document renderer
 * opens and whether it may be saved.
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
import { dirname, join, win32 as win32Path, posix as posixPath } from "node:path";
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
 * `insideWorkspace` splits with `pathParts` and `isWindowsRoot`), so they are
 * evaluated together in one scope rather than separately; a slice that lost a
 * dependency would throw here instead of silently testing nothing.
 */
const { childPath, expandHomePrefix, insideWorkspace, editorStatusKey, editorHintKey } = new Function(
  `${helper("childPath")}\n${helper("isWindowsRoot")}\n${helper("pathParts")}\n${helper("expandHomePrefix")}\n${helper("insideWorkspace")}\n${helper("editorStatusKey")}\n${helper("editorHintKey")}\nreturn { childPath, expandHomePrefix, insideWorkspace, editorStatusKey, editorHintKey };`,
)();

/**
 * The Host's save gate, from `resolveInside` in `index.js`: resolve both sides,
 * then refuse an empty, absolute or `..`-prefixed relative path. The platform
 * API is the one whose path syntax the pair uses. This is the oracle the pane
 * must agree with, so the test compares against the real `node:path` functions
 * rather than a second hand-written rule.
 */
function hostWritable(root, target, api) {
  const relative = api.relative(api.resolve(root), api.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

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

test("a drive root and a share root are compared the way win32 compares them", () => {
  // `path.win32.relative("C:\\", "c:\\users\\a.md")` is `users\\a.md`, so a
  // workspace at a drive root contains everything on that drive, and a share
  // root does the same for its share.
  assert.equal(insideWorkspace("c:\\users\\wilder\\a.md", "C:\\"), true);
  assert.equal(insideWorkspace("\\\\server\\share\\notes\\a.md", "\\\\SERVER\\Share"), true);
  assert.equal(insideWorkspace("\\\\server\\other\\a.md", "\\\\SERVER\\Share"), false);
  assert.equal(insideWorkspace("\\\\SERVER\\Share", "\\\\SERVER\\Share"), false);
});

test("the pane agrees with the Host's save gate on both path platforms", () => {
  // The oracle is `node:path`, the same functions the Host save route uses.
  const cases = [
    ["posix", "/home/wilder/.dsh", "/home/wilder/.dsh/notes/a.md", posixPath],
    ["posix", "/home/wilder/.dsh", "/home/wilder/Trash/a.md", posixPath],
    ["posix", "/home/wilder/.dsh", "/home/wilder/.dshother/a.md", posixPath],
    ["posix", "/home/wilder/.dsh", "/home/wilder/.dsh/../Trash/a.md", posixPath],
    ["posix", "/home/wilder/.dsh", "/home/wilder/.dsh", posixPath],
    ["posix", "/", "/home/wilder/a.md", posixPath],
    ["win32", "C:\\Users\\Wilder\\.dsh", "c:\\users\\wilder\\.dsh\\notes\\a.md", win32Path],
    ["win32", "C:\\Users\\Wilder\\.dsh", "D:\\notes\\a.md", win32Path],
    ["win32", "C:\\", "c:\\users\\wilder\\a.md", win32Path],
    ["win32", "\\\\SERVER\\Share", "\\\\server\\share\\notes\\a.md", win32Path],
    ["win32", "\\\\SERVER\\Share", "\\\\server\\other\\a.md", win32Path],
  ];
  for (const [platform, root, target, api] of cases) {
    assert.equal(insideWorkspace(target, root), hostWritable(root, target, api), `${platform} ${root} -> ${target}`);
  }
});

test("a traversal segment cannot walk a path out of the workspace", () => {
  // The Host resolves before it tests containment, so the pane must agree.
  assert.equal(insideWorkspace(`${CWD}/../Trash/a.md`, CWD), false);
  assert.equal(insideWorkspace(`${CWD}/a/../../Trash/a.md`, CWD), false);
  assert.equal(insideWorkspace(`${CWD}/notes/../a.md`, CWD), true);
  assert.equal(insideWorkspace(`${CWD}/./notes/a.md`, CWD), true);
  assert.equal(insideWorkspace(`${CWD}//a/./b/../c.md`, CWD), true);
  assert.equal(insideWorkspace(`${CWD}//a/./b/../c.md`, CWD), hostWritable(CWD, `${CWD}//a/./b/../c.md`, posixPath));
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
  // them, so the wiring is pinned here: the root comes from the Host lookup,
  // never from the session summary, and a relative address waits for it.
  const body = source.slice(source.indexOf("function EditorBody("));
  assert.match(body, /useWorkspaceRoot\(fileSessionId, face\)/);
  assert.match(body, /insideWorkspace\(absPath, root\)/);
  assert.match(body, /if \(!rootSettled\) return undefined;/);
  assert.doesNotMatch(body, /byId\[fileSessionId\]\?\.cwd/);
});

test("the Host answers a Windows / root with the drive root before the pane compares", () => {
  // `path.win32.resolve` turns a raw `/` into the current drive's root, which
  // is what the Host save gate resolves it to. The pane never sees the raw
  // spelling, and accepts a drive-qualified descendant of the resolved root.
  assert.equal(win32Path.resolve("C:\\work", "/"), "C:\\");
  const root = win32Path.resolve("C:\\work", "/");
  assert.equal(insideWorkspace("C:\\file.txt", root), true);
  assert.equal(insideWorkspace("C:\\file.txt", root), hostWritable(root, "C:\\file.txt", win32Path));
});

test("a root resolved for one Session never stands in for another", async () => {
  // A mounted editor keeps its state across an address change, so a cached root
  // from Session A must not make a path under A's workspace writable for B.
  const cells = [];
  let effectSlots = [];
  let slot = 0;
  const React = {
    useState: (initial) => {
      const at = slot++;
      if (!(at in cells)) cells[at] = initial;
      return [cells[at], (next) => { cells[at] = next; }];
    },
    useEffect: (fn) => { effectSlots.push(fn); },
  };
  const hook = new Function("React", `${helper("useWorkspaceRoot")}\nreturn useWorkspaceRoot;`)(React);
  const answers = [];
  const face = { workspaceRoot: () => new Promise((resolve) => { answers.push(resolve); }) };
  const render = (sessionId) => {
    slot = 0;
    effectSlots = [];
    const state = hook(sessionId, face);
    for (const start of effectSlots) start();
    return state;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const first = render("A");
  assert.equal(first.root, undefined, "no root before the Host answers");
  assert.equal(first.settled, false, "an unanswered lookup has not settled");
  answers.pop()({ ok: true, value: { workspaceRoot: "/work/projectA" } });
  await settle();
  assert.deepEqual(render("A"), { root: "/work/projectA", settled: true });

  const forB = render("B");
  assert.equal(forB.root, undefined, "A's root must not answer for B");
  assert.equal(forB.settled, false, "B's lookup is still pending");
  const answerForB = answers.pop();
  // The stale root is the dangerous state, so check it before and after a failure.
  assert.equal(render("B").root, undefined);
  answerForB({ ok: false, error: { code: "network", message: "unreachable" } });
  await settle();
  assert.deepEqual(render("B"), { root: undefined, settled: true }, "a failed lookup settles with no root");
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
