import { deliveryCategories } from "./catalogue-data.js";
import { DeliveryMethod } from "./contracts.js";
export const DELIVERY_METHOD_CATEGORY: Readonly<
  Record<DeliveryMethod, string>
> = Object.freeze(deliveryCategories);
const customMethods = new Map<string, string>();
const builtinValues = new Set<string>(Object.values(DeliveryMethod));
for (const method of builtinValues)
  if (!Object.hasOwn(DELIVERY_METHOD_CATEGORY, method))
    throw new Error(`Missing DELIVERY_METHOD_CATEGORY entry for ${method}`);
export function deliveryMethodStr(value: DeliveryMethod | string): string {
  return value;
}
export function registerDeliveryMethod(
  value: string,
  options: { category?: string } = {},
): string {
  if (!value) throw new RangeError("Cannot register an empty delivery method.");
  const category = options.category ?? "custom";
  if (builtinValues.has(value)) {
    console.warn(
      `${JSON.stringify(value)} is already a canonical delivery method; registerDeliveryMethod is a no-op (category ${JSON.stringify(category)} discarded).`,
    );
    return value;
  }
  if (Object.hasOwn(DeliveryMethod, value)) {
    const canonical = DeliveryMethod[value as keyof typeof DeliveryMethod];
    throw new RangeError(
      `${JSON.stringify(value)} is the name of an existing DeliveryMethod, not a delivery-method value. Use ${JSON.stringify(canonical)} (already known, no registration needed).`,
    );
  }
  customMethods.set(value, category);
  return value;
}
export function isKnownDeliveryMethod(value: string): boolean {
  return builtinValues.has(value) || customMethods.has(value);
}
export function resolveDeliveryMethod(
  value: DeliveryMethod | string,
): DeliveryMethod | string {
  return value;
}
export function resolveDeliveryMethods(
  values: readonly (DeliveryMethod | string)[],
): (DeliveryMethod | string)[] {
  return [...new Set(values.map(resolveDeliveryMethod))];
}
export function clearCustomDeliveryMethods(): void {
  customMethods.clear();
}
export function listAvailableDeliveryMethods(): (DeliveryMethod | string)[] {
  return [...Object.values(DeliveryMethod), ...customMethods.keys()];
}
