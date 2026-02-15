export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>signchat frontend</h1>
      <p style={{ color: "#555", marginBottom: "1.5rem" }}>Next.js app is running 🎉</p>
      <p style={{ fontSize: "0.9rem", color: "#888" }}>
        Edit <code>frontend/app/page.tsx</code> to get started.
      </p>
    </main>
  );
}
