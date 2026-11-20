import { pythonStrip } from "../sanitize.js";
import { esc, loadLogoSvg } from "./html-helpers.js";
import { STANDALONE_STYLES } from "./standalone-styles.js";

export type StandaloneItem = readonly [
  label: string,
  body: string,
  extra?: string,
];
const notes: Readonly<Record<string, string>> = {
  "simtab|Overview":
    "Outcome shares use all conversations, including execution errors.",
  "simtab|Breakdown":
    "Heatmap average scores are higher when better; binary pass rates are separate.",
  "simtab|Turn quality":
    "Higher is better for response, tone, and factual accuracy; lower is better for hallucination risk.",
  "rttab|Overview":
    "Attack outcomes use the saved run totals; attacks without verdicts remain unknown.",
  "rttab|Breakdowns":
    "Attack success rate divides vulnerabilities by evaluated attacks; lower is better.",
  "simtab|Recommendations":
    "Check each saved suggestion against the conversation evidence that supports it.",
  "simtab|Transcripts":
    "Open a conversation to inspect the recorded turns and its outcome.",
  "simtab|Config":
    "Configuration describes the saved run and its full configured population.",
  "simtab|Usage":
    "Usage totals cover the provider data recorded with this report.",
  "rttab|Agents":
    "Agent counts and outcomes reflect the saved report population.",
  "rttab|Focus areas":
    "Read each focus area with its confirmed and evaluated attack counts.",
  "rttab|Attacks":
    "Open an attack to inspect its verdict and full recorded evidence.",
  "rttab|Usage":
    "Usage totals cover the provider data recorded with this report.",
  "rttab|Config":
    "Configuration describes the saved run and its tested agents.",
};
export function expandedSections(
  group: string,
  items: readonly StandaloneItem[],
  options: { brief?: string } = {},
): string {
  const brief = options.brief ?? "",
    links: string[] = [],
    sections: string[] = [];
  let number = 0;
  for (const [label, body] of items) {
    if (!pythonStrip(body)) continue;
    number++;
    const anchor = `${group}-${label.toLowerCase().replaceAll(" ", "-")}`,
      appendix = label === "Config" || label === "Usage",
      display = appendix ? `${label} · Appendix` : label;
    links.push(`<a href="#${esc(anchor)}">${number}. ${esc(display)}</a>`);
    let content = `<p class="export-reading-note">${notes[`${group}|${label}`] ?? "Read the saved counts and evidence together."}</p>${body}`;
    if (appendix)
      content = `<details class="export-appendix-detail"><summary>Show ${esc(label.toLowerCase())} details</summary>${content}</details>`;
    const back = brief
      ? '<p class="export-back-brief"><a href="#export-brief">Back to brief</a></p>'
      : "";
    sections.push(
      `<section class="export-section" id="${esc(anchor)}" aria-labelledby="${esc(anchor)}-title"><h2 class="export-section-title" id="${esc(anchor)}-title">${number}. ${esc(display)}</h2>${content}${back}</section>`,
    );
  }
  const count = [...brief.matchAll(/id="export-finding-\d+"/g)].length,
    findingLinks = Array.from(
      { length: count },
      (_, i) => `<a href="#export-finding-${i + 1}">Finding ${i + 1}</a>`,
    ).join(""),
    briefLink = brief ? '<a href="#export-brief">Brief</a>' : "";
  return `${brief}<nav class="export-nav" aria-label="Report sections">${briefLink}${findingLinks}${links.join("")}</nav>${sections.join("")}`;
}
function attributeValue(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, digits: string) => {
      const code =
        digits[0]?.toLowerCase() === "x"
          ? Number.parseInt(digits.slice(1), 16)
          : Number.parseInt(digits, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
    })
    .replace(
      /&(Tab|NewLine|nbsp|NonBreakingSpace|ensp|emsp|thinsp|ThinSpace|hairsp|VeryThinSpace|MediumSpace);/g,
      () => " ",
    );
}
function attributes(tag: string): Map<string, string | null> {
  const values = new Map<string, string | null>();
  const name = tag.match(/^<\s*[^\s/>]+/);
  if (!name) return values;
  const body = tag.slice(name[0].length).replace(/\/?\s*>$/, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of body.matchAll(pattern))
    values.set(
      (match[1] ?? "").toLowerCase(),
      match[2] === undefined && match[3] === undefined && match[4] === undefined
        ? null
        : attributeValue(match[2] ?? match[3] ?? match[4] ?? ""),
    );
  return values;
}
export function expandReportDetails(body: string): string {
  const parts: string[] = [];
  let index = 0,
    rawText: string | null = null;
  while (index < body.length) {
    if (rawText) {
      const end = new RegExp(`</${rawText}\\s*>`, "ig");
      end.lastIndex = index;
      const match = end.exec(body);
      if (!match) {
        parts.push(body.slice(index));
        break;
      }
      parts.push(body.slice(index, match.index), `</${rawText}>`);
      index = match.index + match[0].length;
      rawText = null;
      continue;
    }
    const start = body.indexOf("<", index);
    if (start < 0) {
      parts.push(body.slice(index));
      break;
    }
    parts.push(body.slice(index, start));
    if (body.startsWith("<!--", start)) {
      const end = body.indexOf("-->", start + 4);
      if (end < 0) {
        parts.push(body.slice(start));
        break;
      }
      parts.push(body.slice(start, end + 3));
      index = end + 3;
      continue;
    }
    let cursor = start + 1,
      quote: string | null = null;
    for (; cursor < body.length; cursor++) {
      const char = body[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (cursor >= body.length) {
      parts.push(body.slice(start));
      break;
    }
    const raw = body.slice(start, cursor + 1),
      closing = raw.match(/^<\/\s*([a-z][^\s/>]*)[^>]*>$/i),
      opening = raw.match(/^<([a-z][^\s/>]*)/i);
    if (closing) parts.push(`</${closing[1]?.toLowerCase()}>`);
    else if (opening) {
      const name = opening[1]?.toLowerCase(),
        selfClosing = /\/\s*>$/.test(raw),
        attrs = attributes(raw),
        classes = (attrs.get("class") ?? "").split(/\s+/u);
      if (
        name === "details" &&
        !selfClosing &&
        !classes.includes("export-evidence") &&
        !classes.includes("export-appendix-detail") &&
        !attrs.has("open")
      )
        parts.push(`${raw.slice(0, -1)} open>`);
      else parts.push(raw);
      if (!selfClosing && (name === "script" || name === "style"))
        rawText = name;
    } else if (!/^<!(?:DOCTYPE|\[)|^<\?/i.test(raw)) parts.push(raw);
    index = cursor + 1;
  }
  return parts.join("");
}
export function standaloneDocument(title: string, body: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(title)}</title><style>${STANDALONE_STYLES}</style></head>` +
    '<body class="standalone-report"><div class="export-brand">' +
    `${loadLogoSvg()}<span>evaluatorq · ${esc(title)}</span></div>` +
    '<p class="export-print-note">Collapsed conversations, attacks, and appendix details are omitted from print. ' +
    "Open the sections you want to include in this report before printing.</p>" +
    `<main>${expandReportDetails(body)}</main>` +
    '<footer class="export-footer">Generated by evaluatorq. This report renders the saved results; ' +
    "external trace and agent links require access to Orq.</footer></body></html>"
  );
}

export async function redteamHtml(
  report: import("../../redteam/reports/models.js").RedTeamReport,
): Promise<string> {
  const { redteamReportTabs } = await import(
    "../../dashboard/redteam-report-tabs.js"
  );
  const { cliSlugRenderScope } = await import(
    "../../dashboard/orq-workspace.js"
  );
  return cliSlugRenderScope(async () =>
    standaloneDocument(
      "Red Team Security Report",
      await redteamReportTabs("", report, { standalone: true }),
    ),
  );
}

export async function simulationHtml(
  run: import("../../integrations/simulation/run-store.js").SimulationRun,
): Promise<string> {
  const { simulationReportTabs } = await import(
    "../../dashboard/simulation-report-tabs.js"
  );
  const { cliSlugRenderScope } = await import(
    "../../dashboard/orq-workspace.js"
  );
  return cliSlugRenderScope(async () =>
    standaloneDocument(
      "Agent Simulation Report",
      await simulationReportTabs("", run, { standalone: true }),
    ),
  );
}
