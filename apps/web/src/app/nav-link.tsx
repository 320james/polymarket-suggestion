"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Nav link that highlights itself when the current pathname matches.
 * `matchExact` exists for the root "/" link, otherwise we'd consider
 * every page a child of "/" and always highlight Suggestions.
 */
export function NavLink({
  href,
  children,
  matchExact = false,
}: {
  href: string;
  children: React.ReactNode;
  matchExact?: boolean;
}) {
  const pathname = usePathname();
  const active = matchExact ? pathname === href : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-md bg-zinc-900 px-2 py-1 font-medium text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
          : "rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }
    >
      {children}
    </Link>
  );
}
