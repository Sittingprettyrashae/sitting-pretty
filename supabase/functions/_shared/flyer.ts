// Broadcast flyers: check the picture she attached, put it in Supabase
// Storage, and hand back a public URL the email can point at.
//
// Why Storage and not the email itself: a base64 picture inlined into every
// message would multiply her send size by the number of clients, and plenty
// of phone mail apps refuse to show large inline attachments at all. One
// upload, one URL, every client sees the same flyer.
//
// The bucket is created in schema.sql and is public on purpose (a signed URL
// would expire and leave a broken picture in a message she already sent).
// Uploading happens with the service role key AFTER requireAdmin, so she is
// the only one who can put anything in it.

import { adminDb } from "./db.ts";
import { HttpError } from "./http.ts";

const BUCKET = "flyers";

// API.md: jpeg, png, webp, 5 MB decoded.
export const MAX_FLYER_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const TOO_BIG = "That flyer is too big. Pick one under 5 MB.";
const WRONG_TYPE = "That flyer has to be a JPG, PNG, or WEBP picture.";
const UNREADABLE = "That flyer did not come through. Attach it again.";

/** What the bytes actually are, from their magic number, or null if unknown. */
function sniffImageType(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e &&
    buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Takes a `data:image/jpeg;base64,...` URL, returns the public URL of the
 * stored file. Throws HttpError(400) with a plain message when the picture is
 * the wrong type, too big, or not readable.
 */
export async function storeFlyer(dataUrl: string): Promise<string> {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) throw new HttpError(400, UNREADABLE);

  const mime = match[1].toLowerCase();
  const ext = EXTENSIONS[mime];
  if (!ext) throw new HttpError(400, WRONG_TYPE);

  const encoded = match[2].replace(/\s+/g, "");
  if (!encoded) throw new HttpError(400, UNREADABLE);
  // Check the size from the encoded length FIRST. Decoding a huge string to
  // measure it is exactly how an oversized upload takes the function down.
  // 4 base64 characters carry 3 bytes.
  if (Math.floor(encoded.length / 4) * 3 > MAX_FLYER_BYTES + 3) {
    throw new HttpError(400, TOO_BIG);
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw new HttpError(400, UNREADABLE);
  }
  if (bytes.length === 0) throw new HttpError(400, UNREADABLE);
  if (bytes.length > MAX_FLYER_BYTES) throw new HttpError(400, TOO_BIG);

  // The declared type is just a claim in a string the caller wrote. Check the
  // actual bytes, so a file that says image/png but is not one never gets
  // stored and handed back as a link her clients open. The demo server does
  // the same check; the two must not disagree about what is safe to store.
  if (sniffImageType(bytes) !== mime) throw new HttpError(400, WRONG_TYPE);

  // Random name, never anything she typed: a filename built from her subject
  // line would be guessable and could collide.
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const storage = adminDb().storage.from(BUCKET);

  const uploaded = await storage.upload(path, bytes, {
    contentType: mime,
    cacheControl: "31536000",
    upsert: false,
  });
  if (uploaded.error) {
    console.error("flyer upload failed:", uploaded.error.message);
    throw new HttpError(500, "Could not save that flyer. Try sending it again.");
  }

  const publicUrl = storage.getPublicUrl(path).data?.publicUrl;
  if (!publicUrl) throw new HttpError(500, "Could not save that flyer. Try sending it again.");
  return publicUrl;
}
