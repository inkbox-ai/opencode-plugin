import { InkboxAPIError } from "@inkbox/sdk";

// Translate an Inkbox SDK error into the most useful message for the calling
// agent. Specific 403 detail strings are hoisted to plain-language guidance so
// the model doesn't have to interpret raw API error codes.
export function inkboxErrorMessage(err: unknown): string {
  if (err instanceof InkboxAPIError) {
    const detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    if (err.statusCode === 403) {
      if (detail.includes("sender_sms_pending")) {
        return "Your Inkbox phone number is still propagating to carriers (~10–15 min after provisioning). Try again shortly.";
      }
      if (detail.includes("recipient_not_opted_in")) {
        return "Recipient has not opted in to SMS. Ask them to text START to your Inkbox number before retrying.";
      }
      if (detail.includes("recipient_opted_out")) {
        return "Recipient has opted out of SMS (texted STOP). They must text START again to opt back in.";
      }
      return `Permission denied (403): ${detail}`;
    }
    if (err.statusCode === 404) return `Not found (404): ${detail}`;
    if (err.statusCode === 409) return `Conflict (409): ${detail}`;
    if (err.statusCode === 422) return `Validation error (422): ${detail}`;
    return `Inkbox API error (${err.statusCode}): ${detail}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function mapInkboxError(err: unknown): Error {
  if (err instanceof InkboxAPIError) return new Error(inkboxErrorMessage(err));
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// Wrap a tool execute body so SDK errors surface to the model as readable
// messages. opencode treats a thrown Error as the tool's failure output.
export async function runTool<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapInkboxError(err);
  }
}
