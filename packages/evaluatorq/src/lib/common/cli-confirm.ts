import { createInterface } from "node:readline/promises";

export interface CliConfirmationIO {
  stdinIsTTY?: boolean;
  confirm?: (question: string) => boolean | Promise<boolean>;
}

export function shouldSkipConfirm(
  yes: boolean | undefined,
  io: CliConfirmationIO = {},
): boolean {
  return Boolean(yes) || !(io.stdinIsTTY ?? process.stdin.isTTY);
}

export async function confirmCliRun(
  yes: boolean | undefined,
  io: CliConfirmationIO = {},
): Promise<boolean> {
  if (shouldSkipConfirm(yes, io)) return true;
  const question = "Proceed with this run?";
  if (io.confirm) return io.confirm(question);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return /^(y|yes)$/i.test(
      (await prompt.question(`${question} [y/N]: `)).trim(),
    );
  } finally {
    prompt.close();
  }
}
