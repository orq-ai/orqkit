import type { ReportSection } from "../../contracts.js";
import { detailsBlock } from "./md-helpers.js";

export type RendererRegistry = Partial<
  Record<
    ReportSection["kind"],
    (section: ReportSection) => string | Promise<string>
  >
>;

export function renderHeaderMd(options: {
  title: string;
  rows: Iterable<readonly [string, string]>;
}): string {
  const lines = [`# ${options.title}`, ""];
  for (const [label, value] of options.rows) {
    lines.push(`**${label}:** ${value}  `);
  }
  return lines.join("\n");
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "unknown";
  }
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export async function renderMarkdown(
  sections: readonly ReportSection[],
  options: {
    renderers: RendererRegistry;
    collapsedKinds?: ReadonlySet<string>;
    header?: string;
    footer?: string;
  },
): Promise<string> {
  const { renderers, collapsedKinds, header = "", footer = "" } = options;
  const parts: string[] = [];
  if (header) {
    parts.push(header, "");
  }
  for (const section of sections) {
    const renderer = renderers[section.kind];
    if (!renderer) {
      console.warn(
        `No renderer registered for section kind '${section.kind}'; the section will be missing from the markdown report.`,
      );
      continue;
    }
    let rendered = await renderer(section);
    if (!rendered) {
      continue;
    }
    if (collapsedKinds?.has(section.kind)) {
      const headingPrefix = `## ${section.title}\n`;
      if (rendered.startsWith(headingPrefix)) {
        rendered = rendered.slice(headingPrefix.length).replace(/^\n+/, "");
      }
      rendered = detailsBlock(String(section.title), rendered);
    }
    parts.push(rendered, "");
  }
  if (footer) {
    parts.push(footer);
  }
  return parts.join("\n");
}

export async function renderBody(
  sections: readonly ReportSection[],
  options: {
    renderers: RendererRegistry;
    bodyHeader?: string;
    bodyFooter?: string;
  },
): Promise<string> {
  const { renderers, bodyHeader = "", bodyFooter = "" } = options;
  const parts: string[] = [];
  if (bodyHeader) {
    parts.push(bodyHeader);
  }
  for (const section of sections) {
    const renderer = renderers[section.kind];
    if (!renderer) {
      console.warn(
        `No renderer registered for section kind '${section.kind}'; the section will be missing from the HTML report.`,
      );
      continue;
    }
    const rendered = await renderer(section);
    if (rendered) {
      parts.push(rendered);
    }
  }
  if (bodyFooter) {
    parts.push(bodyFooter);
  }
  return parts.join("\n");
}

export async function renderHtml(
  sections: readonly ReportSection[],
  options: {
    renderers: RendererRegistry;
    head?: string;
    bodyHeader?: string;
    bodyFooter?: string;
  },
): Promise<string> {
  const { head = "", ...bodyOptions } = options;
  const bodyHtml = await renderBody(sections, bodyOptions);
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    `<head>\n${head}\n</head>\n` +
    '<body>\n<div class="container">\n' +
    `${bodyHtml}\n` +
    "</div>\n</body>\n" +
    "</html>\n"
  );
}
