import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { esc, loadCss } from "../common/reports/html-helpers.js";
import { loadDashboardSettings } from "../trace-finder/settings.js";
import { STATIC_DIR } from "./static-assets.js";
import { headAssets, PAIRWISE_ICON_PATH, SURFACE_LABELS } from "./view.js";

const readStatic = (name: string, encoding: "utf8" | "base64") => {
  try {
    return readFileSync(join(STATIC_DIR, name)).toString(encoding);
  } catch {
    return "";
  }
};

let css: string | undefined;
let cssVersion: string | undefined;

// Report-body tokens first, then the editorial skin and chrome rules (static/dashboard-chrome.css).
export function dashboardCss(): string {
  css ??= `${loadCss()}\n${readStatic("dashboard-chrome.css", "utf8")}\n`;
  return css;
}

export function dashboardCssVersion(): string {
  cssVersion ??= createHash("sha256")
    .update(dashboardCss())
    .digest("hex")
    .slice(0, 12);
  return cssVersion;
}

export const dashboardCssHref = () =>
  `/static/dashboard.css?v=${dashboardCssVersion()}`;

const SIDEBAR_TOGGLE_SCRIPT =
  "<script>" +
  "(function(){try{if(localStorage.getItem('eq-sidebar-collapsed')==='1')" +
  "document.documentElement.classList.add('sidebar-collapsed');}catch(e){}})();" +
  "function eqToggleSidebar(){" +
  "const c=document.documentElement.classList.toggle('sidebar-collapsed');" +
  "try{localStorage.setItem('eq-sidebar-collapsed',c?'1':'0');}catch(e){}}" +
  "document.addEventListener('keydown',function(e){" +
  "if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='b')" +
  "{e.preventDefault();eqToggleSidebar();}});" +
  "function eqFinderTab(el,id){" +
  "const root=el.closest('.rt-drawer');if(!root)return;" +
  "root.querySelectorAll('.fd-tabs [data-panel]').forEach(function(tab){tab.classList.toggle('on',tab===el);});" +
  "let panels=root.querySelectorAll('.fd-technical .fd-panel');if(!panels.length)panels=root.querySelectorAll('.fd-panel');" +
  "panels.forEach(function(panel){panel.hidden=panel.id!==id;});}" +
  "function eqFinderTraceTab(el,id){" +
  "const root=el.closest('.fd-traces');if(!root)return;" +
  "root.querySelectorAll('.fd-tabs button').forEach(function(tab){tab.classList.toggle('on',tab===el);});" +
  "root.querySelectorAll(':scope > .fd-panel').forEach(function(panel){panel.hidden=panel.id!==id;});}" +
  "if(!/Mac|iPhone|iPad/.test(navigator.platform)){" +
  "document.addEventListener('DOMContentLoaded',function(){" +
  "document.querySelectorAll('.sidebar-toggle-kbd').forEach(" +
  "function(k){k.textContent='Ctrl B';});});}" +
  "</script>\n";

const AUTH_TOAST_SCRIPT =
  "<script>" +
  "document.addEventListener('DOMContentLoaded',function(){" +
  "fetch('/auth/status',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(s){" +
  "if(s.status==='valid')return;" +
  "const id='eq-auth-toast:'+s.method+':'+s.status+':'+s.message;" +
  "try{if(sessionStorage.getItem(id))return;sessionStorage.setItem(id,'1');}catch(e){}" +
  "const toast=document.getElementById('eq-auth-toast');if(!toast)return;" +
  "toast.querySelector('.eq-auth-toast-message').textContent=s.message;" +
  "toast.hidden=false;toast.classList.toggle('is-warning',s.status==='unavailable');" +
  "const close=function(){toast.hidden=true};" +
  "toast.querySelector('button').addEventListener('click',close,{once:true});" +
  "setTimeout(close,12000);" +
  "}).catch(function(){});});" +
  "</script>";

let mark: string | undefined;
let favicon: string | undefined;

function faviconLink(): string {
  if (favicon === undefined) {
    const b64 = readStatic("orq-favicon.svg", "base64");
    favicon = b64
      ? `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${b64}">\n`
      : "";
  }
  return favicon;
}

export const FIND_ICON =
  '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><circle cx="11" cy="11" r="2"/>';
export const TRACE_ICON = '<path d="M3 12h3l3-8 6 16 3-8h3"/>';
export const COMPRESSION_ICON =
  '<path d="m4 4 5 5M4 9h5V4"/><path d="m20 20-5-5m5 0h-5v5"/>';

const NAV: readonly [string, string, string, string][] = [
  [
    "dashboard",
    "Dashboard",
    "/",
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/>' +
      '<rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  ],
  [
    "redteam",
    SURFACE_LABELS.redteam as string,
    "/?surface=redteam",
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  ],
  [
    "sim",
    SURFACE_LABELS.sim as string,
    "/?surface=sim",
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  ],
  [
    "pairwise",
    SURFACE_LABELS.pairwise as string,
    "/?surface=pairwise",
    PAIRWISE_ICON_PATH,
  ],
  ["find", "Trace search", "/find", FIND_ICON],
  ["traces", "Traces", "/traces", TRACE_ICON],
  [
    "insights",
    "Insights",
    "/insights",
    '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 6-7"/>',
  ],
  [
    "settings",
    "Settings",
    "/settings",
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  ],
];

export function icon(
  pathData: string,
  options: { cls?: string; size?: number } = {},
): string {
  const { cls = "nav-icon", size = 16 } = options;
  return (
    `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${pathData}</svg>`
  );
}

export function sidebarHtml(
  activeNav: string,
  compressionInspectorEnabled: boolean,
): string {
  mark ??= readStatic("orq-mark.svg", "utf8");
  const logoHtml = mark ? `<span class="nav-mark">${mark}</span>` : "";
  const items: string[] = [];
  for (const [key, label, href, iconPath] of NAV) {
    if (key === "settings" && compressionInspectorEnabled) {
      const inspectorActive =
        activeNav === "compression-inspector" ? " active" : "";
      items.push(
        `<a class="nav-item${inspectorActive}" href="/compression-inspector">` +
          `${icon(COMPRESSION_ICON)}<span>Compression inspector</span></a>`,
      );
    }
    const active = key === activeNav ? " active" : "";
    items.push(
      `<a class="nav-item${active}" href="${href}">${icon(iconPath)}<span>${esc(label)}</span></a>`,
    );
  }
  return (
    '<aside class="app-sidebar">' +
    `<a class="app-brand" href="/">${logoHtml}` +
    '<span class="brand-name">evaluator<span class="brand-q">q</span></span></a>' +
    `<nav class="app-nav" aria-label="Primary">${items.join("")}</nav>` +
    '<button class="sidebar-toggle" type="button" aria-label="Toggle sidebar"' +
    ' onclick="eqToggleSidebar()">' +
    '<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
    ' stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
    "<span>Collapse</span>" +
    '<kbd class="sidebar-toggle-kbd">⌘ B</kbd></button>' +
    "</aside>"
  );
}

export async function currentSidebarHtml(activeNav: string): Promise<string> {
  return sidebarHtml(
    activeNav,
    (await loadDashboardSettings()).compressionInspectorEnabled,
  );
}

function resolveNav(
  activeSurface?: string | null,
  activeNav?: string | null,
): string {
  if (activeNav) return activeNav;
  if (
    activeSurface === "redteam" ||
    activeSurface === "sim" ||
    activeSurface === "pairwise"
  )
    return activeSurface;
  return "dashboard";
}

export interface PageOptions {
  activeSurface?: string | null;
  activeNav?: string | null;
  actionsHtml?: string;
  backHtml?: string;
  bodyClass?: string;
  headHtml?: string;
  topbar?: boolean;
}

export async function page(
  title: string,
  bodyHtml: string,
  options: PageOptions = {},
): Promise<string> {
  const {
    actionsHtml = "",
    backHtml = "",
    bodyClass = "",
    headHtml = "",
    topbar = true,
  } = options;
  const cssLink = `<link rel="stylesheet" href="${dashboardCssHref()}">\n`;
  const sidebar = await currentSidebarHtml(
    resolveNav(options.activeSurface, options.activeNav),
  );
  const scripts = headAssets({
    charts: bodyHtml.includes("data-vega-for"),
  }).join("");
  const topbarLead = backHtml || `<h1 class="app-title">${esc(title)}</h1>`;
  const topbarHtml = topbar
    ? `<header class="app-topbar">\n${topbarLead}\n<div class="app-actions">${actionsHtml}</div>\n</header>\n`
    : "";
  const bodyClasses = `eq-dashboard ${bodyClass}`.trim();
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    faviconLink() +
    `<title>${esc(title)} | evaluatorq</title>\n` +
    cssLink +
    `${scripts}\n` +
    headHtml +
    "</head>\n" +
    `<body class="${bodyClasses}">\n` +
    SIDEBAR_TOGGLE_SCRIPT +
    AUTH_TOAST_SCRIPT +
    '<div class="app-shell">\n' +
    `${sidebar}\n` +
    '<div class="app-main">\n' +
    topbarHtml +
    '<main class="app-content">\n' +
    `${bodyHtml}\n` +
    "</main>\n" +
    "</div>\n" +
    "</div>\n" +
    '<div id="eq-auth-toast" class="eq-auth-toast" role="status" hidden>' +
    '<span class="eq-auth-toast-message"></span>' +
    '<a href="/settings">Settings</a>' +
    '<button type="button" aria-label="Dismiss authentication notice">&times;</button>' +
    "</div>\n" +
    "</body>\n" +
    "</html>\n"
  );
}
