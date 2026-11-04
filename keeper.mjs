import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const PK = process.env.KEEPER_PK;
const LOTTERY = process.env.LOTTERY_ADDRESS;
const PROVIDER = process.env.PROVIDER_ADDRESS;
const SEED_SECRET = process.env.SEED_SECRET;
const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const AHEAD = Number(process.env.COMMIT_AHEAD || 5);

if (!PK) { console.error("缺少 KEEPER_PK"); process.exit(1); }
if (!LOTTERY || !PROVIDER) { console.error("缺少 LOTTERY_ADDRESS / PROVIDER_ADDRESS"); process.exit(1); }
if (!SEED_SECRET) { console.error("缺少 SEED_SECRET"); process.exit(1); }

const STATUS = ["NONE", "OPEN", "CALLING", "SETTLED", "STUCK"];
const L_ABI = parseAbi([
  "function currentRound() view returns (uint256)",
  "function roundInfo(uint256) view returns (uint64 openAt, uint64 closeAt, uint32 tickets, uint32 target, uint8 status, uint256 pot, address first, uint256 firstAmt, uint256 secondEach, uint16 rollBps)",
  "function closeRound()",
]);
const P_ABI = parseAbi([
  "function commitOf(uint256) view returns (bytes32)",
  "function roundOpenAt(uint256) view returns (uint64)",
  "function commit(uint256,bytes32)",
  "function reveal(uint256,uint256)",
]);

const account = privateKeyToAccount(PK.startsWith("0x") ? PK : "0x" + PK);
const pub = createPublicClient({ transport: http(RPC, { timeout: 25000, retryCount: 2 }) });
const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC) });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);

const seedOf = (id) => BigInt(keccak256(encodePacked(["bytes32", "uint256"], [SEED_SECRET, id])));
const commitOf = (id) => keccak256(encodePacked(["uint256", "uint256"], [seedOf(id), id]));

async function send(addr, abi, fn, args) {
  const h = await wallet.writeContract({ address: addr, abi, functionName: fn, args });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  log(`  ${fn} → ${rc.status} tx=${h}`);
  return rc.status === "success";
}

async function main() {
  const cur = await pub.readContract({ address: LOTTERY, abi: L_ABI, functionName: "currentRound" });
  const r = await pub.readContract({ address: LOTTERY, abi: L_ABI, functionName: "roundInfo", args: [cur] });
  const status = Number(r[4]);

  // 1) 提前提交未来轮次的承诺
  for (let i = 0; i < AHEAD; i++) {
    const id = cur + BigInt(i);
    const openAt = await pub.readContract({ address: PROVIDER, abi: P_ABI, functionName: "roundOpenAt", args: [id] });
    if (now() >= Number(openAt)) continue;
    const existing = await pub.readContract({ address: PROVIDER, abi: P_ABI, functionName: "commitOf", args: [id] });
    if (existing !== "0x" + "0".repeat(64)) continue;
    log(`提交承诺 #${id}`);
    await send(PROVIDER, P_ABI, "commit", [id, commitOf(id)]);
  }

  // 2) 到点关轮
  if (status === 1 && now() >= Number(r[1])) {
    log(`关轮 #${cur}（tickets=${r[2]}）`);
    await send(LOTTERY, L_ABI, "closeRound");
    return;
  }

  // 3) 揭示
  if (status === 2) {
    const has = await pub.readContract({ address: PROVIDER, abi: P_ABI, functionName: "commitOf", args: [cur] });
    if (has === "0x" + "0".repeat(64)) { log(`#${cur} 处于 CALLING 但没有承诺，无法揭示（需人工处理）`); return; }
    log(`揭示 #${cur}`);
    await send(PROVIDER, P_ABI, "reveal", [cur, seedOf(cur)]);
    return;
  }

  log(`#${cur} ${STATUS[status]}，距关轮 ${Number(relay(r[1]))}s，无事可做`);
}

const relay = (x) => Number(x) - now();

main().catch((e) => { console.error("✗", e.shortMessage || e.message); process.exit(1); });
