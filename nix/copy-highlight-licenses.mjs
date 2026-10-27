import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const [sourceArg, destinationArg, runtimeArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
  throw new Error(
    "usage: node nix/copy-highlight-licenses.mjs <build-source> <license-output-dir>",
  );
}
const sourceRoot = resolve(sourceArg);
const destination = resolve(destinationArg);
const runtimeRoot = runtimeArg ? resolve(runtimeArg) : null;
const highlightDir = resolvePackage("@getpaseo/highlight", sourceRoot);
if (!highlightDir) throw new Error("Cannot resolve installed @getpaseo/highlight package");

function resolvePackage(name, fromDirectory) {
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(directory);
    if (parent === directory) return null;
  }
}

function licenseFiles(packageDirectory) {
  const files = [];
  const isLicense = (name) =>
    /^(?:license|licence|copying|notice|third[-_ ]party[-_ ]notices?)(?:[._ -].*)?$/i.test(name);
  for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
    if (entry.isFile() && isLicense(entry.name)) files.push(entry.name);
  }
  const bundled = join(packageDirectory, "licenses");
  if (existsSync(bundled)) {
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) files.push(relative(packageDirectory, file));
      }
    };
    walk(bundled);
  }
  return [...new Set(files)].sort();
}

const pending = [{ name: "@getpaseo/highlight", directory: highlightDir }];
const seen = new Set();
const packages = [];
while (pending.length) {
  const item = pending.shift();
  const packageDirectory = realpathSync(item.directory);
  if (seen.has(packageDirectory)) continue;
  seen.add(packageDirectory);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  // NFT traces executable modules, not declaration graphs. The plugin compiler
  // inspects type-only imports too, so retain the pinned package's declarations
  // and manifests without widening its runtime-boundary checks.
  if (runtimeRoot) {
    const packageRelative = relative(sourceRoot, packageDirectory);
    if (
      packageRelative.startsWith("..") ||
      resolve(sourceRoot, packageRelative) !== packageDirectory
    )
      throw new Error(`Highlight dependency outside build source: ${packageDirectory}`);
    const copyDeclarations = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") copyDeclarations(file);
        else if (
          entry.isFile() &&
          (/\.d\.[cm]?ts$/.test(entry.name) || entry.name === "package.json")
        ) {
          const target = join(runtimeRoot, relative(sourceRoot, file));
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(file, target);
        }
      }
    };
    copyDeclarations(packageDirectory);
  }
  const files = licenseFiles(packageDirectory);
  if (
    item.name === "@getpaseo/highlight" &&
    existsSync(join(packageDirectory, "src/astro/LICENSE"))
  ) {
    files.push("src/astro/LICENSE");
  }
  if (files.length === 0)
    throw new Error(`No license texts found for ${manifest.name}@${manifest.version}`);
  const packageOutput = `${manifest.name.replaceAll("/", "__")}@${manifest.version}`;
  const outputFiles = [];
  for (const file of [...new Set(files)].sort()) {
    const target = join(destination, packageOutput, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(packageDirectory, file), target);
    outputFiles.push(relative(destination, target).split(sep).join("/"));
  }
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? null,
    files: outputFiles,
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const dependencyDirectory = resolvePackage(dependency, packageDirectory);
    if (!dependencyDirectory)
      throw new Error(`Cannot resolve ${dependency}, declared by ${manifest.name}`);
    pending.push({ name: dependency, directory: dependencyDirectory });
  }
}

const paseoLicense = join(sourceRoot, "LICENSE");
if (!existsSync(paseoLicense)) throw new Error("Missing Paseo Apache license text");
mkdirSync(destination, { recursive: true });
copyFileSync(paseoLicense, join(destination, "PASEO-APACHE-2.0.txt"));
copyFileSync(join(highlightDir, "src/astro/LICENSE"), join(destination, "ASTRO-MIT.txt"));
writeFileSync(
  join(destination, "licenses.json"),
  `${JSON.stringify({ root: "@getpaseo/highlight", packages }, null, 2)}\n`,
);
console.log(`Copied license texts for ${packages.length} highlight packages`);
