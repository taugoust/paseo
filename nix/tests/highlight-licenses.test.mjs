import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
const directory = process.argv[2];
if (!directory) throw new Error("Pass the installed highlight license directory");
const manifest = JSON.parse(readFileSync(join(directory, "licenses.json"), "utf8"));
const packages = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]));

test("installed highlight bundle retains Paseo, Astro, and all transitive grammar license texts", () => {
  for (const file of ["PASEO-APACHE-2.0.txt", "ASTRO-MIT.txt"]) {
    const path = join(directory, file);
    assert.ok(existsSync(path), `missing ${file}`);
    assert.ok(statSync(path).size > 0, `empty ${file}`);
  }
  for (const name of [
    "@getpaseo/highlight",
    "@codemirror/language",
    "@codemirror/legacy-modes",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/cpp",
    "@lezer/css",
    "@lezer/go",
    "@lezer/highlight",
    "@lezer/html",
    "@lezer/java",
    "@lezer/javascript",
    "@lezer/json",
    "@lezer/lr",
    "@lezer/markdown",
    "@lezer/php",
    "@lezer/python",
    "@lezer/rust",
    "@lezer/xml",
    "@lezer/yaml",
    "lezer-elixir",
    "@marijn/find-cluster-break",
    "style-mod",
    "crelt",
    "w3c-keyname",
  ])
    assert.ok(packages.has(name), `license closure is missing ${name}`);
  for (const pkg of packages.values()) {
    assert.ok(pkg.files.length > 0, `${pkg.name} has no retained license files`);
    for (const file of pkg.files) {
      const path = join(directory, file);
      assert.ok(existsSync(path), `missing ${pkg.name} license file ${file}`);
      assert.ok(statSync(path).size > 0, `empty ${pkg.name} license file ${file}`);
    }
  }
});
