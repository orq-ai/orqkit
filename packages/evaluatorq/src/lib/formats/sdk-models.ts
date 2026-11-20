import { z } from "zod/v4";

// Python's pinned SDK supplies runtime validation; TypeScript SDK unions are erased.
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null);
const sdkDictionary = z
  .custom<Record<string, unknown>>(record)
  .transform((v) => Object.fromEntries(Object.entries(v)));
const numeric = (v: unknown): unknown => {
  if (typeof v === "boolean") return Number(v);
  if (
    typeof v !== "string" ||
    !/^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i.test(
      v.trim(),
    )
  )
    return v;
  const s = v.trim().replaceAll("_", "");
  if (/^[+-]?inf(?:inity)?$/i.test(s))
    return s.startsWith("-") ? -Infinity : Infinity;
  return Number(s);
};
const sdkFloat = z.preprocess(
  numeric,
  z.custom<number>((v) => typeof v === "number"),
);
const sdkInteger = z.preprocess(
  (v) =>
    typeof v === "string" && !/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(v.trim())
      ? v
      : numeric(v),
  z.number().int(),
);
const sdkBoolean = z.preprocess((v) => {
  if (v === 0 || v === 1) return Boolean(v);
  if (typeof v === "string") {
    if (["1", "true", "t", "yes", "y", "on"].includes(v.toLowerCase()))
      return true;
    if (["0", "false", "f", "no", "n", "off"].includes(v.toLowerCase()))
      return false;
  }
  return v;
}, z.boolean());
function sdkObject(shape: z.ZodRawShape, extras: boolean): z.ZodType<unknown> {
  const schema = z.object(shape);
  return sdkDictionary.transform((raw, ctx) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    return extras ? { ...raw, ...result.data } : result.data;
  });
}
function sdkRecord(schema: z.ZodType<unknown>): z.ZodType<unknown> {
  return sdkDictionary.transform((raw, ctx) =>
    Object.fromEntries(
      Object.entries(raw).map(([key, value]) => {
        const result = schema.safeParse(value);
        if (!result.success) {
          for (const issue of result.error.issues)
            ctx.addIssue({ ...issue, path: [key, ...issue.path] });
          return [key, z.NEVER];
        }
        return [key, result.data];
      }),
    ),
  );
}
const models: Record<string, z.ZodType<unknown>> = {};
function model(key: string): z.ZodType<unknown> {
  const schema = models[key];
  if (!schema) throw new TypeError(`Missing pinned SDK model ${key}`);
  return schema;
}

models.output_AcknowledgedSafetyCheck = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    code: z.union([z.string(), z.null()]).default(null),
    message: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_Action = sdkObject(
  {
    commands: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    max_output_length: z.union([sdkInteger, z.null()]).default(null),
    timeout_ms: z.union([sdkInteger, z.null()]).default(null),
  },
  true,
);
models.output_ActionClick = sdkObject(
  {
    button: z
      .enum(["left", "right", "wheel", "back", "forward"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("click")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_ActionDoubleClick = sdkObject(
  {
    keys: z.union([z.array(z.string()), z.null()]).default(null),
    type: z
      .literal("double_click")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionDrag = sdkObject(
  {
    path: z
      .array(z.lazy(() => model("output_ActionDragPath")))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("drag")
      .refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_ActionDragPath = sdkObject(
  {
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionFind = sdkObject(
  {
    pattern: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("find_in_page")
      .refine((value) => value !== undefined, "Required field"),
    url: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionKeypress = sdkObject(
  {
    keys: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("keypress")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionMove = sdkObject(
  {
    type: z
      .literal("move")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_ActionOpenPage = sdkObject(
  {
    type: z
      .literal("open_page")
      .refine((value) => value !== undefined, "Required field"),
    url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ActionScreenshot = sdkObject(
  {
    type: z
      .literal("screenshot")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionScroll = sdkObject(
  {
    scroll_x: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    scroll_y: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("scroll")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_ActionSearch = sdkObject(
  {
    query: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("search")
      .refine((value) => value !== undefined, "Required field"),
    queries: z.union([z.array(z.string()), z.null()]).default(null),
    sources: z
      .union([
        z.array(z.lazy(() => model("output_ActionSearchSource"))),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ActionSearchSource = sdkObject(
  {
    type: z
      .literal("url")
      .refine((value) => value !== undefined, "Required field"),
    url: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionType = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("type")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ActionWait = sdkObject(
  {
    type: z
      .literal("wait")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_AnnotationContainerFileCitation = sdkObject(
  {
    container_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    end_index: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    file_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    filename: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    start_index: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("container_file_citation")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_AnnotationFileCitation = sdkObject(
  {
    file_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    filename: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    index: sdkInteger.refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("file_citation")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_AnnotationFilePath = sdkObject(
  {
    file_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    index: sdkInteger.refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("file_path")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_AnnotationURLCitation = sdkObject(
  {
    end_index: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    start_index: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    title: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("url_citation")
      .refine((value) => value !== undefined, "Required field"),
    url: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ApplyPatchTool = sdkObject(
  {
    type: z
      .literal("apply_patch")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Click = sdkObject(
  {
    button: z
      .enum(["left", "right", "wheel", "back", "forward"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("click")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_CodeInterpreter = sdkObject(
  {
    container: z
      .union([
        z.string(),
        z.lazy(() =>
          model("output_CodeInterpreterContainerCodeInterpreterToolAuto"),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("code_interpreter")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_CodeInterpreterContainerCodeInterpreterToolAuto = sdkObject(
  {
    type: z
      .literal("auto")
      .refine((value) => value !== undefined, "Required field"),
    file_ids: z.union([z.array(z.string()), z.null()]).default(null),
    memory_limit: z
      .union([z.enum(["1g", "4g", "16g", "64g"]), z.null()])
      .default(null),
    network_policy: z
      .union([
        z.lazy(() => model("output_ContainerNetworkPolicyDisabled")),
        z.lazy(() => model("output_ContainerNetworkPolicyAllowlist")),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ComparisonFilter = sdkObject(
  {
    key: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"])
      .refine((value) => value !== undefined, "Required field"),
    value: z
      .union([
        z.string(),
        sdkFloat,
        sdkBoolean,
        z.array(z.union([z.string(), sdkFloat])),
      ])
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_CompoundFilter = sdkObject(
  {
    filters: z
      .array(
        z.union([z.lazy(() => model("output_ComparisonFilter")), z.unknown()]),
      )
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .enum(["and", "or"])
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ComputerTool = sdkObject(
  {
    type: z
      .literal("computer")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ComputerUsePreviewTool = sdkObject(
  {
    display_height: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    display_width: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    environment: z
      .enum(["windows", "mac", "linux", "ubuntu", "browser"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("computer_use_preview")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ContainerAuto = sdkObject(
  {
    type: z
      .literal("container_auto")
      .refine((value) => value !== undefined, "Required field"),
    file_ids: z.union([z.array(z.string()), z.null()]).default(null),
    memory_limit: z
      .union([z.enum(["1g", "4g", "16g", "64g"]), z.null()])
      .default(null),
    network_policy: z
      .union([
        z.lazy(() => model("output_ContainerNetworkPolicyDisabled")),
        z.lazy(() => model("output_ContainerNetworkPolicyAllowlist")),
        z.null(),
      ])
      .default(null),
    skills: z
      .union([
        z.array(
          z.union([
            z.lazy(() => model("output_SkillReference")),
            z.lazy(() => model("output_InlineSkill")),
          ]),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ContainerNetworkPolicyAllowlist = sdkObject(
  {
    allowed_domains: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("allowlist")
      .refine((value) => value !== undefined, "Required field"),
    domain_secrets: z
      .union([
        z.array(
          z.lazy(() => model("output_ContainerNetworkPolicyDomainSecret")),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ContainerNetworkPolicyDisabled = sdkObject(
  {
    type: z
      .literal("disabled")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ContainerNetworkPolicyDomainSecret = sdkObject(
  {
    domain: z.string().refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    value: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ContainerReference = sdkObject(
  {
    container_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("container_reference")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Content = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("reasoning_text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_CustomTool = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("custom")
      .refine((value) => value !== undefined, "Required field"),
    defer_loading: z.union([sdkBoolean, z.null()]).default(null),
    description: z.union([z.string(), z.null()]).default(null),
    format: z
      .union([
        z.lazy(() => model("output_Text")),
        z.lazy(() => model("output_Grammar")),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_DoubleClick = sdkObject(
  {
    keys: z.union([z.array(z.string()), z.null()]).default(null),
    type: z
      .literal("double_click")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Drag = sdkObject(
  {
    path: z
      .array(z.lazy(() => model("output_DragPath")))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("drag")
      .refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_DragPath = sdkObject(
  {
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_FileSearchTool = sdkObject(
  {
    type: z
      .literal("file_search")
      .refine((value) => value !== undefined, "Required field"),
    vector_store_ids: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    filters: z
      .union([
        z.lazy(() => model("output_ComparisonFilter")),
        z.lazy(() => model("output_CompoundFilter")),
        z.null(),
      ])
      .default(null),
    max_num_results: z.union([sdkInteger, z.null()]).default(null),
    ranking_options: z
      .union([z.lazy(() => model("output_RankingOptions")), z.null()])
      .default(null),
  },
  true,
);
models.output_Filters = sdkObject(
  { allowed_domains: z.union([z.array(z.string()), z.null()]).default(null) },
  true,
);
models.output_FunctionShellTool = sdkObject(
  {
    type: z
      .literal("shell")
      .refine((value) => value !== undefined, "Required field"),
    environment: z
      .union([
        z.lazy(() => model("output_ContainerAuto")),
        z.lazy(() => model("output_LocalEnvironment")),
        z.lazy(() => model("output_ContainerReference")),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_FunctionTool = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    parameters: z.union([sdkDictionary, z.null()]).default(null),
    strict: z.union([sdkBoolean, z.null()]).default(null),
    type: z
      .literal("function")
      .refine((value) => value !== undefined, "Required field"),
    defer_loading: z.union([sdkBoolean, z.null()]).default(null),
    description: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_Grammar = sdkObject(
  {
    definition: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    syntax: z
      .enum(["lark", "regex"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("grammar")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ImageGeneration = sdkObject(
  {
    type: z
      .literal("image_generation")
      .refine((value) => value !== undefined, "Required field"),
    action: z
      .union([z.enum(["generate", "edit", "auto"]), z.null()])
      .default(null),
    background: z
      .union([z.enum(["transparent", "opaque", "auto"]), z.null()])
      .default(null),
    input_fidelity: z.union([z.enum(["high", "low"]), z.null()]).default(null),
    input_image_mask: z
      .union([
        z.lazy(() => model("output_ImageGenerationInputImageMask")),
        z.null(),
      ])
      .default(null),
    model: z
      .union([
        z.string(),
        z.enum(["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"]),
        z.null(),
      ])
      .default(null),
    moderation: z.union([z.enum(["auto", "low"]), z.null()]).default(null),
    output_compression: z.union([sdkInteger, z.null()]).default(null),
    output_format: z
      .union([z.enum(["png", "webp", "jpeg"]), z.null()])
      .default(null),
    partial_images: z.union([sdkInteger, z.null()]).default(null),
    quality: z
      .union([z.enum(["low", "medium", "high", "auto"]), z.null()])
      .default(null),
    size: z
      .union([
        z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ImageGenerationCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    result: z.union([z.string(), z.null()]).default(null),
    status: z
      .enum(["in_progress", "completed", "generating", "failed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("image_generation_call")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ImageGenerationInputImageMask = sdkObject(
  {
    file_id: z.union([z.string(), z.null()]).default(null),
    image_url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_InlineSkill = sdkObject(
  {
    description: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    source: z
      .lazy(() => model("output_InlineSkillSource"))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("inline")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_InlineSkillSource = sdkObject(
  {
    data: z.string().refine((value) => value !== undefined, "Required field"),
    media_type: z
      .literal("application/zip")
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("base64")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Keypress = sdkObject(
  {
    keys: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("keypress")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_LocalEnvironment = sdkObject(
  {
    type: z
      .literal("local")
      .refine((value) => value !== undefined, "Required field"),
    skills: z
      .union([z.array(z.lazy(() => model("output_LocalSkill"))), z.null()])
      .default(null),
  },
  true,
);
models.output_LocalShell = sdkObject(
  {
    type: z
      .literal("local_shell")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_LocalShellCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    action: z
      .lazy(() => model("output_LocalShellCallAction"))
      .refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("local_shell_call")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_LocalShellCallAction = sdkObject(
  {
    command: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    env: sdkRecord(z.string()).refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("exec")
      .refine((value) => value !== undefined, "Required field"),
    timeout_ms: z.union([sdkInteger, z.null()]).default(null),
    user: z.union([z.string(), z.null()]).default(null),
    working_directory: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_LocalShellCallOutput = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    output: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("local_shell_call_output")
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.output_LocalSkill = sdkObject(
  {
    description: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    path: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Logprob = sdkObject(
  {
    token: z.string().refine((value) => value !== undefined, "Required field"),
    bytes: z
      .array(sdkInteger)
      .refine((value) => value !== undefined, "Required field"),
    logprob: sdkFloat.refine((value) => value !== undefined, "Required field"),
    top_logprobs: z
      .array(z.lazy(() => model("output_LogprobTopLogprob")))
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_LogprobTopLogprob = sdkObject(
  {
    token: z.string().refine((value) => value !== undefined, "Required field"),
    bytes: z
      .array(sdkInteger)
      .refine((value) => value !== undefined, "Required field"),
    logprob: sdkFloat.refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Mcp = sdkObject(
  {
    server_label: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("mcp")
      .refine((value) => value !== undefined, "Required field"),
    allowed_tools: z
      .union([
        z.array(z.string()),
        z.lazy(() => model("output_McpAllowedToolsMcpToolFilter")),
        z.null(),
      ])
      .default(null),
    authorization: z.union([z.string(), z.null()]).default(null),
    connector_id: z
      .union([
        z.enum([
          "connector_dropbox",
          "connector_gmail",
          "connector_googlecalendar",
          "connector_googledrive",
          "connector_microsoftteams",
          "connector_outlookcalendar",
          "connector_outlookemail",
          "connector_sharepoint",
        ]),
        z.null(),
      ])
      .default(null),
    defer_loading: z.union([sdkBoolean, z.null()]).default(null),
    headers: z.union([sdkRecord(z.string()), z.null()]).default(null),
    require_approval: z
      .union([
        z.lazy(() => model("output_McpRequireApprovalMcpToolApprovalFilter")),
        z.enum(["always", "never"]),
        z.null(),
      ])
      .default(null),
    server_description: z.union([z.string(), z.null()]).default(null),
    server_url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_McpAllowedToolsMcpToolFilter = sdkObject(
  {
    read_only: z.union([sdkBoolean, z.null()]).default(null),
    tool_names: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_McpApprovalRequest = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    arguments: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    server_label: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("mcp_approval_request")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_McpApprovalResponse = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    approval_request_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    approve: sdkBoolean.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("mcp_approval_response")
      .refine((value) => value !== undefined, "Required field"),
    reason: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_McpCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    arguments: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    server_label: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("mcp_call")
      .refine((value) => value !== undefined, "Required field"),
    approval_request_id: z.union([z.string(), z.null()]).default(null),
    error: z.union([z.string(), z.null()]).default(null),
    output: z.union([z.string(), z.null()]).default(null),
    status: z
      .union([
        z.enum(["in_progress", "completed", "incomplete", "calling", "failed"]),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_McpListTools = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    server_label: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    tools: z
      .array(z.lazy(() => model("output_McpListToolsTool")))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("mcp_list_tools")
      .refine((value) => value !== undefined, "Required field"),
    error: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_McpListToolsTool = sdkObject(
  {
    input_schema: z
      .unknown()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    annotations: z.union([z.unknown(), z.null()]).default(null),
    description: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_McpRequireApprovalMcpToolApprovalFilter = sdkObject(
  {
    always: z
      .union([
        z.lazy(() =>
          model("output_McpRequireApprovalMcpToolApprovalFilterAlways"),
        ),
        z.null(),
      ])
      .default(null),
    never: z
      .union([
        z.lazy(() =>
          model("output_McpRequireApprovalMcpToolApprovalFilterNever"),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_McpRequireApprovalMcpToolApprovalFilterAlways = sdkObject(
  {
    read_only: z.union([sdkBoolean, z.null()]).default(null),
    tool_names: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_McpRequireApprovalMcpToolApprovalFilterNever = sdkObject(
  {
    read_only: z.union([sdkBoolean, z.null()]).default(null),
    tool_names: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_Move = sdkObject(
  {
    type: z
      .literal("move")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_NamespaceTool = sdkObject(
  {
    description: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    tools: z
      .array(
        z.union([
          z.lazy(() => model("output_ToolFunction")),
          z.lazy(() => model("output_CustomTool")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("namespace")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OperationCreateFile = sdkObject(
  {
    diff: z.string().refine((value) => value !== undefined, "Required field"),
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("create_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OperationDeleteFile = sdkObject(
  {
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("delete_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OperationUpdateFile = sdkObject(
  {
    diff: z.string().refine((value) => value !== undefined, "Required field"),
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("update_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Output = sdkObject(
  {
    outcome: z
      .union([
        z.lazy(() => model("output_OutputOutcomeTimeout")),
        z.lazy(() => model("output_OutputOutcomeExit")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    stderr: z.string().refine((value) => value !== undefined, "Required field"),
    stdout: z.string().refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_OutputImage = sdkObject(
  {
    type: z
      .literal("image")
      .refine((value) => value !== undefined, "Required field"),
    url: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OutputLogs = sdkObject(
  {
    logs: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("logs")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OutputOutcomeExit = sdkObject(
  {
    exit_code: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("exit")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_OutputOutcomeTimeout = sdkObject(
  {
    type: z
      .literal("timeout")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_PendingSafetyCheck = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    code: z.union([z.string(), z.null()]).default(null),
    message: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_RankingOptions = sdkObject(
  {
    hybrid_search: z
      .union([
        z.lazy(() => model("output_RankingOptionsHybridSearch")),
        z.null(),
      ])
      .default(null),
    ranker: z
      .union([z.enum(["auto", "default-2024-11-15"]), z.null()])
      .default(null),
    score_threshold: z.union([sdkFloat, z.null()]).default(null),
  },
  true,
);
models.output_RankingOptionsHybridSearch = sdkObject(
  {
    embedding_weight: sdkFloat.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    text_weight: sdkFloat.refine(
      (value) => value !== undefined,
      "Required field",
    ),
  },
  true,
);
models.output_ResponseApplyPatchToolCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    operation: z
      .union([
        z.lazy(() => model("output_OperationCreateFile")),
        z.lazy(() => model("output_OperationDeleteFile")),
        z.lazy(() => model("output_OperationUpdateFile")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("apply_patch_call")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseApplyPatchToolCallOutput = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["completed", "failed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("apply_patch_call_output")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
    output: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseCodeInterpreterToolCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    code: z.union([z.string(), z.null()]).default(null),
    container_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    outputs: z
      .union([
        z.array(
          z.union([
            z.lazy(() => model("output_OutputLogs")),
            z.lazy(() => model("output_OutputImage")),
          ]),
        ),
        z.null(),
      ])
      .default(null),
    status: z
      .enum([
        "in_progress",
        "completed",
        "incomplete",
        "interpreting",
        "failed",
      ])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("code_interpreter_call")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseCompactionItem = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    encrypted_content: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("compaction")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseComputerToolCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    pending_safety_checks: z
      .array(z.lazy(() => model("output_PendingSafetyCheck")))
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("computer_call")
      .refine((value) => value !== undefined, "Required field"),
    action: z
      .union([
        z.lazy(() => model("output_ActionClick")),
        z.lazy(() => model("output_ActionDoubleClick")),
        z.lazy(() => model("output_ActionDrag")),
        z.lazy(() => model("output_ActionKeypress")),
        z.lazy(() => model("output_ActionMove")),
        z.lazy(() => model("output_ActionScreenshot")),
        z.lazy(() => model("output_ActionScroll")),
        z.lazy(() => model("output_ActionType")),
        z.lazy(() => model("output_ActionWait")),
        z.null(),
      ])
      .default(null),
    actions: z
      .union([
        z.array(
          z.union([
            z.lazy(() => model("output_Click")),
            z.lazy(() => model("output_DoubleClick")),
            z.lazy(() => model("output_Drag")),
            z.lazy(() => model("output_Keypress")),
            z.lazy(() => model("output_Move")),
            z.lazy(() => model("output_Screenshot")),
            z.lazy(() => model("output_Scroll")),
            z.lazy(() => model("output_Type")),
            z.lazy(() => model("output_Wait")),
          ]),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_ResponseComputerToolCallOutputItem = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .lazy(() => model("output_ResponseComputerToolCallOutputScreenshot"))
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["completed", "incomplete", "failed", "in_progress"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("computer_call_output")
      .refine((value) => value !== undefined, "Required field"),
    acknowledged_safety_checks: z
      .union([
        z.array(z.lazy(() => model("output_AcknowledgedSafetyCheck"))),
        z.null(),
      ])
      .default(null),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseComputerToolCallOutputScreenshot = sdkObject(
  {
    type: z
      .literal("computer_screenshot")
      .refine((value) => value !== undefined, "Required field"),
    file_id: z.union([z.string(), z.null()]).default(null),
    image_url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseContainerReference = sdkObject(
  {
    container_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("container_reference")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseCustomToolCall = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    input: z.string().refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("custom_tool_call")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    namespace: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseCustomToolCallOutputItem = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("output_ResponseInputText")),
            z.lazy(() => model("output_ResponseInputImage")),
            z.lazy(() => model("output_ResponseInputFile")),
          ]),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("custom_tool_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.string().refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseFileSearchToolCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    queries: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "searching", "completed", "incomplete", "failed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("file_search_call")
      .refine((value) => value !== undefined, "Required field"),
    results: z
      .union([z.array(z.lazy(() => model("output_Result"))), z.null()])
      .default(null),
  },
  true,
);
models.output_ResponseFunctionShellToolCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    action: z
      .lazy(() => model("output_Action"))
      .refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    environment: z
      .union([
        z.lazy(() => model("output_ResponseLocalEnvironment")),
        z.lazy(() => model("output_ResponseContainerReference")),
        z.null(),
      ])
      .default(null),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("shell_call")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseFunctionShellToolCallOutput = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    max_output_length: z.union([sdkInteger, z.null()]).default(null),
    output: z
      .array(z.lazy(() => model("output_Output")))
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("shell_call_output")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseFunctionToolCall = sdkObject(
  {
    arguments: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("function_call")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    namespace: z.union([z.string(), z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.output_ResponseFunctionToolCallOutputItem = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("output_ResponseInputText")),
            z.lazy(() => model("output_ResponseInputImage")),
            z.lazy(() => model("output_ResponseInputFile")),
          ]),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("function_call_output")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseFunctionWebSearch = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    action: z
      .union([
        z.lazy(() => model("output_ActionSearch")),
        z.lazy(() => model("output_ActionOpenPage")),
        z.lazy(() => model("output_ActionFind")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "searching", "completed", "failed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("web_search_call")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseInputFile = sdkObject(
  {
    type: z
      .literal("input_file")
      .refine((value) => value !== undefined, "Required field"),
    detail: z.union([z.enum(["high", "low"]), z.null()]).default(null),
    file_data: z.union([z.string(), z.null()]).default(null),
    file_id: z.union([z.string(), z.null()]).default(null),
    file_url: z.union([z.string(), z.null()]).default(null),
    filename: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseInputImage = sdkObject(
  {
    detail: z
      .enum(["low", "high", "auto", "original"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("input_image")
      .refine((value) => value !== undefined, "Required field"),
    file_id: z.union([z.string(), z.null()]).default(null),
    image_url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseInputText = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("input_text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseLocalEnvironment = sdkObject(
  {
    type: z
      .literal("local")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseOutputMessage = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    content: z
      .array(
        z.union([
          z.lazy(() => model("output_ResponseOutputText")),
          z.lazy(() => model("output_ResponseOutputRefusal")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    role: z
      .literal("assistant")
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("message")
      .refine((value) => value !== undefined, "Required field"),
    phase: z
      .union([z.enum(["commentary", "final_answer"]), z.null()])
      .default(null),
  },
  true,
);
models.output_ResponseOutputRefusal = sdkObject(
  {
    refusal: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("refusal")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ResponseOutputText = sdkObject(
  {
    annotations: z
      .array(
        z.union([
          z.lazy(() => model("output_AnnotationFileCitation")),
          z.lazy(() => model("output_AnnotationURLCitation")),
          z.lazy(() => model("output_AnnotationContainerFileCitation")),
          z.lazy(() => model("output_AnnotationFilePath")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("output_text")
      .refine((value) => value !== undefined, "Required field"),
    logprobs: z
      .union([z.array(z.lazy(() => model("output_Logprob"))), z.null()])
      .default(null),
  },
  true,
);
models.output_ResponseReasoningItem = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    summary: z
      .array(z.lazy(() => model("output_Summary")))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("reasoning")
      .refine((value) => value !== undefined, "Required field"),
    content: z
      .union([z.array(z.lazy(() => model("output_Content"))), z.null()])
      .default(null),
    encrypted_content: z.union([z.string(), z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.output_ResponseToolSearchCall = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    arguments: z
      .unknown()
      .refine((value) => value !== undefined, "Required field"),
    call_id: z.union([z.string(), z.null()]).default(null),
    execution: z
      .enum(["server", "client"])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("tool_search_call")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_ResponseToolSearchOutputItem = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    call_id: z.union([z.string(), z.null()]).default(null),
    execution: z
      .enum(["server", "client"])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed", "incomplete"])
      .refine((value) => value !== undefined, "Required field"),
    tools: z
      .array(
        z.union([
          z.lazy(() => model("output_FunctionTool")),
          z.lazy(() => model("output_FileSearchTool")),
          z.lazy(() => model("output_ComputerTool")),
          z.lazy(() => model("output_ComputerUsePreviewTool")),
          z.lazy(() => model("output_WebSearchTool")),
          z.lazy(() => model("output_Mcp")),
          z.lazy(() => model("output_CodeInterpreter")),
          z.lazy(() => model("output_ImageGeneration")),
          z.lazy(() => model("output_LocalShell")),
          z.lazy(() => model("output_FunctionShellTool")),
          z.lazy(() => model("output_CustomTool")),
          z.lazy(() => model("output_NamespaceTool")),
          z.lazy(() => model("output_ToolSearchTool")),
          z.lazy(() => model("output_WebSearchPreviewTool")),
          z.lazy(() => model("output_ApplyPatchTool")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("tool_search_output")
      .refine((value) => value !== undefined, "Required field"),
    created_by: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_Result = sdkObject(
  {
    attributes: z
      .union([sdkRecord(z.union([z.string(), sdkFloat, sdkBoolean])), z.null()])
      .default(null),
    file_id: z.union([z.string(), z.null()]).default(null),
    filename: z.union([z.string(), z.null()]).default(null),
    score: z.union([sdkFloat, z.null()]).default(null),
    text: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_Screenshot = sdkObject(
  {
    type: z
      .literal("screenshot")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Scroll = sdkObject(
  {
    scroll_x: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    scroll_y: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("scroll")
      .refine((value) => value !== undefined, "Required field"),
    x: sdkInteger.refine((value) => value !== undefined, "Required field"),
    y: sdkInteger.refine((value) => value !== undefined, "Required field"),
    keys: z.union([z.array(z.string()), z.null()]).default(null),
  },
  true,
);
models.output_SkillReference = sdkObject(
  {
    skill_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("skill_reference")
      .refine((value) => value !== undefined, "Required field"),
    version: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.output_Summary = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("summary_text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Text = sdkObject(
  {
    type: z
      .literal("text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_ToolFunction = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("function")
      .refine((value) => value !== undefined, "Required field"),
    defer_loading: z.union([sdkBoolean, z.null()]).default(null),
    description: z.union([z.string(), z.null()]).default(null),
    parameters: z.union([z.unknown(), z.null()]).default(null),
    strict: z.union([sdkBoolean, z.null()]).default(null),
  },
  true,
);
models.output_ToolSearchTool = sdkObject(
  {
    type: z
      .literal("tool_search")
      .refine((value) => value !== undefined, "Required field"),
    description: z.union([z.string(), z.null()]).default(null),
    execution: z.union([z.enum(["server", "client"]), z.null()]).default(null),
    parameters: z.union([z.unknown(), z.null()]).default(null),
  },
  true,
);
models.output_Type = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("type")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_Wait = sdkObject(
  {
    type: z
      .literal("wait")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.output_WebSearchPreviewTool = sdkObject(
  {
    type: z
      .enum(["web_search_preview", "web_search_preview_2025_03_11"])
      .refine((value) => value !== undefined, "Required field"),
    search_content_types: z
      .union([z.array(z.enum(["text", "image"])), z.null()])
      .default(null),
    search_context_size: z
      .union([z.enum(["low", "medium", "high"]), z.null()])
      .default(null),
    user_location: z
      .union([
        z.lazy(() =>
          model(
            "output_openai__types__responses__web_search_preview_tool__UserLocation",
          ),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_WebSearchTool = sdkObject(
  {
    type: z
      .enum(["web_search", "web_search_2025_08_26"])
      .refine((value) => value !== undefined, "Required field"),
    filters: z
      .union([z.lazy(() => model("output_Filters")), z.null()])
      .default(null),
    search_context_size: z
      .union([z.enum(["low", "medium", "high"]), z.null()])
      .default(null),
    user_location: z
      .union([
        z.lazy(() =>
          model(
            "output_openai__types__responses__web_search_tool__UserLocation",
          ),
        ),
        z.null(),
      ])
      .default(null),
  },
  true,
);
models.output_openai__types__responses__web_search_preview_tool__UserLocation =
  sdkObject(
    {
      type: z
        .literal("approximate")
        .refine((value) => value !== undefined, "Required field"),
      city: z.union([z.string(), z.null()]).default(null),
      country: z.union([z.string(), z.null()]).default(null),
      region: z.union([z.string(), z.null()]).default(null),
      timezone: z.union([z.string(), z.null()]).default(null),
    },
    true,
  );
models.output_openai__types__responses__web_search_tool__UserLocation =
  sdkObject(
    {
      city: z.union([z.string(), z.null()]).default(null),
      country: z.union([z.string(), z.null()]).default(null),
      region: z.union([z.string(), z.null()]).default(null),
      timezone: z.union([z.string(), z.null()]).default(null),
      type: z.union([z.literal("approximate"), z.null()]).default(null),
    },
    true,
  );
models.input_ApplyPatchCall = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    operation: z
      .union([
        z.lazy(() => model("input_ApplyPatchCallOperationCreateFile")),
        z.lazy(() => model("input_ApplyPatchCallOperationDeleteFile")),
        z.lazy(() => model("input_ApplyPatchCallOperationUpdateFile")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["in_progress", "completed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("apply_patch_call")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ApplyPatchCallOperationCreateFile = sdkObject(
  {
    diff: z.string().refine((value) => value !== undefined, "Required field"),
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("create_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ApplyPatchCallOperationDeleteFile = sdkObject(
  {
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("delete_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ApplyPatchCallOperationUpdateFile = sdkObject(
  {
    diff: z.string().refine((value) => value !== undefined, "Required field"),
    path: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("update_file")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ApplyPatchCallOutput = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .enum(["completed", "failed"])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("apply_patch_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    output: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ComputerCallOutput = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .lazy(() => model("output_ResponseComputerToolCallOutputScreenshot"))
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("computer_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    acknowledged_safety_checks: z
      .union([
        z.array(
          z.lazy(() =>
            model("input_ComputerCallOutputAcknowledgedSafetyCheck"),
          ),
        ),
        z.null(),
      ])
      .default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.input_ComputerCallOutputAcknowledgedSafetyCheck = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    code: z.union([z.string(), z.null()]).default(null),
    message: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_EasyInputMessage = sdkObject(
  {
    content: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("output_ResponseInputText")),
            z.lazy(() => model("output_ResponseInputImage")),
            z.lazy(() => model("output_ResponseInputFile")),
          ]),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    role: z
      .enum(["user", "assistant", "system", "developer"])
      .refine((value) => value !== undefined, "Required field"),
    phase: z
      .union([z.enum(["commentary", "final_answer"]), z.null()])
      .default(null),
    type: z.union([z.literal("message"), z.null()]).default(null),
  },
  true,
);
models.input_FunctionCallOutput = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("input_ResponseInputTextContent")),
            z.lazy(() => model("input_ResponseInputImageContent")),
            z.lazy(() => model("input_ResponseInputFileContent")),
          ]),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("function_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.input_ItemReference = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    type: z.union([z.literal("item_reference"), z.null()]).default(null),
  },
  true,
);
models.input_McpApprovalResponse = sdkObject(
  {
    approval_request_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    approve: sdkBoolean.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("mcp_approval_response")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    reason: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_Message = sdkObject(
  {
    content: z
      .array(
        z.union([
          z.lazy(() => model("output_ResponseInputText")),
          z.lazy(() => model("output_ResponseInputImage")),
          z.lazy(() => model("output_ResponseInputFile")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    role: z
      .enum(["user", "system", "developer"])
      .refine((value) => value !== undefined, "Required field"),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
    type: z.union([z.literal("message"), z.null()]).default(null),
  },
  true,
);
models.input_OutcomeExit = sdkObject(
  {
    exit_code: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("exit")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_OutcomeTimeout = sdkObject(
  {
    type: z
      .literal("timeout")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ResponseCompactionItemParam = sdkObject(
  {
    encrypted_content: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("compaction")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ResponseCustomToolCallOutput = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("output_ResponseInputText")),
            z.lazy(() => model("output_ResponseInputImage")),
            z.lazy(() => model("output_ResponseInputFile")),
          ]),
        ),
      ])
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("custom_tool_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ResponseFunctionShellCallOutputContent = sdkObject(
  {
    outcome: z
      .union([
        z.lazy(() => model("input_OutcomeTimeout")),
        z.lazy(() => model("input_OutcomeExit")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    stderr: z.string().refine((value) => value !== undefined, "Required field"),
    stdout: z.string().refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ResponseInputFileContent = sdkObject(
  {
    type: z
      .literal("input_file")
      .refine((value) => value !== undefined, "Required field"),
    detail: z.union([z.enum(["high", "low"]), z.null()]).default(null),
    file_data: z.union([z.string(), z.null()]).default(null),
    file_id: z.union([z.string(), z.null()]).default(null),
    file_url: z.union([z.string(), z.null()]).default(null),
    filename: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ResponseInputImageContent = sdkObject(
  {
    type: z
      .literal("input_image")
      .refine((value) => value !== undefined, "Required field"),
    detail: z
      .union([z.enum(["low", "high", "auto", "original"]), z.null()])
      .default(null),
    file_id: z.union([z.string(), z.null()]).default(null),
    image_url: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.input_ResponseInputTextContent = sdkObject(
  {
    text: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("input_text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.input_ResponseToolSearchOutputItemParam = sdkObject(
  {
    tools: z
      .array(
        z.union([
          z.lazy(() => model("output_FunctionTool")),
          z.lazy(() => model("output_FileSearchTool")),
          z.lazy(() => model("output_ComputerTool")),
          z.lazy(() => model("output_ComputerUsePreviewTool")),
          z.lazy(() => model("output_WebSearchTool")),
          z.lazy(() => model("output_Mcp")),
          z.lazy(() => model("output_CodeInterpreter")),
          z.lazy(() => model("output_ImageGeneration")),
          z.lazy(() => model("output_LocalShell")),
          z.lazy(() => model("output_FunctionShellTool")),
          z.lazy(() => model("output_CustomTool")),
          z.lazy(() => model("output_NamespaceTool")),
          z.lazy(() => model("output_ToolSearchTool")),
          z.lazy(() => model("output_WebSearchPreviewTool")),
          z.lazy(() => model("output_ApplyPatchTool")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("tool_search_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    call_id: z.union([z.string(), z.null()]).default(null),
    execution: z.union([z.enum(["server", "client"]), z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.input_ShellCall = sdkObject(
  {
    action: z
      .lazy(() => model("input_ShellCallAction"))
      .refine((value) => value !== undefined, "Required field"),
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("shell_call")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    environment: z
      .union([
        z.lazy(() => model("output_LocalEnvironment")),
        z.lazy(() => model("output_ContainerReference")),
        z.null(),
      ])
      .default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.input_ShellCallAction = sdkObject(
  {
    commands: z
      .array(z.string())
      .refine((value) => value !== undefined, "Required field"),
    max_output_length: z.union([sdkInteger, z.null()]).default(null),
    timeout_ms: z.union([sdkInteger, z.null()]).default(null),
  },
  true,
);
models.input_ShellCallOutput = sdkObject(
  {
    call_id: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .array(
        z.lazy(() => model("input_ResponseFunctionShellCallOutputContent")),
      )
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("shell_call_output")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    max_output_length: z.union([sdkInteger, z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.input_ToolSearchCall = sdkObject(
  {
    arguments: z
      .unknown()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("tool_search_call")
      .refine((value) => value !== undefined, "Required field"),
    id: z.union([z.string(), z.null()]).default(null),
    call_id: z.union([z.string(), z.null()]).default(null),
    execution: z.union([z.enum(["server", "client"]), z.null()]).default(null),
    status: z
      .union([z.enum(["in_progress", "completed", "incomplete"]), z.null()])
      .default(null),
  },
  true,
);
models.response_Conversation = sdkObject(
  { id: z.string().refine((value) => value !== undefined, "Required field") },
  true,
);
models.response_IncompleteDetails = sdkObject(
  {
    reason: z
      .union([z.enum(["max_output_tokens", "content_filter"]), z.null()])
      .default(null),
  },
  true,
);
models.response_InputTokensDetails = sdkObject(
  {
    cached_tokens: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
  },
  true,
);
models.response_OutputTokensDetails = sdkObject(
  {
    reasoning_tokens: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
  },
  true,
);
models.response_Reasoning = sdkObject(
  {
    effort: z
      .union([
        z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
        z.null(),
      ])
      .default(null),
    generate_summary: z
      .union([z.enum(["auto", "concise", "detailed"]), z.null()])
      .default(null),
    summary: z
      .union([z.enum(["auto", "concise", "detailed"]), z.null()])
      .default(null),
  },
  true,
);
models.response_ResponseError = sdkObject(
  {
    code: z
      .enum([
        "server_error",
        "rate_limit_exceeded",
        "invalid_prompt",
        "vector_store_timeout",
        "invalid_image",
        "invalid_image_format",
        "invalid_base64_image",
        "invalid_image_url",
        "image_too_large",
        "image_too_small",
        "image_parse_error",
        "image_content_policy_violation",
        "invalid_image_mode",
        "image_file_too_large",
        "unsupported_image_media_type",
        "empty_image_file",
        "failed_to_download_image",
        "image_file_not_found",
      ])
      .refine((value) => value !== undefined, "Required field"),
    message: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ResponseFormatJSONObject = sdkObject(
  {
    type: z
      .literal("json_object")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ResponseFormatText = sdkObject(
  {
    type: z
      .literal("text")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ResponseFormatTextJSONSchemaConfig = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    schema: sdkDictionary.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    type: z
      .literal("json_schema")
      .refine((value) => value !== undefined, "Required field"),
    description: z.union([z.string(), z.null()]).default(null),
    strict: z.union([sdkBoolean, z.null()]).default(null),
  },
  true,
);
models.response_ResponsePrompt = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    variables: z
      .union([
        sdkRecord(
          z.union([
            z.string(),
            z.lazy(() => model("output_ResponseInputText")),
            z.lazy(() => model("output_ResponseInputImage")),
            z.lazy(() => model("output_ResponseInputFile")),
          ]),
        ),
        z.null(),
      ])
      .default(null),
    version: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.response_ResponseTextConfig = sdkObject(
  {
    format: z
      .union([
        z.lazy(() => model("response_ResponseFormatText")),
        z.lazy(() => model("response_ResponseFormatTextJSONSchemaConfig")),
        z.lazy(() => model("response_ResponseFormatJSONObject")),
        z.null(),
      ])
      .default(null),
    verbosity: z
      .union([z.enum(["low", "medium", "high"]), z.null()])
      .default(null),
  },
  true,
);
models.response_ResponseUsage = sdkObject(
  {
    input_tokens: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    input_tokens_details: z
      .lazy(() => model("response_InputTokensDetails"))
      .refine((value) => value !== undefined, "Required field"),
    output_tokens: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    output_tokens_details: z
      .lazy(() => model("response_OutputTokensDetails"))
      .refine((value) => value !== undefined, "Required field"),
    total_tokens: sdkInteger.refine(
      (value) => value !== undefined,
      "Required field",
    ),
  },
  true,
);
models.response_ToolChoiceAllowed = sdkObject(
  {
    mode: z
      .enum(["auto", "required"])
      .refine((value) => value !== undefined, "Required field"),
    tools: z
      .array(sdkDictionary)
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("allowed_tools")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ToolChoiceApplyPatch = sdkObject(
  {
    type: z
      .literal("apply_patch")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ToolChoiceCustom = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("custom")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ToolChoiceFunction = sdkObject(
  {
    name: z.string().refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("function")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ToolChoiceMcp = sdkObject(
  {
    server_label: z
      .string()
      .refine((value) => value !== undefined, "Required field"),
    type: z
      .literal("mcp")
      .refine((value) => value !== undefined, "Required field"),
    name: z.union([z.string(), z.null()]).default(null),
  },
  true,
);
models.response_ToolChoiceShell = sdkObject(
  {
    type: z
      .literal("shell")
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
models.response_ToolChoiceTypes = sdkObject(
  {
    type: z
      .enum([
        "file_search",
        "web_search_preview",
        "computer",
        "computer_use_preview",
        "computer_use",
        "web_search_preview_2025_03_11",
        "image_generation",
        "code_interpreter",
      ])
      .refine((value) => value !== undefined, "Required field"),
  },
  true,
);
export const sdkOutputSchema: z.ZodType<unknown> = z.union([
  z.lazy(() => model("output_ResponseOutputMessage")),
  z.lazy(() => model("output_ResponseFileSearchToolCall")),
  z.lazy(() => model("output_ResponseFunctionToolCall")),
  z.lazy(() => model("output_ResponseFunctionToolCallOutputItem")),
  z.lazy(() => model("output_ResponseFunctionWebSearch")),
  z.lazy(() => model("output_ResponseComputerToolCall")),
  z.lazy(() => model("output_ResponseComputerToolCallOutputItem")),
  z.lazy(() => model("output_ResponseReasoningItem")),
  z.lazy(() => model("output_ResponseToolSearchCall")),
  z.lazy(() => model("output_ResponseToolSearchOutputItem")),
  z.lazy(() => model("output_ResponseCompactionItem")),
  z.lazy(() => model("output_ImageGenerationCall")),
  z.lazy(() => model("output_ResponseCodeInterpreterToolCall")),
  z.lazy(() => model("output_LocalShellCall")),
  z.lazy(() => model("output_LocalShellCallOutput")),
  z.lazy(() => model("output_ResponseFunctionShellToolCall")),
  z.lazy(() => model("output_ResponseFunctionShellToolCallOutput")),
  z.lazy(() => model("output_ResponseApplyPatchToolCall")),
  z.lazy(() => model("output_ResponseApplyPatchToolCallOutput")),
  z.lazy(() => model("output_McpCall")),
  z.lazy(() => model("output_McpListTools")),
  z.lazy(() => model("output_McpApprovalRequest")),
  z.lazy(() => model("output_McpApprovalResponse")),
  z.lazy(() => model("output_ResponseCustomToolCall")),
  z.lazy(() => model("output_ResponseCustomToolCallOutputItem")),
]);
export const sdkInputSchema: z.ZodType<unknown> = z.union([
  z.lazy(() => model("input_EasyInputMessage")),
  z.lazy(() => model("input_Message")),
  z.lazy(() => model("output_ResponseOutputMessage")),
  z.lazy(() => model("output_ResponseFileSearchToolCall")),
  z.lazy(() => model("output_ResponseComputerToolCall")),
  z.lazy(() => model("input_ComputerCallOutput")),
  z.lazy(() => model("output_ResponseFunctionWebSearch")),
  z.lazy(() => model("output_ResponseFunctionToolCall")),
  z.lazy(() => model("input_FunctionCallOutput")),
  z.lazy(() => model("input_ToolSearchCall")),
  z.lazy(() => model("input_ResponseToolSearchOutputItemParam")),
  z.lazy(() => model("output_ResponseReasoningItem")),
  z.lazy(() => model("input_ResponseCompactionItemParam")),
  z.lazy(() => model("output_ImageGenerationCall")),
  z.lazy(() => model("output_ResponseCodeInterpreterToolCall")),
  z.lazy(() => model("output_LocalShellCall")),
  z.lazy(() => model("output_LocalShellCallOutput")),
  z.lazy(() => model("input_ShellCall")),
  z.lazy(() => model("input_ShellCallOutput")),
  z.lazy(() => model("input_ApplyPatchCall")),
  z.lazy(() => model("input_ApplyPatchCallOutput")),
  z.lazy(() => model("output_McpListTools")),
  z.lazy(() => model("output_McpApprovalRequest")),
  z.lazy(() => model("input_McpApprovalResponse")),
  z.lazy(() => model("output_McpCall")),
  z.lazy(() => model("input_ResponseCustomToolCallOutput")),
  z.lazy(() => model("output_ResponseCustomToolCall")),
  z.lazy(() => model("input_ItemReference")),
]);
export const sdkResponseSchema: z.ZodType<unknown> = sdkObject(
  {
    id: z.string().refine((value) => value !== undefined, "Required field"),
    created_at: sdkFloat.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    error: z
      .union([z.lazy(() => model("response_ResponseError")), z.null()])
      .default(null),
    incomplete_details: z
      .union([z.lazy(() => model("response_IncompleteDetails")), z.null()])
      .default(null),
    instructions: z
      .union([
        z.string(),
        z.array(
          z.union([
            z.lazy(() => model("input_EasyInputMessage")),
            z.lazy(() => model("input_Message")),
            z.lazy(() => model("output_ResponseOutputMessage")),
            z.lazy(() => model("output_ResponseFileSearchToolCall")),
            z.lazy(() => model("output_ResponseComputerToolCall")),
            z.lazy(() => model("input_ComputerCallOutput")),
            z.lazy(() => model("output_ResponseFunctionWebSearch")),
            z.lazy(() => model("output_ResponseFunctionToolCall")),
            z.lazy(() => model("input_FunctionCallOutput")),
            z.lazy(() => model("input_ToolSearchCall")),
            z.lazy(() => model("input_ResponseToolSearchOutputItemParam")),
            z.lazy(() => model("output_ResponseReasoningItem")),
            z.lazy(() => model("input_ResponseCompactionItemParam")),
            z.lazy(() => model("output_ImageGenerationCall")),
            z.lazy(() => model("output_ResponseCodeInterpreterToolCall")),
            z.lazy(() => model("output_LocalShellCall")),
            z.lazy(() => model("output_LocalShellCallOutput")),
            z.lazy(() => model("input_ShellCall")),
            z.lazy(() => model("input_ShellCallOutput")),
            z.lazy(() => model("input_ApplyPatchCall")),
            z.lazy(() => model("input_ApplyPatchCallOutput")),
            z.lazy(() => model("output_McpListTools")),
            z.lazy(() => model("output_McpApprovalRequest")),
            z.lazy(() => model("input_McpApprovalResponse")),
            z.lazy(() => model("output_McpCall")),
            z.lazy(() => model("input_ResponseCustomToolCallOutput")),
            z.lazy(() => model("output_ResponseCustomToolCall")),
            z.lazy(() => model("input_ItemReference")),
          ]),
        ),
        z.null(),
      ])
      .default(null),
    metadata: z.union([sdkRecord(z.string()), z.null()]).default(null),
    model: z
      .union([
        z.string(),
        z.enum([
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.4-nano",
          "gpt-5.4-mini-2026-03-17",
          "gpt-5.4-nano-2026-03-17",
          "gpt-5.3-chat-latest",
          "gpt-5.2",
          "gpt-5.2-2025-12-11",
          "gpt-5.2-chat-latest",
          "gpt-5.2-pro",
          "gpt-5.2-pro-2025-12-11",
          "gpt-5.1",
          "gpt-5.1-2025-11-13",
          "gpt-5.1-codex",
          "gpt-5.1-mini",
          "gpt-5.1-chat-latest",
          "gpt-5",
          "gpt-5-mini",
          "gpt-5-nano",
          "gpt-5-2025-08-07",
          "gpt-5-mini-2025-08-07",
          "gpt-5-nano-2025-08-07",
          "gpt-5-chat-latest",
          "gpt-4.1",
          "gpt-4.1-mini",
          "gpt-4.1-nano",
          "gpt-4.1-2025-04-14",
          "gpt-4.1-mini-2025-04-14",
          "gpt-4.1-nano-2025-04-14",
          "o4-mini",
          "o4-mini-2025-04-16",
          "o3",
          "o3-2025-04-16",
          "o3-mini",
          "o3-mini-2025-01-31",
          "o1",
          "o1-2024-12-17",
          "o1-preview",
          "o1-preview-2024-09-12",
          "o1-mini",
          "o1-mini-2024-09-12",
          "gpt-4o",
          "gpt-4o-2024-11-20",
          "gpt-4o-2024-08-06",
          "gpt-4o-2024-05-13",
          "gpt-4o-audio-preview",
          "gpt-4o-audio-preview-2024-10-01",
          "gpt-4o-audio-preview-2024-12-17",
          "gpt-4o-audio-preview-2025-06-03",
          "gpt-4o-mini-audio-preview",
          "gpt-4o-mini-audio-preview-2024-12-17",
          "gpt-4o-search-preview",
          "gpt-4o-mini-search-preview",
          "gpt-4o-search-preview-2025-03-11",
          "gpt-4o-mini-search-preview-2025-03-11",
          "chatgpt-4o-latest",
          "codex-mini-latest",
          "gpt-4o-mini",
          "gpt-4o-mini-2024-07-18",
          "gpt-4-turbo",
          "gpt-4-turbo-2024-04-09",
          "gpt-4-0125-preview",
          "gpt-4-turbo-preview",
          "gpt-4-1106-preview",
          "gpt-4-vision-preview",
          "gpt-4",
          "gpt-4-0314",
          "gpt-4-0613",
          "gpt-4-32k",
          "gpt-4-32k-0314",
          "gpt-4-32k-0613",
          "gpt-3.5-turbo",
          "gpt-3.5-turbo-16k",
          "gpt-3.5-turbo-0301",
          "gpt-3.5-turbo-0613",
          "gpt-3.5-turbo-1106",
          "gpt-3.5-turbo-0125",
          "gpt-3.5-turbo-16k-0613",
        ]),
        z.enum([
          "o1-pro",
          "o1-pro-2025-03-19",
          "o3-pro",
          "o3-pro-2025-06-10",
          "o3-deep-research",
          "o3-deep-research-2025-06-26",
          "o4-mini-deep-research",
          "o4-mini-deep-research-2025-06-26",
          "computer-use-preview",
          "computer-use-preview-2025-03-11",
          "gpt-5-codex",
          "gpt-5-pro",
          "gpt-5-pro-2025-10-06",
          "gpt-5.1-codex-max",
        ]),
      ])
      .refine((value) => value !== undefined, "Required field"),
    object: z
      .literal("response")
      .refine((value) => value !== undefined, "Required field"),
    output: z
      .array(
        z.union([
          z.lazy(() => model("output_ResponseOutputMessage")),
          z.lazy(() => model("output_ResponseFileSearchToolCall")),
          z.lazy(() => model("output_ResponseFunctionToolCall")),
          z.lazy(() => model("output_ResponseFunctionToolCallOutputItem")),
          z.lazy(() => model("output_ResponseFunctionWebSearch")),
          z.lazy(() => model("output_ResponseComputerToolCall")),
          z.lazy(() => model("output_ResponseComputerToolCallOutputItem")),
          z.lazy(() => model("output_ResponseReasoningItem")),
          z.lazy(() => model("output_ResponseToolSearchCall")),
          z.lazy(() => model("output_ResponseToolSearchOutputItem")),
          z.lazy(() => model("output_ResponseCompactionItem")),
          z.lazy(() => model("output_ImageGenerationCall")),
          z.lazy(() => model("output_ResponseCodeInterpreterToolCall")),
          z.lazy(() => model("output_LocalShellCall")),
          z.lazy(() => model("output_LocalShellCallOutput")),
          z.lazy(() => model("output_ResponseFunctionShellToolCall")),
          z.lazy(() => model("output_ResponseFunctionShellToolCallOutput")),
          z.lazy(() => model("output_ResponseApplyPatchToolCall")),
          z.lazy(() => model("output_ResponseApplyPatchToolCallOutput")),
          z.lazy(() => model("output_McpCall")),
          z.lazy(() => model("output_McpListTools")),
          z.lazy(() => model("output_McpApprovalRequest")),
          z.lazy(() => model("output_McpApprovalResponse")),
          z.lazy(() => model("output_ResponseCustomToolCall")),
          z.lazy(() => model("output_ResponseCustomToolCallOutputItem")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    parallel_tool_calls: sdkBoolean.refine(
      (value) => value !== undefined,
      "Required field",
    ),
    temperature: z.union([sdkFloat, z.null()]).default(null),
    tool_choice: z
      .union([
        z.enum(["none", "auto", "required"]),
        z.lazy(() => model("response_ToolChoiceAllowed")),
        z.lazy(() => model("response_ToolChoiceTypes")),
        z.lazy(() => model("response_ToolChoiceFunction")),
        z.lazy(() => model("response_ToolChoiceMcp")),
        z.lazy(() => model("response_ToolChoiceCustom")),
        z.lazy(() => model("response_ToolChoiceApplyPatch")),
        z.lazy(() => model("response_ToolChoiceShell")),
      ])
      .refine((value) => value !== undefined, "Required field"),
    tools: z
      .array(
        z.union([
          z.lazy(() => model("output_FunctionTool")),
          z.lazy(() => model("output_FileSearchTool")),
          z.lazy(() => model("output_ComputerTool")),
          z.lazy(() => model("output_ComputerUsePreviewTool")),
          z.lazy(() => model("output_WebSearchTool")),
          z.lazy(() => model("output_Mcp")),
          z.lazy(() => model("output_CodeInterpreter")),
          z.lazy(() => model("output_ImageGeneration")),
          z.lazy(() => model("output_LocalShell")),
          z.lazy(() => model("output_FunctionShellTool")),
          z.lazy(() => model("output_CustomTool")),
          z.lazy(() => model("output_NamespaceTool")),
          z.lazy(() => model("output_ToolSearchTool")),
          z.lazy(() => model("output_WebSearchPreviewTool")),
          z.lazy(() => model("output_ApplyPatchTool")),
        ]),
      )
      .refine((value) => value !== undefined, "Required field"),
    top_p: z.union([sdkFloat, z.null()]).default(null),
    background: z.union([sdkBoolean, z.null()]).default(null),
    completed_at: z.union([sdkFloat, z.null()]).default(null),
    conversation: z
      .union([z.lazy(() => model("response_Conversation")), z.null()])
      .default(null),
    max_output_tokens: z.union([sdkInteger, z.null()]).default(null),
    max_tool_calls: z.union([sdkInteger, z.null()]).default(null),
    previous_response_id: z.union([z.string(), z.null()]).default(null),
    prompt: z
      .union([z.lazy(() => model("response_ResponsePrompt")), z.null()])
      .default(null),
    prompt_cache_key: z.union([z.string(), z.null()]).default(null),
    prompt_cache_retention: z
      .union([z.enum(["in-memory", "24h"]), z.null()])
      .default(null),
    reasoning: z
      .union([z.lazy(() => model("response_Reasoning")), z.null()])
      .default(null),
    safety_identifier: z.union([z.string(), z.null()]).default(null),
    service_tier: z
      .union([
        z.enum(["auto", "default", "flex", "scale", "priority"]),
        z.null(),
      ])
      .default(null),
    status: z
      .union([
        z.enum([
          "completed",
          "failed",
          "in_progress",
          "cancelled",
          "queued",
          "incomplete",
        ]),
        z.null(),
      ])
      .default(null),
    text: z
      .union([z.lazy(() => model("response_ResponseTextConfig")), z.null()])
      .default(null),
    top_logprobs: z.union([sdkInteger, z.null()]).default(null),
    truncation: z.union([z.enum(["auto", "disabled"]), z.null()]).default(null),
    usage: z
      .union([z.lazy(() => model("response_ResponseUsage")), z.null()])
      .default(null),
    user: z.union([z.string(), z.null()]).default(null),
  },
  true,
);

export const sdkErrorSchema = model("response_ResponseError");
export const sdkIncompleteSchema = model("response_IncompleteDetails");
