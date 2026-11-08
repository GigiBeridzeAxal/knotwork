import { type MouseEvent, useEffect } from "react";
import html from "../landing/landing.html?raw";
import "../landing/landing.css";
import { navigate } from "../router";

/**
 * The public front page. Its markup and CSS are generated from the design tokens
 * (design-system/export_app.py), so this component only wires up links.
 */
export function LandingPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = "Knotwork · Workflows that hold.";
    return () => {
      document.title = prev;
    };
  }, []);

  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      e.preventDefault();
      if (href === "#top") window.scrollTo({ top: 0, behavior: "smooth" });
      else document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (href.startsWith("/")) {
      e.preventDefault();
      navigate(href);
    }
  }

  // eslint-disable-next-line react/no-danger
  return <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
