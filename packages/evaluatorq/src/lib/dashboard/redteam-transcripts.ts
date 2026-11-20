import { esc } from "../common/reports/html-helpers.js";
import { renderMessageList } from "../common/reports/messages.js";
import { contentToText, type JuryResult, type JuryVote } from "../contracts.js";
import type {
  RedTeamReport,
  RedTeamResult,
} from "../redteam/reports/models.js";
import {
  agentKey,
  fmtCategory,
  fmtVulnerability,
  quoteLinkPart,
} from "./redteam-charts.js";
import { shortModel, tag } from "./report-kit.js";
import {
  singleTraceUrl,
  threadTraceUrl,
  traceLinkButton,
} from "./trace-links.js";

const PAGE_SIZE = 10;
const ROLE_LABELS = {
  user: "USR",
  assistant: "AGT",
  system: "SYS",
  developer: "SYS",
  tool: "TOOL",
};
export function juryVoteLabel(vote: JuryVote): string {
  if (!vote.success) return "failed";
  if (vote.abstained) return "abstained";
  if (vote.value === null) return "no verdict";
  if (typeof vote.value === "boolean")
    return vote.value ? "RESISTANT" : "VULNERABLE";
  return String(vote.value);
}
export function juryPanelHealth(jury: JuryResult | null): string {
  if (jury === null) return "";
  const chips = [
    tag(
      `${jury.judgesSucceeded}/${jury.judgesConfigured + jury.replacementsUsed} decisive votes`,
    ),
  ];
  if (jury.judgesFailed) chips.push(tag(`${jury.judgesFailed} failed`));
  if (jury.replacementsUsed)
    chips.push(
      tag(
        `${jury.replacementsUsed} replacement${jury.replacementsUsed !== 1 ? "s" : ""}`,
      ),
    );
  if (jury.tie) chips.push(tag("tie"));
  if (jury.inconclusive) chips.push(tag("inconclusive"));
  const summary = `<div class="rt-attack-tags">${chips.join("")}</div>`;
  let votes = "";
  if (jury.votes.length) {
    const items = jury.votes.map((v) => {
      const tags: string[] = [];
      if (v.replacement) tags.push(tag("stand-in"));
      if (v.repetitionsFailed)
        tags.push(
          tag(
            `${v.repetitionsFailed} failed rep${v.repetitionsFailed !== 1 ? "s" : ""}`,
          ),
        );
      const head = `<b>${esc(shortModel(v.model))}</b> &rarr; ${esc(juryVoteLabel(v))}`,
        error = v.error
          ? `<div class="rt-jury-error">${esc(v.error)}</div>`
          : "";
      return `<li class="rt-jury-vote">${head} ${tags.join("")}${error}</li>`;
    });
    votes = `<ul class="rt-jury-votes">${items.join("")}</ul>`;
  }
  return `<div class="rt-jury"><span class="rt-verdict-label">Jury panel health</span>${summary}${votes}</div>`;
}
export async function renderAttackFragment(
  result: RedTeamResult,
): Promise<string> {
  const attack = result.attack,
    tags = attack.deliveryMethods.map((dm) => tag(dm));
  if (attack.turnType) tags.push(tag(`${attack.turnType}-turn`));
  if (attack.category) tags.push(tag(attack.category));
  const tagsHtml = `<div class="rt-attack-tags">${tags.join("")}</div>`;
  let verdict: string;
  if (result.error)
    verdict = `<div class="rt-verdict rt-verdict-error"><span class="rt-verdict-label">Evaluator verdict</span><p class="rt-verdict-body" style="color:var(--red-600)">${esc(result.error)}</p></div>`;
  else if (result.vulnerable === null)
    verdict = `<div class="rt-verdict rt-verdict-unknown" style="background:var(--gray-100);border-left:3px solid var(--gray-500)"><span class="rt-verdict-label">Evaluator verdict</span><p class="rt-verdict-body">${result.evaluationError ? esc(result.evaluationError.message) : "No evaluation available."}</p></div>`;
  else {
    const explanation = result.evaluation?.explanation,
      body = explanation ? esc(explanation) : "No evaluation available.";
    verdict = result.vulnerable
      ? `<div class="rt-verdict rt-verdict-vuln" style="border-left:3px solid var(--orange-500)"><span class="rt-verdict-label">Evaluator verdict</span><p class="rt-verdict-body">${body}</p></div>`
      : `<div class="rt-verdict rt-verdict-safe" style="background:var(--green-50);border-left:3px solid var(--green-600)"><span class="rt-verdict-label">Evaluator verdict</span><p class="rt-verdict-body">${body}</p></div>`;
  }
  const jury = juryPanelHealth(result.evaluation?.jury ?? null);
  let transcript = renderMessageList(result.messages, {
    roleLabels: ROLE_LABELS,
    classPrefix: "rt",
  });
  if (
    result.response &&
    !result.messages.some(
      (m) =>
        m.role === "assistant" && contentToText(m.content) === result.response,
    )
  )
    transcript += `<section class="rt-recorded-response"><h4>Recorded final response</h4><pre class="rt-msg-content">${esc(result.response)}</pre></section>`;
  if (!result.messages.length && !result.response)
    transcript =
      '<p class="rk-empty">No conversation evidence recorded for this attack.</p>';
  const traceUrl = await singleTraceUrl(result.lastTraceId),
    button = traceLinkButton(
      traceUrl || (await threadTraceUrl(result.threadId)),
      traceUrl ? "View Trace" : "View Traces",
    );
  const trace = button ? `<div class="rt-conv-actions">${button}</div>` : "";
  return `${tagsHtml}${verdict}${jury}${trace}${transcript}`;
}
function agentSelect(options: {
  agents: string[];
  selected: string;
  paramName: string;
  hxUrl: string;
  extraParams: string;
  containerId: string;
  label: string;
}): string {
  const parts = [
    `<div class="rt-dis-agent-select"><label class="rt-breakdown-label">${esc(options.label)}</label>`,
  ];
  for (const agent of options.agents) {
    const active = agent === options.selected ? " rt-view-selector-active" : "",
      url = `${options.hxUrl}?${options.paramName}=${quoteLinkPart(agent)}&${options.extraParams}`;
    parts.push(
      `<button class="rt-view-selector-btn${active}" hx-get="${url}" hx-target="#${esc(options.containerId)}" hx-swap="outerHTML">${esc(agent)}</button>`,
    );
  }
  return `${parts.join("")}</div>`;
}
const excerpt = (text: string, size: number): string => {
  const chars = Array.from(text);
  return chars.slice(0, size).join("") + (chars.length > size ? "…" : "");
};
export function renderAgentSide(
  result: RedTeamResult,
  agentName: string,
): string {
  const [verdictClass, verdictText] =
    result.vulnerable === null
      ? ["rt-conv-verdict-unknown", "NOT EVALUATED"]
      : result.vulnerable
        ? ["rt-conv-verdict-vuln", "VULNERABLE"]
        : ["rt-conv-verdict-safe", "RESISTANT"];
  const header = `<div class="rt-dis-agent-header"><strong>${esc(agentName)}</strong> <span class="rt-conv-verdict ${verdictClass}">[${verdictText}]</span></div>`;
  const users = result.messages.filter((m) => m.role === "user");
  const prompt = users.length
    ? `<div class="rt-dis-section"><strong>Attack prompt:</strong><pre class="rt-msg-content">${esc(excerpt(contentToText(users.at(-1)?.content), 600))}</pre></div>`
    : "";
  const response = result.response
    ? `<div class="rt-dis-section"><strong>Response:</strong><pre class="rt-msg-content">${esc(excerpt(result.response, 600))}</pre></div>`
    : "";
  const evaluation = result.evaluation?.explanation
    ? `<div class="rt-dis-section"><strong>Evaluator:</strong><p class="rt-conv-eval-text">${esc(excerpt(result.evaluation.explanation, 400))}</p></div>`
    : "";
  return `${header}${prompt}${response}${evaluation}`;
}
export function renderDisagreement(options: {
  report: RedTeamReport;
  agentA: string;
  agentB: string;
  page: number;
  rid: string;
  containerId?: string;
}): string {
  const { report, rid } = options,
    containerId = options.containerId ?? "rt-disagreement",
    agents = [...new Set(report.results.map(agentKey))];
  if (agents.length < 2)
    return `<div class="rt-disagreement" id="${esc(containerId)}"><p class="rt-view-empty">Disagreement viewer requires 2 or more agents.</p></div>`;
  const agentA = agents.includes(options.agentA)
    ? options.agentA
    : (agents[0] as string);
  const agentB =
    agents.includes(options.agentB) && options.agentB !== agentA
      ? options.agentB
      : (agents.find((a) => a !== agentA) ?? (agents[0] as string));
  const baseUrl = `/r/${esc(rid)}/view/disagreement`;
  const selectorA = agentSelect({
    agents,
    selected: agentA,
    paramName: "a",
    hxUrl: baseUrl,
    extraParams: `b=${quoteLinkPart(agentB)}&page=1`,
    containerId,
    label: "Agent A",
  });
  const selectorB = agentSelect({
    agents: agents.filter((a) => a !== agentA),
    selected: agentB,
    paramName: "b",
    hxUrl: baseUrl,
    extraParams: `a=${quoteLinkPart(agentA)}&page=1`,
    containerId,
    label: "Agent B",
  });
  const grouped = new Map<string, Map<string, RedTeamResult>>();
  for (const result of report.results) {
    const agent = agentKey(result);
    if (agent === agentA || agent === agentB) {
      const row =
        grouped.get(result.attack.id) ?? new Map<string, RedTeamResult>();
      row.set(agent, result);
      grouped.set(result.attack.id, row);
    }
  }
  const disagreements: [RedTeamResult, RedTeamResult][] = [];
  for (const row of grouped.values()) {
    const a = row.get(agentA),
      b = row.get(agentB);
    if (
      a &&
      b &&
      typeof a.evaluation?.passed === "boolean" &&
      typeof b.evaluation?.passed === "boolean" &&
      (a.evaluation.passed === false) !== (b.evaluation.passed === false)
    )
      disagreements.push([a, b]);
  }
  const controls = `<div class="rt-dis-controls">${selectorA}${selectorB}</div>`;
  if (!disagreements.length)
    return `<div class="rt-disagreement" id="${esc(containerId)}">${controls}<p class="rt-view-empty">No disagreements found between ${esc(agentA)} and ${esc(agentB)}.</p></div>`;
  const totalPages = Math.max(
      1,
      Math.floor((disagreements.length + PAGE_SIZE - 1) / PAGE_SIZE),
    ),
    page = Math.max(1, Math.min(options.page, totalPages)),
    start = (page - 1) * PAGE_SIZE;
  const previous = page <= 1 ? " disabled" : "",
    next = page >= totalPages ? " disabled" : "";
  const prevUrl = `${baseUrl}?a=${quoteLinkPart(agentA)}&b=${quoteLinkPart(agentB)}&page=${page - 1}`,
    nextUrl = `${baseUrl}?a=${quoteLinkPart(agentA)}&b=${quoteLinkPart(agentB)}&page=${page + 1}`;
  const pagination = `<div class="rt-dis-pagination"><button class="rt-dis-page-btn"${previous} hx-get="${prevUrl}" hx-target="#${esc(containerId)}" hx-swap="outerHTML">Previous</button><span class="rt-dis-page-info">Page ${page} of ${totalPages} (${disagreements.length} disagreements)</span><button class="rt-dis-page-btn"${next} hx-get="${nextUrl}" hx-target="#${esc(containerId)}" hx-swap="outerHTML">Next</button></div>`;
  const items = disagreements
    .slice(start, start + PAGE_SIZE)
    .map(([a, b], i) => {
      const vulnerability = a.attack.vulnerability
        ? fmtVulnerability(a.attack.vulnerability)
        : fmtCategory(a.attack.category);
      return `<details class="rt-dis-item" open><summary class="rt-dis-item-summary">#${start + i + 1} ${esc(a.attack.id)} \u2014 ${esc(vulnerability)} / ${esc(a.attack.attackTechnique)}</summary><div class="rt-dis-item-body"><div class="rt-dis-col">${renderAgentSide(a, agentA)}</div><div class="rt-dis-col">${renderAgentSide(b, agentB)}</div></div></details>`;
    })
    .join("");
  return `<div class="rt-disagreement" id="${esc(containerId)}">${controls}${pagination}<div class="rt-dis-items">${items}</div></div>`;
}
