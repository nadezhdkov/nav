import { SESSION_LIMITS } from "@navarch/contracts";

/** An image ready for a session message: re-encoded as JPEG small enough for the daemon's limit (ADR 0074). */
export type SessionImage = { media_type: "image/jpeg"; data: string; preview: string };

/**
 * Phone photos are several megabytes; the agent needs far less. The image is scaled so its longest side is
 * at most `maxSide` and re-encoded, lowering the quality until it fits the daemon's limit.
 */
export async function prepareImage(file: Blob, maxSide = 1600): Promise<SessionImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5, 0.35]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    const data = url.slice(url.indexOf(",") + 1);
    if (data.length <= SESSION_LIMITS.imageBase64Chars) return { media_type: "image/jpeg", data, preview: url };
  }
  throw new Error("image too large");
}

/** The status line's tone: waiting for the user is the one that needs attention. */
export function statusTone(status: string): "neutral" | "warning" | "danger" | "ok" {
  return status === "waiting" ? "warning" : status === "closed" ? "neutral" : status === "working" ? "ok" : "neutral";
}
