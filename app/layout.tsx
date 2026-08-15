import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super — know your building before you move in",
  description:
    "Type your new NYC address. Super reads the building's real violation record and carts what you'll actually need.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
