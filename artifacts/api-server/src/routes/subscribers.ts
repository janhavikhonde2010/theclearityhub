import { Router, type IRouter } from "express";
import {
  GetSubscribersQueryParams,
  GetDashboardSummaryQueryParams,
  GetAgentStatsQueryParams,
  GetSequenceStatsQueryParams,
  GetLabelStatsQueryParams,
} from "@workspace/api-zod";
import { fetchSubscribers, processSubscribers, fetchAccountInfo, type ProcessedSubscriber } from "../lib/twp-api";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// In-memory cache to avoid re-fetching on every stat endpoint call
const cache = new Map<string, { data: ProcessedSubscriber[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// In-flight promise deduplication — prevents all 6 simultaneous dashboard
// requests from each triggering their own processSubscribers() call when the
// cache is cold.
const inflight = new Map<string, Promise<ProcessedSubscriber[]>>();

function invalidateCache(apiToken: string, phoneNumberId: string): void {
  const key = `${apiToken}:${phoneNumberId}`;
  cache.delete(key);
  inflight.delete(key);
}

async function getProcessedSubscribers(apiToken: string, phoneNumberId: string): Promise<ProcessedSubscriber[]> {
  const key = `${apiToken}:${phoneNumberId}`;

  // Return cached result if still fresh
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // If a fetch is already in progress for this key, share its promise
  const existing = inflight.get(key);
  if (existing) return existing;

  // Start a new fetch and register it so concurrent callers can join
  const promise = (async () => {
    try {
      const rawSubs = await fetchSubscribers(apiToken, phoneNumberId);
      const processed = await processSubscribers(apiToken, phoneNumberId, rawSubs);
      cache.set(key, { data: processed, timestamp: Date.now() });
      return processed;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

router.get("/subscribers", async (req, res): Promise<void> => {
  const parsed = GetSubscribersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);
  res.json({ subscribers, total: subscribers.length });
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);

  const totalLeads = subscribers.length;
  const dormantLeads = subscribers.filter((s) => s.isDormant).length;
  const activeLeads = totalLeads - dormantLeads;
  const totalUserReplies = subscribers.reduce((sum, s) => sum + s.userReplyCount, 0);
  const totalTwpReplies = subscribers.reduce((sum, s) => sum + s.twpReplyCount, 0);
  const withSequences = subscribers.filter((s) => s.assignedSequence !== null);
  const totalSequencesSent = withSequences.length;
  const leadsReactivatedAfterSequence = withSequences.filter((s) => s.postSequenceReplies > 0).length;
  const reactivationRate =
    totalSequencesSent > 0
      ? Math.round((leadsReactivatedAfterSequence / totalSequencesSent) * 100 * 100) / 100
      : 0;

  res.json({
    totalLeads,
    dormantLeads,
    activeLeads,
    totalUserReplies,
    totalTwpReplies,
    totalSequencesSent,
    leadsReactivatedAfterSequence,
    reactivationRate,
  });
});

router.get("/dashboard/agent-stats", async (req, res): Promise<void> => {
  const parsed = GetAgentStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);

  const agentMap = new Map<string, { leads: ProcessedSubscriber[] }>();
  for (const sub of subscribers) {
    const agent = sub.assignedAgent ?? "Unassigned";
    if (!agentMap.has(agent)) agentMap.set(agent, { leads: [] });
    agentMap.get(agent)!.leads.push(sub);
  }

  const agents = Array.from(agentMap.entries()).map(([agentName, { leads }]) => {
    const activeLeads = leads.filter((l) => !l.isDormant).length;
    const dormantLeads = leads.filter((l) => l.isDormant).length;
    const avgUserReplies =
      leads.length > 0
        ? Math.round((leads.reduce((s, l) => s + l.userReplyCount, 0) / leads.length) * 100) / 100
        : 0;
    return {
      agentName,
      leadsAssigned: leads.length,
      activeLeads,
      dormantLeads,
      avgUserReplies,
    };
  });

  agents.sort((a, b) => b.leadsAssigned - a.leadsAssigned);
  res.json({ agents });
});

router.get("/dashboard/sequence-stats", async (req, res): Promise<void> => {
  const parsed = GetSequenceStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);

  const seqMap = new Map<string, { leads: ProcessedSubscriber[] }>();
  for (const sub of subscribers) {
    if (!sub.assignedSequence) continue;
    if (!seqMap.has(sub.assignedSequence)) seqMap.set(sub.assignedSequence, { leads: [] });
    seqMap.get(sub.assignedSequence)!.leads.push(sub);
  }

  const sequences = Array.from(seqMap.entries()).map(([sequenceName, { leads }]) => {
    const repliesAfterSequence = leads.filter((l) => l.postSequenceReplies > 0).length;
    const reactivationRate =
      leads.length > 0
        ? Math.round((repliesAfterSequence / leads.length) * 100 * 100) / 100
        : 0;
    return {
      sequenceName,
      totalSent: leads.length,
      repliesAfterSequence,
      reactivationRate,
    };
  });

  sequences.sort((a, b) => b.reactivationRate - a.reactivationRate);
  res.json({ sequences });
});

router.get("/dashboard/button-stats", async (req, res): Promise<void> => {
  const parsed = GetLabelStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);

  // Aggregate button clicks across all subscribers
  const buttonMap = new Map<string, {
    totalClicks: number;
    uniqueLeads: Map<string, { name: string; phoneNumber: string }>;
  }>();
  let totalClicks = 0;

  for (const sub of subscribers) {
    for (const click of sub.buttonClicks) {
      if (!buttonMap.has(click.buttonName)) {
        buttonMap.set(click.buttonName, { totalClicks: 0, uniqueLeads: new Map() });
      }
      const entry = buttonMap.get(click.buttonName)!;
      entry.totalClicks++;
      entry.uniqueLeads.set(sub.phoneNumber, { name: sub.name, phoneNumber: sub.phoneNumber });
      totalClicks++;
    }
  }

  const buttons = Array.from(buttonMap.entries())
    .map(([buttonName, { totalClicks: clicks, uniqueLeads }]) => ({
      buttonName,
      totalClicks: clicks,
      uniqueLeads: uniqueLeads.size,
      clickRate: totalClicks > 0 ? Math.round((clicks / totalClicks) * 10000) / 100 : 0,
      subscribers: Array.from(uniqueLeads.values()),
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);

  const mostClicked = buttons[0] ?? null;
  const leastClicked = buttons[buttons.length - 1] ?? null;
  const bestConversion = [...buttons].sort((a, b) => b.uniqueLeads - a.uniqueLeads)[0] ?? null;

  res.json({
    totalClicks,
    buttons,
    insights: {
      mostClicked: mostClicked?.buttonName ?? null,
      leastClicked: leastClicked?.buttonName ?? null,
      bestConversion: bestConversion?.buttonName ?? null,
    },
  });
});

router.get("/dashboard/label-stats", async (req, res): Promise<void> => {
  const parsed = GetLabelStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const subscribers = await getProcessedSubscribers(apiToken, phoneNumberId);

  const labelMap = new Map<string, { leads: ProcessedSubscriber[] }>();
  for (const sub of subscribers) {
    const label = sub.labelName || "Unlabeled";
    if (!labelMap.has(label)) labelMap.set(label, { leads: [] });
    labelMap.get(label)!.leads.push(sub);
  }

  const labels = Array.from(labelMap.entries()).map(([labelName, { leads }]) => ({
    labelName,
    count: leads.length,
    dormantCount: leads.filter((l) => l.isDormant).length,
  }));

  labels.sort((a, b) => b.count - a.count);
  res.json({ labels });
});

router.get("/labels/list", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;

  const url = new URL("https://growth.thewiseparrot.club/api/v1/whatsapp/label/list");
  url.searchParams.set("apiToken", apiToken);
  url.searchParams.set("phone_number_id", phoneNumberId);

  const twpRes = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  const raw = await twpRes.json() as { status?: string; message?: unknown };

  if (!twpRes.ok || raw.status !== "1") {
    res.json({ labels: [] });
    return;
  }

  // TWP label list returns an array in message field
  const items = Array.isArray(raw.message) ? raw.message as Array<{ id?: unknown; name?: unknown; label_name?: unknown }> : [];
  const labels = items.map((item) => ({
    id: String(item.id ?? ""),
    name: String(item.name ?? item.label_name ?? ""),
  })).filter((l) => l.id && l.name);

  res.json({ labels });
});

async function createSubscriber(apiToken: string, phoneNumberId: string, phoneNumber: string, name: string): Promise<void> {
  const params = new URLSearchParams({
    apiToken,
    phoneNumberID: phoneNumberId,
    name,
    phoneNumber,
  });
  await fetch(
    "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/create",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(), signal: AbortSignal.timeout(10_000) }
  );
}

router.post("/labels/bulk-assign", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId, labelId, phoneNumbers, names } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
    labelId?: string;
    phoneNumbers?: unknown;
    names?: unknown;
  };

  if (!apiToken || !phoneNumberId || !labelId?.trim() || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    res.status(400).json({ error: "apiToken, phoneNumberId, labelId and phoneNumbers[] are required" });
    return;
  }

  const numbers = (phoneNumbers as unknown[]).map(String).filter(Boolean);
  const nameList = Array.isArray(names) ? (names as unknown[]).map(String) : [];
  const errors: { phone: string; reason: string }[] = [];
  let succeeded = 0;
  let created = 0;

  // Process in batches of 5 concurrent requests to avoid overwhelming the TWP API
  const BATCH = 5;
  for (let i = 0; i < numbers.length; i += BATCH) {
    const batch = numbers.slice(i, i + BATCH);
    await Promise.all(batch.map(async (phone, batchIdx) => {
      const globalIdx = i + batchIdx;
      const assignParams = new URLSearchParams({
        apiToken,
        phone_number_id: phoneNumberId,
        phone_number: phone,
        label_ids: labelId,
      });
      try {
        const r = await fetch(
          "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/assign-labels",
          { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: assignParams.toString(), signal: AbortSignal.timeout(10_000) }
        );
        const raw = await r.json() as { status?: string; message?: string };
        if (r.ok && raw.status === "1") {
          succeeded++;
        } else {
          // Subscriber not found — create them, then retry assign
          const subscriberName = (nameList[globalIdx] ?? "").trim() || phone;
          await createSubscriber(apiToken, phoneNumberId, phone, subscriberName);
          created++;

          const r2 = await fetch(
            "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/assign-labels",
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: assignParams.toString(), signal: AbortSignal.timeout(10_000) }
          );
          const raw2 = await r2.json() as { status?: string; message?: string };
          if (r2.ok && raw2.status === "1") {
            succeeded++;
          } else {
            errors.push({ phone, reason: raw2.message ?? `HTTP ${r2.status}` });
          }
        }
      } catch (err) {
        errors.push({ phone, reason: err instanceof Error ? err.message : "Unknown error" });
      }
    }));
  }

  invalidateCache(apiToken, phoneNumberId);
  res.json({ total: numbers.length, succeeded, created, failed: errors.length, errors });
});

router.post("/labels/assign-subscriber", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId, phoneNumber, labelIds, name } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
    phoneNumber?: string;
    labelIds?: string;
    name?: string;
  };

  if (!apiToken || !phoneNumberId || !phoneNumber?.trim() || !labelIds?.trim()) {
    res.status(400).json({ error: "apiToken, phoneNumberId, phoneNumber and labelIds are required" });
    return;
  }

  const phone = phoneNumber.trim();
  const params = new URLSearchParams({
    apiToken,
    phone_number_id: phoneNumberId,
    phone_number: phone,
    label_ids: labelIds.trim(),
  });

  const twpRes = await fetch(
    "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/assign-labels",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }
  );

  const raw = await twpRes.json() as { status?: string; message?: string };

  if (!twpRes.ok || raw.status !== "1") {
    // Subscriber not found — create them, then retry assign
    const subscriberName = (name ?? "").trim() || phone;
    await createSubscriber(apiToken, phoneNumberId, phone, subscriberName);

    const twpRes2 = await fetch(
      "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/assign-labels",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }
    );
    const raw2 = await twpRes2.json() as { status?: string; message?: string };

    if (!twpRes2.ok || raw2.status !== "1") {
      const msg = typeof raw2.message === "string" ? raw2.message : "Failed to assign subscriber";
      res.status(400).json({ success: false, message: msg });
      return;
    }

    invalidateCache(apiToken, phoneNumberId);
    res.json({ success: true, message: `New subscriber created and assigned successfully` });
    return;
  }

  invalidateCache(apiToken, phoneNumberId);
  res.json({ success: true, message: raw.message ?? "Subscriber assigned successfully" });
});

router.post("/labels/create", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId, labelName } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
    labelName?: string;
  };

  if (!apiToken || !phoneNumberId || !labelName?.trim()) {
    res.status(400).json({ error: "apiToken, phoneNumberId and labelName are required" });
    return;
  }

  const params = new URLSearchParams({
    apiToken,
    phone_number_id: phoneNumberId,
    label_name: labelName.trim(),
  });

  const twpRes = await fetch(
    "https://growth.thewiseparrot.club/api/v1/whatsapp/label/create",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }
  );

  const raw = await twpRes.json() as { status?: string; message?: string };

  if (!twpRes.ok || raw.status !== "1") {
    const msg = typeof raw.message === "string" ? raw.message : "Failed to create label";
    res.status(400).json({ success: false, message: msg });
    return;
  }

  res.json({ success: true, message: raw.message ?? "Label created successfully" });
});

router.get("/account-info", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { apiToken, phoneNumberId } = parsed.data;
  const info = await fetchAccountInfo(apiToken, phoneNumberId);
  res.json(info);
});

router.post("/templates/list", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
  };

  if (!apiToken || !phoneNumberId) {
    res.status(400).json({ error: "apiToken and phoneNumberId are required" });
    return;
  }

  const params = new URLSearchParams({
    apiToken,
    phone_number_id: phoneNumberId,
  });

  const twpRes = await fetch(
    "https://growth.thewiseparrot.club/api/v1/whatsapp/template/list",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(), signal: AbortSignal.timeout(10_000) }
  );

  const raw = await twpRes.json() as { status?: string; message?: unknown };

  if (!twpRes.ok || raw.status !== "1") {
    res.json({ templates: [] });
    return;
  }

  const items = Array.isArray(raw.message) ? raw.message as Array<Record<string, unknown>> : [];
  const MEDIA_TYPES = ["IMAGE", "VIDEO", "DOCUMENT"];

  function extractString(val: unknown): string {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "object") {
      const o = val as Record<string, unknown>;
      return String(o["type"] ?? o["format"] ?? o["value"] ?? "");
    }
    return String(val);
  }

  const templates = items.map((item) => {
    // Priority list of flat field names to check for the header type.
    // header_subtype is checked first because header_type may be "media" (generic)
    // while header_subtype contains the actual format: "image" / "video" / "document".
    const HEADER_KEYS = [
      "header_subtype", "headerSubtype",
      "header_type", "headerType", "header_format", "headerFormat",
      "header", "type", "format", "component_type", "template_type", "mediaType", "media_type",
    ];
    let headerRaw = "";
    for (const key of HEADER_KEYS) {
      const val = extractString(item[key]).toUpperCase();
      if (MEDIA_TYPES.includes(val)) { headerRaw = val; break; }
    }

    // body_content is the actual TWP field name for the template message body
    let message = String(
      item["body_content"] ?? item["message"] ?? item["body"] ?? item["template"] ?? item["text"] ?? ""
    );

    // Meta WhatsApp Business API nested components format:
    // { components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "..." }] }
    const components = Array.isArray(item["components"])
      ? (item["components"] as Array<Record<string, unknown>>)
      : [];
    if (components.length > 0 && !MEDIA_TYPES.includes(headerRaw)) {
      const headerComp = components.find((c) => String(c["type"] ?? "").toUpperCase() === "HEADER");
      if (headerComp) {
        const fmt = extractString(headerComp["format"]).toUpperCase();
        const hasHandle = !!(headerComp["example"] as Record<string, unknown> | undefined)?.["header_handle"];
        headerRaw = MEDIA_TYPES.includes(fmt) ? fmt : hasHandle ? "IMAGE" : fmt;
      }
      if (!message) {
        const bodyComp = components.find((c) => String(c["type"] ?? "").toUpperCase() === "BODY");
        if (bodyComp) {
          message = String(bodyComp["text"] ?? bodyComp["content"] ?? "");
        }
      }
    }

    // Last resort: scan every string value at the top level
    if (!MEDIA_TYPES.includes(headerRaw)) {
      for (const [key, val] of Object.entries(item)) {
        if (typeof val === "string" && MEDIA_TYPES.includes(val.toUpperCase())) {
          // Exclude the name/message fields to avoid false positives
          if (!["name", "message", "body", "template", "text", "template_name"].includes(key)) {
            headerRaw = val.toUpperCase();
            break;
          }
        }
      }
    }

    const headerType = MEDIA_TYPES.includes(headerRaw) ? headerRaw : null;

    // Extract numbered body variables like {{1}}, {{2}}, etc.
    const varMatches = message.match(/\{\{(\d+)\}\}/g) ?? [];
    const varIndices = [...new Set(varMatches.map((m) => parseInt(m.replace(/\{\{|\}\}/g, ""))))].sort((a, b) => a - b);
    const bodyVariables = varIndices.map((i) => `{{${i}}}`);

    return {
      id: String(item["id"] ?? item["template_id"] ?? ""),
      name: String(item["name"] ?? item["template_name"] ?? ""),
      message,
      headerType,
      bodyVariables,
    };
  }).filter((t) => t.name);

  res.json({ templates });
});

// ─── Agent List ───────────────────────────────────────────────────────────────
router.post("/agents/list", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId } = req.body as { apiToken?: string; phoneNumberId?: string };
  if (!apiToken || !phoneNumberId) {
    res.status(400).json({ error: "apiToken and phoneNumberId are required" });
    return;
  }

  const candidates = [
    `https://growth.thewiseparrot.club/api/v1/whatsapp/team-member/list?apiToken=${encodeURIComponent(apiToken)}&phone_number_id=${encodeURIComponent(phoneNumberId)}`,
    `https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/team-member/list?apiToken=${encodeURIComponent(apiToken)}&phone_number_id=${encodeURIComponent(phoneNumberId)}`,
    `https://growth.thewiseparrot.club/api/v1/whatsapp/agent/list?apiToken=${encodeURIComponent(apiToken)}&phone_number_id=${encodeURIComponent(phoneNumberId)}`,
    `https://growth.thewiseparrot.club/api/v1/whatsapp/user/list?apiToken=${encodeURIComponent(apiToken)}&phone_number_id=${encodeURIComponent(phoneNumberId)}`,
    `https://growth.thewiseparrot.club/api/v1/whatsapp/team/list?apiToken=${encodeURIComponent(apiToken)}&phone_number_id=${encodeURIComponent(phoneNumberId)}`,
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const data = await r.json() as Record<string, unknown>;
      logger.info({ endpoint: url.split("?")[0], status: data.status }, "agents/list: TWP response");
      if (data.status === "1" && Array.isArray(data.message)) {
        const agents = (data.message as Record<string, unknown>[]).map((a) => ({
          id: String(a.id ?? a.agent_id ?? a.user_id ?? a.email ?? ""),
          name: String(a.name ?? a.agent_name ?? a.full_name ?? a.username ?? ""),
          email: String(a.email ?? a.agent_email ?? ""),
        })).filter((a) => a.name);
        res.json({ agents });
        return;
      }
    } catch {
      // try next
    }
  }

  logger.warn("agents/list: no TWP agent list endpoint found, returning empty");
  res.json({ agents: [] });
});

// ─── Assign Agent to Label ────────────────────────────────────────────────────
router.post("/agents/assign-to-label", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId, labelName, agentId } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
    labelName?: string;
    agentId?: string;
  };

  if (!apiToken || !phoneNumberId || !labelName?.trim() || !agentId?.trim()) {
    res.status(400).json({ error: "apiToken, phoneNumberId, labelName and agentId are required" });
    return;
  }

  // Use fast subscriber fetch (no conversation processing)
  const rawSubs = await fetchSubscribers(apiToken, phoneNumberId);
  const target = rawSubs.filter((sub) => {
    const labels = sub.label_names ? sub.label_names.split(",").map((l) => l.trim()).filter(Boolean) : [];
    return labels.includes(labelName.trim());
  });

  logger.info({ labelName: labelName.trim(), totalSubs: rawSubs.length, matched: target.length }, "agents/assign-to-label: matched subscribers");

  if (target.length === 0) {
    res.json({ total: 0, succeeded: 0, failed: 0, errors: [] });
    return;
  }

  const ASSIGN_URL = "https://growth.thewiseparrot.club/api/v1/whatsapp/subscriber/chat/assign-to-team-member";
  const errors: { phone: string; reason: string }[] = [];
  let succeeded = 0;

  const BATCH = 5;
  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sub) => {
      const phone = sub.chat_id ?? "";
      if (!phone) { errors.push({ phone: "unknown", reason: "No phone number" }); return; }

      try {
        const params = new URLSearchParams({
          apiToken,
          phone_number_id: phoneNumberId,
          phone_number: phone,
          team_member_id: agentId.trim(),
        });
        const r = await fetch(ASSIGN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await r.json() as { status?: string; message?: string };
        logger.info({ phone, status: data.status, message: data.message }, "agents/assign-to-label: TWP response");
        if (data.status === "1") {
          succeeded++;
        } else {
          errors.push({ phone, reason: data.message ?? "Assignment rejected by TWP" });
        }
      } catch (err) {
        errors.push({ phone, reason: err instanceof Error ? err.message : "Request failed" });
      }
    }));
  }

  res.json({ total: target.length, succeeded, failed: errors.length, errors });
});

router.post("/templates/send-to-label", async (req, res): Promise<void> => {
  const { apiToken, phoneNumberId, labelName, templateId, message, templateHeaderMediaUrl, bodyVariables } = req.body as {
    apiToken?: string;
    phoneNumberId?: string;
    labelName?: string;
    templateId?: string;
    message?: string;
    templateHeaderMediaUrl?: string;
    bodyVariables?: string[];
  };

  if (!apiToken || !phoneNumberId || !labelName?.trim()) {
    res.status(400).json({ error: "apiToken, phoneNumberId and labelName are required" });
    return;
  }

  const usingTemplate = !!templateId?.trim();
  const usingCustom = !!message?.trim();

  if (!usingTemplate && !usingCustom) {
    res.status(400).json({ error: "Either templateId or message is required" });
    return;
  }

  const allSubscribers = await getProcessedSubscribers(apiToken, phoneNumberId);
  const targetLabel = labelName.trim();
  const targets = allSubscribers.filter((s) =>
    s.allLabelNames.some((l) => l === targetLabel) || s.labelName === targetLabel
  );

  logger.info({ targetLabel, totalSubscribers: allSubscribers.length, matched: targets.length, hasMediaUrl: !!templateHeaderMediaUrl }, "send-to-label: matched subscribers");

  if (targets.length === 0) {
    res.json({ total: 0, succeeded: 0, failed: 0, errors: [] });
    return;
  }

  const errors: { phone: string; reason: string }[] = [];
  let succeeded = 0;

  const BATCH = 5;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sub) => {
      try {
        let r: Response;
        let rawResp: { status?: string; message?: string };

        if (usingTemplate) {
          const sendParams = new URLSearchParams({
            apiToken,
            phone_number_id: phoneNumberId,
            template_id: templateId!.trim(),
            phone_number: sub.phoneNumber,
          });
          if (templateHeaderMediaUrl?.trim()) {
            sendParams.set("template_header_media_url", templateHeaderMediaUrl.trim());
          }
          if (Array.isArray(bodyVariables)) {
            bodyVariables.forEach((val, idx) => sendParams.set(`body_variable_${idx + 1}`, val ?? ""));
          }
          r = await fetch(
            "https://growth.thewiseparrot.club/api/v1/whatsapp/send/template",
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: sendParams.toString(), signal: AbortSignal.timeout(15_000) }
          );
          rawResp = await r.json() as { status?: string; message?: string };
        } else {
          const sendParams = new URLSearchParams({
            apiToken,
            phone_number_id: phoneNumberId,
            message: message!.trim(),
            phone_number: sub.phoneNumber,
          });
          r = await fetch(
            "https://growth.thewiseparrot.club/api/v1/whatsapp/send",
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: sendParams.toString(), signal: AbortSignal.timeout(10_000) }
          );
          rawResp = await r.json() as { status?: string; message?: string };
        }

        if (r.ok && rawResp.status === "1") {
          succeeded++;
        } else {
          logger.warn({ phone: sub.phoneNumber, httpStatus: r.status, twpResponse: rawResp }, "send-to-label: TWP send failed");
          errors.push({ phone: sub.phoneNumber, reason: rawResp.message ?? `HTTP ${r.status}` });
        }
      } catch (err) {
        errors.push({ phone: sub.phoneNumber, reason: err instanceof Error ? err.message : "Unknown error" });
      }
    }));
  }

  res.json({ total: targets.length, succeeded, failed: errors.length, errors });
});

export default router;
