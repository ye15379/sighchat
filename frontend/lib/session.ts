export async function ensureSession(
  region: string,
  locale: string,
): Promise<string | null> {
  try {
    const res = await fetch("/api/session/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ region, locale }),
    });

    if (!res.ok) {
      console.error("Failed to init session", res.status);
      return null;
    }

    const data = await res.json();
    if (!data.token) {
      console.error("No token returned from /api/session/init");
      return null;
    }

    return data.token as string;
  } catch (err) {
    console.error("Error calling /api/session/init", err);
    return null;
  }
}

