// The repository's root package.json is what a git install reads (npm install github:endix-labs-v1/eta-sdk): it must say what
// typescript/package.json says, and point at files that exist.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const root = read("../../package.json");
const pkg = read("../package.json");

test("the root package.json matches typescript/package.json", () => {
  for (const field of ["name", "version", "description", "license", "type", "engines", "peerDependencies", "peerDependenciesMeta", "sideEffects"]) {
    assert.deepEqual(root[field], pkg[field], field);
  }
  assert.equal(root.private, true, "never published from the root");
  assert.equal(root.scripts, undefined, "no scripts: a git install runs no build");
  assert.equal(pkg.scripts.build, undefined, "no build script: npm would install devDependencies in every git-install clone");
});

test("the root package.json points at the built files", () => {
  for (const p of [root.main, root.types, root.exports["."].import, root.exports["."].types]) {
    assert.ok(p.startsWith("./typescript/dist/"), p);
    assert.ok(fs.existsSync(new URL(`../../${p}`, import.meta.url)), `${p} exists: run npm run compile`);
  }
});

test("dist/ is built from the current src/", () => {
  const src = fs.readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
  const dist = fs.readFileSync(new URL("../dist/version.js", import.meta.url), "utf8");
  assert.match(src, new RegExp(`"${pkg.version}"`), "src/version.ts has the package's version");
  assert.match(dist, new RegExp(`"${pkg.version}"`), "dist/version.js has the package's version");
});
