import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polymarket Suggestions",
  description: "Personal Polymarket suggestion engine dashboard.",
};

/**
 * Root layout — fixed nav at the top, content in a max-width container.
 * Single-user, single-page-at-a-time browsing so we keep this minimal.
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
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <Link
              href="/"
              className="font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
            >
              Polymarket Suggestions
            </Link>
            <div className="flex items-center gap-4 text-sm text-zinc-600 dark:text-zinc-400">
              <NavLink href="/">Suggestions</NavLink>
              <NavLink href="/traders">Traders</NavLink>
              <NavLink href="/runs">Runs</NavLink>
              <NavLink href="/config">Config</NavLink>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      {children}
    </Link>
  );
}
