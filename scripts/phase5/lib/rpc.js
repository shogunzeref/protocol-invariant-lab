// Read-only JSON-RPC + ABI helpers for the Phase 5 (Morpho Blue + Pendle PT)
// market reconnaissance scripts.
//
// STRICTLY READ-ONLY: this module only ever issues `eth_call`, `eth_chainId`
// and `eth_blockNumber`. There is no signer, no private key, no
// `eth_sendTransaction`/`eth_sendRawTransaction` path anywhere in it, so no
// script built on it can mutate live protocol state.

const { keccak256, toUtf8Bytes, AbiCoder } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();

// Public, keyless endpoints. Several are listed per chain because public
// endpoints rate-limit aggressively; calls fall through the list in order.
const RPC_ENDPOINTS = {
  1: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.merkle.io",
    "https://eth.drpc.org",
    "https://rpc.mevblocker.io",
    "https://eth-mainnet.public.blastapi.io",
  ],
  42161: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  8453: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  130: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
  143: ["https://rpc.monad.xyz"],
  999: ["https://rpc.hyperliquid.xyz/evm"],
  747474: ["https://rpc.katana.network"],
};

const CHAIN_NAMES = {
  1: "ethereum",
  42161: "arbitrum",
  8453: "base",
  130: "unichain",
  143: "monad",
  999: "hyperevm",
  747474: "katana",
};

function selector(signature) {
  return keccak256(toUtf8Bytes(signature)).slice(0, 10);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function rpc(chainId, method, params) {
  const urls = RPC_ENDPOINTS[chainId];
  if (!urls) return { ok: false, error: `no endpoint configured for chain ${chainId}` };
  let last = "unreachable";
  for (const url of urls) {
    let json;
    try {
      json = await post(url, { jsonrpc: "2.0", id: 1, method, params });
    } catch (e) {
      last = `${url}: ${e.message}`;
      continue;
    }
    if (json.error) {
      // A revert is a definitive answer from a working node -- the call is
      // simply not supported by that contract. Do not fall through to the
      // next endpoint, or a probe would take len(urls) round-trips per miss.
      return { ok: false, error: json.error.message, reverted: true };
    }
    return { ok: true, result: json.result };
  }
  return { ok: false, error: last };
}

// Calls `signature` on `to` and abi-decodes the return data as `outputTypes`.
// Returns { ok: false } instead of throwing when the call reverts, since the
// probes below deliberately call functions that only exist on some of the
// candidate contract shapes.
async function call(chainId, to, signature, outputTypes, args = [], argTypes = []) {
  let data = selector(signature);
  if (args.length) data += coder.encode(argTypes, args).slice(2);
  const r = await rpc(chainId, "eth_call", [{ to, data }, "latest"]);
  if (!r.ok) return r;
  if (!r.result || r.result === "0x") return { ok: false, error: "empty return data" };
  try {
    const decoded = coder.decode(outputTypes, r.result);
    return { ok: true, value: outputTypes.length === 1 ? decoded[0] : decoded, raw: r.result };
  } catch (e) {
    return { ok: false, error: `decode failed: ${e.message}`, raw: r.result };
  }
}

async function blockNumber(chainId) {
  const r = await rpc(chainId, "eth_blockNumber", []);
  return r.ok ? Number(BigInt(r.result)) : null;
}

module.exports = { rpc, call, selector, blockNumber, RPC_ENDPOINTS, CHAIN_NAMES };
