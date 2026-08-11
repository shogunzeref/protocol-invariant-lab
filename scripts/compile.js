// Bypasses Hardhat's compiler downloader (blocked: binaries.soliditylang.org)
// by using the npm-distributed solc package directly, then writing artifacts
// in the standard Hardhat artifact JSON shape so ethers/hardhat-ethers can
// load them normally via getContractFactory().
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");

function findSolFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSolFiles(full, out);
    else if (entry.name.endsWith(".sol")) out.push(full);
  }
  return out;
}

function toSourceName(absPath) {
  return "contracts/" + path.relative(CONTRACTS_DIR, absPath).split(path.sep).join("/");
}

const solFiles = findSolFiles(CONTRACTS_DIR);
const sources = {};
for (const f of solFiles) {
  sources[toSourceName(f)] = { content: fs.readFileSync(f, "utf8") };
}

function findImports(importPath) {
  // Resolve relative to contracts/ root since our sourceNames are "contracts/..."
  let candidate = importPath.startsWith("contracts/")
    ? path.join(__dirname, "..", importPath)
    : path.join(CONTRACTS_DIR, importPath);
  try {
    return { contents: fs.readFileSync(candidate, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "istanbul",
    outputSelection: {
      "*": {
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.bytecode.linkReferences",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.linkReferences",
        ],
      },
    },
  },
};

console.log(`Compiling ${solFiles.length} source files with solc ${solc.version()}...`);
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === "error") {
      hasError = true;
      console.error(err.formattedMessage);
    }
  }
}
if (hasError) {
  console.error("Compilation failed.");
  process.exit(1);
}

let count = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts || {})) {
  for (const [contractName, contract] of Object.entries(contracts)) {
    if (!contract.evm.bytecode.object) continue; // interfaces/abstract contracts
    const outDir = path.join(ARTIFACTS_DIR, sourceName);
    fs.mkdirSync(outDir, { recursive: true });
    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName,
      sourceName,
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
      deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
      linkReferences: contract.evm.bytecode.linkReferences || {},
      deployedLinkReferences: contract.evm.deployedBytecode.linkReferences || {},
    };
    fs.writeFileSync(path.join(outDir, contractName + ".json"), JSON.stringify(artifact, null, 2));
    count++;
  }
}
console.log(`Wrote ${count} artifacts to ${ARTIFACTS_DIR}`);
