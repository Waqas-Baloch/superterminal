import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { homeDir } from "./paths";
import type { AgentCliId } from "./globalConfig";

// The limit ledger: when did each vendor last refuse work because a usage
// limit was hit. This is the honest version of a "fuel gauge" — no vendor
// exposes remaining quota, so any gauge would be fiction. What IS knowable is
// the moment a limit error occurs. Failover uses this as a cooldown (don't
// hand work to an agent that just refused it), and `doctor` shows it as fact.

const COOLDOWN_MS = 30 * 60 * 1000; // vendors' windows vary; 30min is a safe floor

type Ledger = Partial<Record<AgentCliId, string>>; // agent → ISO time of last limit hit

function file(): string {
  return nodePath.join(homeDir(), "limits.json");
}

async function read(): Promise<Ledger> {
  try {
    const raw = JSON.parse(await fs.readFile(file(), "utf8"));
    return typeof raw === "object" && raw ? (raw as Ledger) : {};
  } catch {
    return {};
  }
}

export async function recordLimit(agent: AgentCliId): Promise<void> {
  try {
    const ledger = await read();
    ledger[agent] = new Date().toISOString();
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* bookkeeping must never break a run */
  }
}

/** ISO time this agent last hit its limit, or null. */
export async function lastLimit(agent: AgentCliId): Promise<string | null> {
  return (await read())[agent] ?? null;
}

/** Did this agent hit a limit recently enough that we shouldn't route to it? */
export async function inCooldown(agent: AgentCliId, now = Date.now()): Promise<boolean> {
  const at = (await read())[agent];
  if (!at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && now - t < COOLDOWN_MS;
}

/** "32m ago" — for doctor's status line. */
export function agoLabel(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}
