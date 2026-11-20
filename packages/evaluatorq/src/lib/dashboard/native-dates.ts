const text = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function attr(name: string, value: string): string {
  const escaped = text(value);
  return escaped.includes('"')
    ? ` ${name}='${escaped}'`
    : ` ${name}="${escaped}"`;
}

export function dateInput(options: {
  controlId: string;
  name: string;
  label: string;
  value?: string;
  form?: string | null;
  cssClass?: string | null;
  required?: boolean;
  preserve?: boolean;
  utc?: string | null;
}): string {
  const { form, cssClass, utc } = options;
  let html = `<input${attr("name", options.name)} type="date"${attr("value", options.value ?? "")}${attr("aria-label", options.label)}`;
  if (options.required) html += " required";
  if (form !== undefined && form !== null) html += attr("form", form);
  if (options.preserve) html += " hx-preserve";
  if (utc !== undefined && utc !== null) html += attr("data-utc", utc);
  html += attr("id", options.controlId);
  if (cssClass !== undefined && cssClass !== null)
    html += attr("class", cssClass);
  return `${html}>\n`;
}

export function dateRow(
  label: string,
  control: string,
  options: { cssClass: string; labelTag?: string },
): string {
  const cls = attr("class", options.cssClass);
  if (options.labelTag === "label")
    return `<label${cls}>${text(label)}${control}</label>`;
  return `<span${cls}><b>${text(label)}</b>${control}</span>`;
}
