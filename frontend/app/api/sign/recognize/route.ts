import { NextResponse } from "next/server";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

export async function POST(req: Request) {
  const startedAt = Date.now();

  const contentType = req.headers.get("content-type") || "";

  let blobSize = 0;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (file instanceof Blob) {
      blobSize = file.size;
    }
  } else {
    const blob = await req.blob();
    blobSize = blob.size;
  }

  if (blobSize > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Payload too large" },
      { status: 413 },
    );
  }

  return NextResponse.json({
    transcript: "stub: hello",
    confidence: 0.5,
    emotion: "neutral",
    latencyMs: Date.now() - startedAt,
  });
}

