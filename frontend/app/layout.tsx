import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "signchat",
  description: "signchat MVP frontend",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

