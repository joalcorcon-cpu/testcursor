"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

interface AppDashboardShellProps {
  children: ReactNode;
  appTitle?: string;
}

const navigation = [
  { href: "/", label: "Scanner" },
  { href: "/grader", label: "Exam Grader" }
] as const;

export function AppDashboardShell({
  children,
  appTitle = "AERC OMR Scanner App"
}: AppDashboardShellProps) {
  const pathname = usePathname();
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    const onChange = () => {
      setIsMobileViewport(media.matches);
      if (!media.matches) {
        setIsMobileDrawerOpen(false);
      }
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const toggleSidebar = () => {
    if (isMobileViewport) {
      setIsMobileDrawerOpen((value) => !value);
      return;
    }
    setIsSidebarCollapsed((value) => !value);
  };

  const closeMobileDrawer = () => setIsMobileDrawerOpen(false);

  return (
    <main className="main dashboard-main">
      <header className="appbar">
        <div className="appbar-left">
          <button
            className="appbar-menu"
            onClick={toggleSidebar}
            type="button"
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <Image
            className="appbar-logo"
            src="/reference/aerc-logo.png"
            alt="AERC logo"
            width={34}
            height={34}
            priority
          />
          <strong>{appTitle}</strong>
        </div>
        <div className="appbar-right">
          <button className="appbar-collapse" onClick={toggleSidebar} type="button">
            {isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          </button>
        </div>
      </header>

      <section
        className={`dashboard-shell${isSidebarCollapsed ? " sidebar-collapsed" : ""}${
          isMobileDrawerOpen ? " drawer-open" : ""
        }`}
      >
        <button
          className={`drawer-backdrop${isMobileDrawerOpen ? " drawer-backdrop-visible" : ""}`}
          onClick={closeMobileDrawer}
          aria-label="Close sidebar drawer"
          type="button"
        />
        <aside className="dashboard-sidebar">
          <div className="sidebar-brand">
            <strong>AERC</strong>
            <span>Since 1999</span>
          </div>
          <button className="sidebar-close" onClick={closeMobileDrawer} type="button">
            Close
          </button>
          <nav className="sidebar-nav" aria-label="Application pages">
            {navigation.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                onClick={closeMobileDrawer}
                className={`sidebar-link${
                  pathname === entry.href ? " sidebar-link-active" : ""
                }`}
              >
                {entry.label}
              </Link>
            ))}
          </nav>
        </aside>
        <section className="dashboard-content">{children}</section>
      </section>
    </main>
  );
}
