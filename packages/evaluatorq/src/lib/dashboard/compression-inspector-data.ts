import { open, stat } from "node:fs/promises";

import {
  capText,
  DEFAULT_JEV_OPTIONS,
  type EdgeLimit,
  type JevOptions,
  type JevState,
  jevState,
  serializedChars,
  stateOmittedMessages,
} from "../common/model-input.js";
import { scrubKnownSecrets } from "../common/redact.js";
import {
  ensureTraceDocument,
  type TraceDocument,
  toChatMessages,
  traceDocumentJson,
} from "../common/trace-document.js";
import {
  fullConversationView,
  MESSAGE_KINDS,
  type MessageKind,
  type ToolsMode,
  WHOLE,
} from "../insights/conversation-view.js";
import {
  READABLE_STYLE_FLAGS,
  ReadableStyle,
} from "../insights/readable-style.js";
import { fullConversationViewWithMessageSpans } from "../insights/transcript.js";
import { FacetSelection, NumericFilters } from "../trace-finder/models.js";
import {
  type OrqSourceClient,
  OrqTraceSource,
} from "../trace-finder/orq-source.js";
import { requireCompleteTargetedLoad } from "../trace-finder/orq-source-data.js";

export { READABLE_STYLE_FLAGS };

const SAFE_ORQ_ERROR = "The selected Orq trace could not be loaded.";

export const MAX_KNOB_CHARS = 5_000_000;
export const TOOLS_MODES: readonly ToolsMode[] = ["collapsed", "per_call"];
export type OriginalView = "atif" | "source" | "readable";
export const ORIGINAL_VIEWS: readonly OriginalView[] = [
  "atif",
  "source",
  "readable",
];
export const ORIGINAL_VIEW_LABELS: Readonly<Record<OriginalView, string>> = {
  atif: "ATIF trajectory",
  source: "raw source file",
  readable: "readable text",
};
export const ORIGINAL_CHARS = 2_000_000;
export const SOURCE_BYTES = 5_000_000;

type EdgePart = "assistant" | "user" | "system" | "toolInput" | "toolResult";
export const JEV_EDGE_FIELDS: Readonly<
  Record<string, readonly [string, string]>
> = {
  assistant: ["jev_assistant_total", "jev_assistant_edge"],
  user: ["jev_user_total", "jev_user_edge"],
  system: ["jev_system_total", "jev_system_edge"],
  tool_input: ["jev_tool_input_total", "jev_tool_input_edge"],
  tool_result: ["jev_tool_result_total", "jev_tool_result_edge"],
};
const EDGE_ATTRIBUTES: Readonly<Record<string, EdgePart>> = {
  assistant: "assistant",
  user: "user",
  system: "system",
  tool_input: "toolInput",
  tool_result: "toolResult",
};
export const JEV_FLAGS = [
  "system",
  "developer",
  "user",
  "assistant",
  "tool_calls",
  "tool_results",
] as const;
const JEV_FLAG_ATTRIBUTES = {
  system: "includeSystem",
  developer: "includeDeveloper",
  user: "includeUser",
  assistant: "includeAssistant",
  tool_calls: "includeToolCalls",
  tool_results: "includeToolResults",
} as const;
export const JEV_FORMAT_FLAGS = [
  "located_omission",
  "field_order",
  "drop_empty",
] as const;
const JEV_FORMAT_ATTRIBUTES = {
  located_omission: "locatedOmission",
  field_order: "fieldOrder",
  drop_empty: "dropEmpty",
} as const;

export type ViewCap =
  | "system_chars"
  | "user_chars"
  | "assistant_edge"
  | "reasoning_chars"
  | "tool_input_chars"
  | "tool_max_chars";
export const VIEW_CAP_FIELDS: Readonly<Record<string, ViewCap>> = {
  view_system_chars: "system_chars",
  view_user_chars: "user_chars",
  view_assistant_edge: "assistant_edge",
  view_reasoning_chars: "reasoning_chars",
  view_tool_input_chars: "tool_input_chars",
  view_tool_max_chars: "tool_max_chars",
};

/** An invalid knob value; the text names the field and its allowed range and never echoes the input. */
export class KnobError extends Error {
  override name = "KnobError";
}

export type FormValues = Record<string, number | string | boolean>;
export type FormInput =
  | { get(name: string): unknown }
  | Record<string, unknown>;

const formGet = (form: FormInput, name: string): unknown =>
  typeof (form as { get?: unknown }).get === "function"
    ? ((form as { get(name: string): unknown }).get(name) ?? null)
    : ((form as Record<string, unknown>)[name] ?? null);

const thousands = (n: number) => n.toLocaleString("en-US");

function whole(
  form: FormInput,
  name: string,
  label: string,
  options: { minimum?: number; keepWhole?: boolean } = {},
): number {
  const minimum = options.minimum ?? 1;
  const raw = formGet(form, name);
  const text = String(raw || "").trim();
  if (/^-?\d{1,9}$/.test(text)) {
    const value = Number.parseInt(text, 10);
    if (
      (minimum <= value && value <= MAX_KNOB_CHARS) ||
      (options.keepWhole && value === -1)
    )
      return value;
  }
  let allowed = `${thousands(minimum)} to ${thousands(MAX_KNOB_CHARS)}`;
  if (options.keepWhole) allowed = `-1 (whole) or ${allowed}`;
  throw new KnobError(`${label}: enter a whole number, ${allowed}.`);
}

const checked = (form: FormInput, name: string) => formGet(form, name) !== null;

function choice<T extends string>(
  form: FormInput,
  name: string,
  label: string,
  options: readonly T[],
): T {
  const text = String(formGet(form, name) || "");
  const found = options.find((option) => option === text);
  if (found === undefined)
    throw new KnobError(`${label}: choose one of the listed options.`);
  return found;
}

function edgeLimit(form: FormInput, part: string): EdgeLimit {
  const [totalName, edgeName] = JEV_EDGE_FIELDS[part] as readonly [
    string,
    string,
  ];
  const label = `Jev ${part.replaceAll("_", " ")} limit`;
  const total = whole(form, totalName, `${label} total`);
  const edge = whole(form, edgeName, `${label} edge`);
  if (edge * 2 > total)
    throw new KnobError(`${label}: the edge must be at most half the total.`);
  return { total, edge };
}

const SORTED_KINDS = [...MESSAGE_KINDS].sort();

export interface CompressionKnobsFields {
  global_char_cap: number;
  jev?: Readonly<JevOptions>;
  budget?: number;
  include?: ReadonlySet<MessageKind>;
  system_chars?: number;
  user_chars?: number;
  assistant_edge?: number;
  reasoning_chars?: number;
  tools?: ToolsMode;
  tool_input_chars?: number;
  tool_max_chars?: number;
  original_view?: OriginalView;
  wrap?: boolean;
  coverage?: boolean;
  style?: ReadableStyle;
}

/** Every compression setting the inspector exposes: the Jev state limits and the readable-view options. */
export class CompressionKnobs {
  readonly global_char_cap: number;
  readonly jev: Readonly<JevOptions>;
  readonly budget: number;
  readonly include: ReadonlySet<MessageKind>;
  readonly system_chars: number;
  readonly user_chars: number;
  readonly assistant_edge: number;
  readonly reasoning_chars: number;
  readonly tools: ToolsMode;
  readonly tool_input_chars: number;
  readonly tool_max_chars: number;
  readonly original_view: OriginalView;
  readonly wrap: boolean;
  readonly coverage: boolean;
  readonly style: ReadableStyle;

  constructor(fields: CompressionKnobsFields) {
    this.global_char_cap = fields.global_char_cap;
    this.jev = fields.jev ?? DEFAULT_JEV_OPTIONS;
    this.budget = fields.budget ?? 0;
    this.include = fields.include ?? WHOLE.include;
    this.system_chars = fields.system_chars ?? -1;
    this.user_chars = fields.user_chars ?? -1;
    this.assistant_edge = fields.assistant_edge ?? -1;
    this.reasoning_chars = fields.reasoning_chars ?? -1;
    this.tools = fields.tools ?? "per_call";
    this.tool_input_chars = fields.tool_input_chars ?? -1;
    this.tool_max_chars = fields.tool_max_chars ?? -1;
    this.original_view = fields.original_view ?? "atif";
    this.wrap = fields.wrap ?? false;
    this.coverage = fields.coverage ?? false;
    this.style = fields.style ?? new ReadableStyle();
    Object.freeze(this);
  }

  /** Enable inspector-only formatting beside the classifier's existing part limits. */
  static defaults(globalCharCap: number): CompressionKnobs {
    return new CompressionKnobs({
      global_char_cap: globalCharCap,
      budget: globalCharCap,
      coverage: true,
      jev: Object.freeze({
        ...DEFAULT_JEV_OPTIONS,
        locatedOmission: true,
        fieldOrder: true,
        dropEmpty: true,
      }),
      style: new ReadableStyle(
        Object.fromEntries(READABLE_STYLE_FLAGS.map((flag) => [flag, true])),
      ),
    });
  }

  /** Flatten to the form fields the inspector posts; `fromForm` reads them back. */
  asForm(): FormValues {
    const values: FormValues = {
      global_char_cap: this.global_char_cap,
      jev_state_chars: this.jev.stateChars,
      view_budget: this.budget,
      view_tools: this.tools,
      original_view: this.original_view,
      wrap: this.wrap,
      coverage: this.coverage,
    };
    for (const [part, [totalName, edgeName]] of Object.entries(
      JEV_EDGE_FIELDS,
    )) {
      const limit = this.jev[EDGE_ATTRIBUTES[part] as EdgePart];
      values[totalName] = limit.total;
      values[edgeName] = limit.edge;
    }
    for (const flag of JEV_FLAGS)
      values[`jev_include_${flag}`] = this.jev[JEV_FLAG_ATTRIBUTES[flag]];
    for (const flag of JEV_FORMAT_FLAGS)
      values[`jev_${flag}`] = this.jev[JEV_FORMAT_ATTRIBUTES[flag]];
    for (const flag of READABLE_STYLE_FLAGS)
      values[`view_${flag}`] = this.style[flag];
    for (const kind of SORTED_KINDS)
      values[`view_include_${kind}`] = this.include.has(kind);
    for (const [name, attribute] of Object.entries(VIEW_CAP_FIELDS))
      values[name] = this[attribute];
    return values;
  }

  /** Parse and validate the posted fields; every number must be present and in range. */
  static fromForm(form: FormInput): CompressionKnobs {
    const jev: JevOptions = {
      ...DEFAULT_JEV_OPTIONS,
      stateChars: whole(form, "jev_state_chars", "Jev state limit"),
      assistant: edgeLimit(form, "assistant"),
      user: edgeLimit(form, "user"),
      system: edgeLimit(form, "system"),
      toolInput: edgeLimit(form, "tool_input"),
      toolResult: edgeLimit(form, "tool_result"),
    };
    for (const flag of JEV_FLAGS)
      jev[JEV_FLAG_ATTRIBUTES[flag]] = checked(form, `jev_include_${flag}`);
    for (const flag of JEV_FORMAT_FLAGS)
      jev[JEV_FORMAT_ATTRIBUTES[flag]] = checked(form, `jev_${flag}`);
    const caps = {} as Record<ViewCap, number>;
    for (const [name, attribute] of Object.entries(VIEW_CAP_FIELDS))
      caps[attribute] = whole(
        form,
        name,
        `Readable view ${attribute.replaceAll("_", " ")}`,
        {
          minimum: attribute === "tool_max_chars" ? 0 : 1,
          keepWhole: true,
        },
      );
    return new CompressionKnobs({
      global_char_cap: whole(form, "global_char_cap", "Global character cap"),
      jev: Object.freeze(jev),
      budget: whole(form, "view_budget", "Readable view budget"),
      include: new Set(
        SORTED_KINDS.filter((kind) => checked(form, `view_include_${kind}`)),
      ),
      tools: choice(
        form,
        "view_tools",
        "Readable view tool display",
        TOOLS_MODES,
      ),
      original_view: choice(
        form,
        "original_view",
        "Original shows",
        ORIGINAL_VIEWS,
      ),
      wrap: checked(form, "wrap"),
      coverage: checked(form, "coverage"),
      style: new ReadableStyle(
        Object.fromEntries(
          READABLE_STYLE_FLAGS.map((flag) => [
            flag,
            checked(form, `view_${flag}`),
          ]),
        ),
      ),
      ...caps,
    });
  }
}

/** The readable view and the structured Jev state of one document under a set of knobs. */
export interface CompressionPreview {
  readable: string;
  original: string;
  original_view: OriginalView;
  original_note: string;
  compressed: JevState;
  original_chars: number;
  full_json_chars: number;
  transcript_chars: number;
  readable_chars: number;
  compressed_chars: number;
  message_count: number;
  omitted_messages: number;
  global_cap: number;
  readable_body_present: boolean;
}

/** Character reduction against the complete compact trace JSON; negative means expansion. */
export const readableReductionPercent = (preview: CompressionPreview) =>
  100 * (1 - preview.readable_chars / preview.full_json_chars);
export const jevReductionPercent = (preview: CompressionPreview) =>
  100 * (1 - preview.compressed_chars / preview.full_json_chars);

/** A source failure whose text is fixed and cannot expose selected input or provider data. */
export class InspectorSourceError extends Error {
  override name = "InspectorSourceError";
  constructor(..._args: unknown[]) {
    super(SAFE_ORQ_ERROR);
  }
}

const charCount = (text: string) => Array.from(text).length;

/** Render a local-only preview without mutating its canonical document or calling a model. */
export async function previewDocument(
  document: TraceDocument,
  options: { knobs: CompressionKnobs; sourcePath?: string | null },
): Promise<CompressionPreview> {
  const { knobs } = options;
  const compressed = jevState(toChatMessages(document), {
    globalCharCap: knobs.global_char_cap,
    options: { ...knobs.jev, coverage: knobs.coverage },
  });
  const [full, , messageCount] = fullConversationViewWithMessageSpans(document);
  const renderReadable = (coverage: boolean) =>
    String(
      fullConversationView(document, knobs.budget, WHOLE, {
        include: knobs.include,
        system_chars: knobs.system_chars,
        user_chars: knobs.user_chars,
        assistant_edge: knobs.assistant_edge,
        reasoning_chars: knobs.reasoning_chars,
        tools: knobs.tools,
        tool_input_chars: knobs.tool_input_chars,
        tool_max_chars: knobs.tool_max_chars,
        style: knobs.style,
        coverage_header: coverage,
      }),
    );
  const body = renderReadable(false);
  const readable = knobs.coverage ? renderReadable(true) : body;
  const [original, note] = await originalText(
    document,
    knobs.original_view,
    readable,
    options.sourcePath ?? null,
  );
  return {
    readable,
    original,
    original_view: knobs.original_view,
    original_note: note,
    compressed,
    original_chars: charCount(original),
    full_json_chars: charCount(traceDocumentJson(document)),
    transcript_chars: charCount(String(full)),
    readable_chars: charCount(readable),
    compressed_chars: serializedChars(compressed),
    message_count: messageCount,
    omitted_messages: stateOmittedMessages(compressed),
    global_cap: knobs.global_char_cap,
    readable_body_present: Boolean(body),
  };
}

async function originalText(
  document: TraceDocument,
  view: OriginalView,
  readable: string,
  sourcePath: string | null,
): Promise<[string, string]> {
  const notes: string[] = [];
  let text: string;
  if (view === "atif")
    text = traceDocumentJson(document, { indent: 2, excludeNone: true });
  else if (view === "readable") text = readable;
  else if (sourcePath === null)
    throw new KnobError(
      "Original shows: the raw source is only available for local sessions; choose another view.",
    );
  else {
    let data: Buffer;
    let total: number;
    try {
      const handle = await open(sourcePath, "r");
      try {
        const buffer = Buffer.alloc(SOURCE_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SOURCE_BYTES, 0);
        data = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      total = (await stat(sourcePath)).size;
    } catch {
      throw new KnobError("Original shows: the source file could not be read.");
    }
    if (total > data.length)
      notes.push(
        `Showing the first ${thousands(data.length)} of ${thousands(total)} bytes of the source file.`,
      );
    text = new TextDecoder("utf-8").decode(data);
  }
  const [shown, omitted] = capText(scrubKnownSecrets(text), ORIGINAL_CHARS);
  if (omitted)
    notes.push(
      `Cut to ${thousands(ORIGINAL_CHARS)} characters; ${thousands(omitted)} characters are left out.`,
    );
  return [String(shown), notes.join(" ")];
}

export function inspectorWindow(
  start: Date | null = null,
  end: Date | null = null,
): [Date, Date] {
  const resolvedEnd = end ?? new Date();
  const resolvedStart =
    start ?? new Date(resolvedEnd.getTime() - 7 * 24 * 3600 * 1000);
  if (
    Number.isNaN(resolvedStart.getTime()) ||
    Number.isNaN(resolvedEnd.getTime()) ||
    resolvedStart > resolvedEnd
  )
    throw new InspectorSourceError();
  return [resolvedStart, resolvedEnd];
}

/**
 * Load one Orq document with a client the caller built for the selected dashboard account.
 * Every failure becomes one fixed message so identifiers, credentials and provider payloads never reach the page.
 */
export async function fetchOrqDocument(
  buildClient: () => Promise<OrqSourceClient>,
  traceId: string,
  window: { start?: Date | null; end?: Date | null } = {},
): Promise<TraceDocument | null> {
  let start: Date;
  let end: Date;
  let client: OrqSourceClient;
  try {
    [start, end] = inspectorWindow(window.start ?? null, window.end ?? null);
    client = await buildClient();
  } catch {
    throw new InspectorSourceError();
  }
  let source: OrqTraceSource | null = null;
  try {
    source = new OrqTraceSource(client);
    const snapshot = await source.loadAsync({
      start,
      end,
      limit: 1,
      facets: new FacetSelection(),
      numeric: new NumericFilters(),
      targetTraceIds: new Set([traceId]),
    });
    requireCompleteTargetedLoad(snapshot, {
      errorType: InspectorSourceError,
      operation: "Loading selected Orq trace",
    });
    const record = snapshot.traces.find((item) => item.traceId === traceId);
    return record ? ensureTraceDocument(record) : null;
  } catch {
    throw new InspectorSourceError();
  } finally {
    try {
      source?.close();
    } catch (error) {
      console.warn(
        `Compression inspector source cleanup failed (${(error as Error)?.name ?? "Error"})`,
      );
    }
  }
}
