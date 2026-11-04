// 战报 bot：轮次结算后把结果发到 Telegram
// 由 report.yml 每 5 分钟调用；已发过的轮次记录在 .report-state.json（workflow 里用 cache 持久化）
import fs from "node:fs";
import { createPublicClient, http, parseAbi, formatEther } from "viem";

const LOTTERY = process.env.LOTTERY_ADDRESS;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const SITE = process.env.SITE_URL || "https://streak.pangusys.com";
const STATE = ".report-state.json";

if (!LOTTERY) { console.error("缺少 LOTTERY_ADDRESS"); process.exit(1); }

const pub = createPublicClient({ transport: http(RPC, { timeout: 25000, retryCount: 2 }) });
const ABI = parseAbi([
  "function currentRound() view returns (uint256)",
  "function roundInfo(uint256) view returns (uint64 openAt,uint64 closeAt,uint32 tickets,uint32 target,uint8 status,uint256 pot,address first,uint256 firstAmt,uint256 secondEach,uint16 rollBps)",
  "function roundProof(uint256) view returns (uint256 requestId,uint256 random,address firstWinner,address grandWinner,uint256 grandAmt,uint256 pot,uint32 tickets,uint32 target,uint8 status)",
  "function jackpot() view returns (uint256)",
]);

const sent = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { rounds: [] };
const short = (a) => (a && a.length > 10 ? a.slice(0, 6) + "…" + a.slice(-4) : a);
const fmt = (x) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function post(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("（未配置 TG_TOKEN/TG_CHAT，只打印不发）\n" + text); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("Telegram: " + (j.description || "unknown"));
  console.log("✓ 已发送到 Telegram");
}

const cur = await pub.readContract({ address: LOTTERY, abi: ABI, functionName: "currentRound" });
let posted = 0;

for (let i = 1; i <= 6; i++) {
  if (cur - BigInt(i) < 0n) break;
  const id = cur - BigInt(i);
  if (sent.rounds.includes(Number(id))) continue;

  const p = await pub.readContract({ address: LOTTERY, abi: ABI, functionName: "roundProof", args: [id] });
  if (Number(p[8]) !== 3) continue; // 未结算

  const info = await pub.readContract({ address: LOTTERY, abi: ABI, functionName: "roundInfo", args: [id] });
  const jackpot = await pub.readContract({ address: LOTTERY, abi: ABI, functionName: "jackpot" });
  const pot = Number(formatEther(p[5]));
  const tickets = Number(p[6]);
  const target = Number(p[7]);
  const empty = tickets === 0;

  const text = empty
    ? `<b>STREAK · 第 ${id} 轮</b>\n\n本轮 0 人买票，按规则直接结算——轮次永不取消。\n\n余烬奖池：${fmt(formatEther(jackpot))} USDT\n下一轮已开启，24 小时后开奖。\n\n${SITE}`
    : `<b>STREAK · 第 ${id} 轮开奖</b>\n\n票数：${tickets} / ${target}\n奖池：${fmt(pot)} USDT\n一等奖：${fmt(formatEther(info[7]))} USDT → <code>${short(p[2])}</code>` +
      (Number(p[4]) > 0n ? `\n余烬派发：${fmt(formatEther(p[4]))} → <code>${short(p[3])}</code>` : "") +
      `\n余烬奖池：${fmt(formatEther(jackpot))} USDT\n\n随机种子：<code>${p[1].toString().slice(0, 16)}…</code>\n任何人都可用 roundProof 复算结果。\n\n${SITE}`;

  await post(text);
  sent.rounds.push(Number(id));
  posted++;
}

fs.writeFileSync(STATE, JSON.stringify({ rounds: sent.rounds.slice(-50) }));
console.log(posted ? `本次发送 ${posted} 条战报` : "没有新的已结算轮次");
