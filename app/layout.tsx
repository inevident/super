import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super — NYC rentals, prechecked",
  description:
    "An agentic NYC affordable-housing marketplace that verifies eligibility and checks each building's open HPD record before you apply.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
