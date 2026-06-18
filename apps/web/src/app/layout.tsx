import type { Metadata } from "next";
import Link from "next/link";
import { NavLink } from "./nav-link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polymarket Suggestions",
  description: "Personal Polymarket suggestion engine dashboard.",
};

/**
 * Root layout — top bar wraps on narrow screens so all nav links stay
 * visible on mobile. Content sits in a max-width container below.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:gap-x-6 sm:px-6">
            <Link
              href="/"
              className="font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
            >
              <span className="hidden sm:inline">Polymarket Suggestions</span>
              <span className="sm:hidden">Polymarket</span>
            </Link>
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-zinc-600 sm:gap-x-2 dark:text-zinc-400">
              <NavLink href="/" matchExact>
                Suggestions
              </NavLink>
              <NavLink href="/traders">Traders</NavLink>
              <NavLink href="/runs">Runs</NavLink>
              <NavLink href="/config">Config</NavLink>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
