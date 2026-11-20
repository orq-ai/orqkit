import { normalizeToList, warnIfSyncHooks } from "./async-utils.js";

/** Fails fast, before a manifest exists, when a hook lacks a lifecycle method. */
export function requireHooksLike(
  value: unknown,
  methodNames: readonly string[] = ["onConfirm"],
): void {
  const missing = methodNames.filter(
    (name) => typeof (value as Record<string, unknown>)?.[name] !== "function",
  );
  if (missing.length > 0) {
    throw new TypeError(
      `hooks entries must implement callable lifecycle methods ${JSON.stringify(missing)}; got ${String(value)} of type ${typeof value}.`,
    );
  }
}

export interface ComposeRunHooksOptions<Composite, Writer> {
  methodNames: readonly string[];
  composite: (children: unknown[]) => Composite;
  defaultHooks: () => unknown;
  manifest?: (() => Writer) | null;
  manifestHook: (writer: Writer) => unknown;
}

/**
 * Validates before minting the manifest, so a bad hook never leaves one stuck in
 * "running". The manifest recorder goes first, so a stage is durable before any
 * user hook runs.
 */
export function composeRunHooks<Composite, Writer>(
  hooks: unknown,
  options: ComposeRunHooksOptions<Composite, Writer>,
): { hooks: Composite; writer: Writer | null } {
  const { methodNames, composite, defaultHooks, manifest, manifestHook } =
    options;
  const userHooks = normalizeToList(hooks);
  for (const child of userHooks) {
    requireHooksLike(child, methodNames);
    warnIfSyncHooks(child, methodNames);
  }
  const base = userHooks.length > 0 ? userHooks : [defaultHooks()];
  const writer = manifest ? manifest() : null;
  const children = writer === null ? base : [manifestHook(writer), ...base];
  return { hooks: composite(children), writer };
}
