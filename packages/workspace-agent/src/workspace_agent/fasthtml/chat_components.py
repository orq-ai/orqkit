"""Chat UI components for the workspace agent chat interface."""

from fasthtml.common import *
from typing import List, Dict, Any, Optional

from ..shared import AVAILABLE_MODELS


# =============================================================================
# Helper Components
# =============================================================================


# Base64 encoded Orq logo SVG
ORQ_LOGO_DATA_URL = "data:image/svg+xml;base64,PHN2ZyBjbGFzcz0idy0xMCIgdmlld0JveD0iMCAwIDEwMCAxMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHBhdGggZD0iTTgyLjkyNjggMjcuODA0OUM4Mi45MjY4IDMwLjg3ODMgODIuOTI2OCAzMi40MTUxIDgyLjMyODcgMzMuNTg5QzgxLjgwMjYgMzQuNjIxNiA4MC45NjMgMzUuNDYxMSA3OS45MzA0IDM1Ljk4NzJDNzguNzU2NSAzNi41ODU0IDc3LjIxOTggMzYuNTg1NCA3NC4xNDYzIDM2LjU4NTRINzIuMTk1MUM2OS4xMjE3IDM2LjU4NTQgNjcuNTg0OSAzNi41ODU0IDY2LjQxMSAzNS45ODcyQzY1LjM3ODQgMzUuNDYxMSA2NC41Mzg5IDM0LjYyMTYgNjQuMDEyOCAzMy41ODlDNjMuNDE0NiAzMi40MTUxIDYzLjQxNDYgMzAuODc4MyA2My40MTQ2IDI3LjgwNDlWMjUuNjA5OEM2My40MTQ2IDIyLjc2NjIgNjMuNDE0NiAyMS4zNDQ0IDYyLjkwMDUgMjAuMjQxN0M2Mi4zNTUyIDE5LjA3MjQgNjEuNDE1NCAxOC4xMzI2IDYwLjI0NjEgMTcuNTg3M0M1OS4xNDM0IDE3LjA3MzIgNTcuNzIxNiAxNy4wNzMyIDU0Ljg3ODEgMTcuMDczMkM1Mi4wMzQ1IDE3LjA3MzIgNTAuNjEyNyAxNy4wNzMyIDQ5LjUxIDE2LjU1OUM0OC4zNDA3IDE2LjAxMzcgNDcuNDAwOSAxNS4wNzM5IDQ2Ljg1NTYgMTMuOTA0NkM0Ni4zNDE1IDEyLjgwMiA0Ni4zNDE1IDExLjM4MDIgNDYuMzQxNSA4LjUzNjU5QzQ2LjM0MTUgNS42OTI5OSA0Ni4zNDE1IDQuMjcxMTkgNDYuODU1NiAzLjE2ODU2QzQ3LjQwMDkgMS45OTkyNCA0OC4zNDA3IDEuMDU5NDMgNDkuNTEgMC41MTQxNjVDNTAuNjEyNyAwIDUyLjA0NDYgMCA1NC45MDg0IDBDNTcuNzcyMyAwIDU5LjIwNDIgMCA2MC4zMDY4IDAuNTE0MTY1QzYxLjQ3NjEgMS4wNTk0MyA2Mi40MTU5IDEuOTk5MjQgNjIuOTYxMiAzLjE2ODU2QzYzLjQ3NTQgNC4yNzExOSA2My40NzU0IDUuNjkyOTkgNjMuNDc1NCA4LjUzNjU5QzYzLjQ3NTQgMTEuMzgwMiA2My40NzU0IDEyLjgwMiA2My45ODk1IDEzLjkwNDZDNjQuNTM0OCAxNS4wNzM5IDY1LjQ3NDYgMTYuMDEzNyA2Ni42NDM5IDE2LjU1OUM2Ny43NDY2IDE3LjA3MzIgNjkuMTY4NCAxNy4wNzMyIDcyLjAxMiAxNy4wNzMySDc0LjE0NjNDNzcuMjE5OCAxNy4wNzMyIDc4Ljc1NjUgMTcuMDczMiA3OS45MzA0IDE3LjY3MTNDODAuOTYzIDE4LjE5NzQgODEuODAyNiAxOS4wMzcgODIuMzI4NyAyMC4wNjk2QzgyLjkyNjggMjEuMjQzNSA4Mi45MjY4IDIyLjc4MDIgODIuOTI2OCAyNS44NTM3VjI3LjgwNDlaIiBmaWxsPSIjMTQxMzE5Ii8+CiAgPHBhdGggZD0iTTI3LjgwNDkgMTcuMDczMkMzMC44NzgzIDE3LjA3MzIgMzIuNDE1MSAxNy4wNzMyIDMzLjU4OSAxNy42NzEzQzM0LjYyMTYgMTguMTk3NCAzNS40NjExIDE5LjAzNyAzNS45ODcyIDIwLjA2OTZDMzYuNTg1NCAyMS4yNDM1IDM2LjU4NTQgMjIuNzgwMiAzNi41ODU0IDI1Ljg1MzdWMjcuODA0OUMzNi41ODU0IDMwLjg3ODMgMzYuNTg1NCAzMi40MTUxIDM1Ljk4NzIgMzMuNTg5QzM1LjQ2MTEgMzQuNjIxNiAzNC42MjE2IDM1LjQ2MTEgMzMuNTg5IDM1Ljk4NzJDMzIuNDE1MSAzNi41ODU0IDMwLjg3ODMgMzYuNTg1NCAyNy44MDQ5IDM2LjU4NTRMMjUuNjA5OCAzNi41ODU0QzIyLjc2NjIgMzYuNTg1NCAyMS4zNDQ0IDM2LjU4NTQgMjAuMjQxNyAzNy4wOTk1QzE5LjA3MjQgMzcuNjQ0OCAxOC4xMzI2IDM4LjU4NDYgMTcuNTg3MyAzOS43NTM5QzE3LjA3MzIgNDAuODU2NiAxNy4wNzMyIDQyLjI3ODQgMTcuMDczMiA0NS4xMjJDMTcuMDczMiA0Ny45NjU2IDE3LjA3MzIgNDkuMzg3NCAxNi41NTkgNTAuNDlDMTYuMDEzNyA1MS42NTkzIDE1LjA3MzkgNTIuNTk5MSAxMy45MDQ2IDUzLjE0NDRDMTIuODAyIDUzLjY1ODUgMTEuMzgwMiA1My42NTg1IDguNTM2NTkgNTMuNjU4NUM1LjY5Mjk5IDUzLjY1ODUgNC4yNzExOSA1My42NTg1IDMuMTY4NTYgNTMuMTQ0NEMxLjk5OTI0IDUyLjU5OTEgMS4wNTk0MyA1MS42NTkzIDAuNTE0MTY1IDUwLjQ5QzEuODE3MjFlLTA3IDQ5LjM4NzQgMS4yNTMwNmUtMDcgNDcuOTU1NCAxLjIzNmUtMTAgNDUuMDkxNkMtMS4yNTA1OWUtMDcgNDIuMjI3NyAtMS44MTcyMWUtMDcgNDAuNzk1OCAwLjUxNDE2NCAzOS42OTMyQzEuMDU5NDMgMzguNTIzOSAxLjk5OTI0IDM3LjU4NDEgMy4xNjg1NiAzNy4wMzg4QzQuMjcxMTkgMzYuNTI0NiA1LjY5Mjk5IDM2LjUyNDYgOC41MzY1OCAzNi41MjQ2QzExLjM4MDIgMzYuNTI0NiAxMi44MDIgMzYuNTI0NiAxMy45MDQ2IDM2LjAxMDVDMTUuMDczOSAzNS40NjUyIDE2LjAxMzcgMzQuNTI1NCAxNi41NTkgMzMuMzU2MUMxNy4wNzMyIDMyLjI1MzQgMTcuMDczMiAzMC44MzE2IDE3LjA3MzIgMjcuOTg4VjI1Ljg1MzdDMTcuMDczMiAyMi43ODAyIDE3LjA3MzIgMjEuMjQzNSAxNy42NzEzIDIwLjA2OTZDMTguMTk3NCAxOS4wMzcgMTkuMDM3IDE4LjE5NzQgMjAuMDY5NiAxNy42NzEzQzIxLjI0MzUgMTcuMDczMiAyMi43ODAyIDE3LjA3MzIgMjUuODUzNyAxNy4wNzMySDI3LjgwNDlaIiBmaWxsPSIjMTQxMzE5Ii8+CiAgPHBhdGggZD0iTTM2LjU4NTQgOTEuNDYzNEMzNi41ODU0IDg4LjYxOTggMzYuNTg1NCA4Ny4xOTggMzYuMDcxMiA4Ni4wOTU0QzM1LjUyNTkgODQuOTI2MSAzNC41ODYxIDgzLjk4NjMgMzMuNDE2OCA4My40NDFDMzIuMzE0MiA4Mi45MjY4IDMwLjg5MjQgODIuOTI2OCAyOC4wNDg4IDgyLjkyNjhIMjUuODUzN0MyMi43ODAyIDgyLjkyNjggMjEuMjQzNSA4Mi45MjY4IDIwLjA2OTYgODIuMzI4N0MxOS4wMzcgODEuODAyNiAxOC4xOTc0IDgwLjk2MyAxNy42NzEzIDc5LjkzMDRDMTcuMDczMiA3OC43NTY1IDE3LjA3MzIgNzcuMjE5OCAxNy4wNzMyIDc0LjE0NjNWNzIuMTk1MUMxNy4wNzMyIDY5LjEyMTcgMTcuMDczMiA2Ny41ODQ5IDE3LjY3MTMgNjYuNDExQzE4LjE5NzQgNjUuMzc4NCAxOS4wMzcgNjQuNTM4OSAyMC4wNjk2IDY0LjAxMjhDMjEuMjQzNSA2My40MTQ2IDIyLjc4MDIgNjMuNDE0NiAyNS44NTM3IDYzLjQxNDZMMjcuODA0OSA2My40MTQ2QzMwLjg3ODMgNjMuNDE0NiAzMi40MTUxIDYzLjQxNDYgMzMuNTg5IDY0LjAxMjhDMzQuNjIxNiA2NC41Mzg5IDM1LjQ2MTEgNjUuMzc4NCAzNS45ODcyIDY2LjQxMUMzNi41ODU0IDY3LjU4NDkgMzYuNTg1NCA2OS4xMjE3IDM2LjU4NTQgNzIuMTk1MVY3NC4zMjk1QzM2LjU4NTQgNzcuMTczMSAzNi41ODU0IDc4LjU5NDkgMzcuMDk5NSA3OS42OTc1QzM3LjY0NDggODAuODY2OSAzOC41ODQ2IDgxLjgwNjcgMzkuNzUzOSA4Mi4zNTE5QzQwLjg1NjYgODIuODY2MSA0Mi4yNzgzIDgyLjg2NjEgNDUuMTIxOSA4Mi44NjYxQzQ3Ljk2NTUgODIuODY2MSA0OS4zODczIDgyLjg2NjEgNTAuNDkgODMuMzgwM0M1MS42NTkzIDgzLjkyNTUgNTIuNTk5MSA4NC44NjUzIDUzLjE0NDQgODYuMDM0N0M1My42NTg1IDg3LjEzNzMgNTMuNjU4NSA4OC41NjkyIDUzLjY1ODUgOTEuNDMzQzUzLjY1ODUgOTQuMjk2OSA1My42NTg1IDk1LjcyODggNTMuMTQ0NCA5Ni44MzE0QzUyLjU5OTEgOTguMDAwOCA1MS42NTkzIDk4Ljk0MDYgNTAuNDkgOTkuNDg1OEM0OS4zODczIDEwMCA0Ny45NjU2IDEwMCA0NS4xMjIgMTAwQzQyLjI3ODQgMTAwIDQwLjg1NjYgMTAwIDM5Ljc1MzkgOTkuNDg1OEMzOC41ODQ2IDk4Ljk0MDYgMzcuNjQ0OCA5OC4wMDA4IDM3LjA5OTUgOTYuODMxNEMzNi41ODU0IDk1LjcyODggMzYuNTg1NCA5NC4zMDcgMzYuNTg1NCA5MS40NjM0WiIgZmlsbD0iIzE0MTMxOSIvPgogIDxwYXRoIGQ9Ik03Mi4xOTUxIDgyLjkyNjhDNjkuMTIxNyA4Mi45MjY4IDY3LjU4NDkgODIuOTI2OCA2Ni40MTEgODIuMzI4N0M2NS4zNzg0IDgxLjgwMjYgNjQuNTM4OSA4MC45NjMgNjQuMDEyOCA3OS45MzA0QzYzLjQxNDYgNzguNzU2NSA2My40MTQ2IDc3LjIxOTggNjMuNDE0NiA3NC4xNDYzVjcyLjE5NTFDNjMuNDE0NiA2OS4xMjE3IDYzLjQxNDYgNjcuNTg0OSA2NC4wMTI4IDY2LjQxMUM2NC41Mzg5IDY1LjM3ODQgNjUuMzc4NCA2NC41Mzg5IDY2LjQxMSA2NC4wMTI4QzY3LjU4NDkgNjMuNDE0NiA2OS4xMjE3IDYzLjQxNDYgNzIuMTk1MSA2My40MTQ2SDc0LjM5MDJDNzcuMjMzOCA2My40MTQ2IDc4LjY1NTYgNjMuNDE0NiA3OS43NTgzIDYyLjkwMDVDODAuOTI3NiA2Mi4zNTUyIDgxLjg2NzQgNjEuNDE1NCA4Mi40MTI3IDYwLjI0NjFDODIuOTI2OCA1OS4xNDM0IDgyLjkyNjggNTcuNzIxNiA4Mi45MjY4IDU0Ljg3ODFDODIuOTI2OCA1Mi4wMzQ1IDgyLjkyNjggNTAuNjEyNyA4My40NDEgNDkuNTFDODMuOTg2MyA0OC4zNDA3IDg0LjkyNjEgNDcuNDAwOSA4Ni4wOTU0IDQ2Ljg1NTZDODcuMTk4IDQ2LjM0MTUgODguNjE5OCA0Ni4zNDE1IDkxLjQ2MzQgNDYuMzQxNUM5NC4zMDcgNDYuMzQxNSA5NS43Mjg4IDQ2LjM0MTUgOTYuODMxNCA0Ni44NTU2Qzk4LjAwMDggNDcuNDAwOSA5OC45NDA2IDQ4LjM0MDcgOTkuNDg1OCA0OS41MUMxMDAgNTAuNjEyNyAxMDAgNTIuMDQ0NiAxMDAgNTQuOTA4NEMxMDAgNTcuNzcyMyAxMDAgNTkuMjA0MiA5OS40ODU4IDYwLjMwNjhDOTguOTQwNiA2MS40NzYxIDk4LjAwMDggNjIuNDE1OSA5Ni44MzE0IDYyLjk2MTJDOTUuNzI4OCA2My40NzU0IDk0LjMwNyA2My40NzU0IDkxLjQ2MzQgNjMuNDc1NEM4OC42MTk4IDYzLjQ3NTQgODcuMTk4IDYzLjQ3NTQgODYuMDk1NCA2My45ODk1Qzg0LjkyNjEgNjQuNTM0OCA4My45ODYzIDY1LjQ3NDYgODMuNDQxIDY2LjY0MzlDODIuOTI2OCA2Ny43NDY2IDgyLjkyNjggNjkuMTY4NCA4Mi45MjY4IDcyLjAxMlY3NC4xNDYzQzgyLjkyNjggNzcuMjE5OCA4Mi45MjY4IDc4Ljc1NjUgODIuMzI4NyA3OS45MzA0QzgxLjgwMjYgODAuOTYzIDgwLjk2MyA4MS44MDI2IDc5LjkzMDQgODIuMzI4N0M3OC43NTY1IDgyLjkyNjggNzcuMjE5OCA4Mi45MjY4IDc0LjE0NjMgODIuOTI2OEg3Mi4xOTUxWiIgZmlsbD0iIzE0MTMxOSIvPgogIDxwYXRoIGQ9Ik01MCA1OC41MzY2QzQ3LjQ0MzkgNTguNTM2NiA0Ni4xNjU5IDU4LjUzNjYgNDUuMTUwNCA1OC4xNDAzQzQzLjY0MTcgNTcuNTUxNiA0Mi40NDgzIDU2LjM1ODMgNDEuODU5NiA1NC44NDk2QzQxLjQ2MzQgNTMuODM0IDQxLjQ2MzQgNTIuNTU2IDQxLjQ2MzQgNTBDNDEuNDYzNCA0Ny40NDQgNDEuNDYzNCA0Ni4xNjYgNDEuODU5NiA0NS4xNTA0QzQyLjQ0ODMgNDMuNjQxNyA0My42NDE3IDQyLjQ0ODQgNDUuMTUwNCA0MS44NTk3QzQ2LjE2NTkgNDEuNDYzNCA0Ny40NDM5IDQxLjQ2MzQgNTAgNDEuNDYzNEM1Mi41NTYgNDEuNDYzNCA1My44MzQgNDEuNDYzNCA1NC44NDk1IDQxLjg1OTdDNTYuMzU4MiA0Mi40NDg0IDU3LjU1MTYgNDMuNjQxNyA1OC4xNDAzIDQ1LjE1MDRDNTguNTM2NSA0Ni4xNjYgNTguNTM2NSA0Ny40NDQgNTguNTM2NSA1MEM1OC41MzY1IDUyLjU1NiA1OC41MzY1IDUzLjgzNCA1OC4xNDAzIDU0Ljg0OTZDNTcuNTUxNiA1Ni4zNTgzIDU2LjM1ODIgNTcuNTUxNiA1NC44NDk1IDU4LjE0MDNDNTMuODM0IDU4LjUzNjYgNTIuNTU2IDU4LjUzNjYgNTAgNTguNTM2NloiIGZpbGw9IiMxNDEzMTkiLz4KPC9zdmc+Cg=="


def render_orq_logo(size: str = "24px") -> Img:
    """Render the Orq logo at specified size."""
    return Img(
        src=ORQ_LOGO_DATA_URL,
        alt="Orq.ai",
        style=f"width: {size}; height: {size}; border-radius: 4px;",
    )


# =============================================================================
# Chat CSS Styles
# =============================================================================

CHAT_STYLES = Style("""
/* CSS Variables */
:root {
    /* Primary - Orq Orange */
    --primary-400: #df5325;
    --primary-500: #b73e1c;
    --primary-600: #922f15;

    /* Accent - Light Orange */
    --accent-100: #fff3e9;
    --accent-200: #ffd7b5;
    --accent-300: #ff8f34;
    --accent-400: #df5325;

    /* Ink - Backgrounds and borders (light theme) */
    --ink-400: #9b9b9b;
    --ink-500: #767676;
    --ink-600: #e0e0e0;
    --ink-700: #f5f5f5;
    --ink-750: #f0f0f0;
    --ink-800: #ffffff;
    --ink-900: #f6f2f0;

    /* Text colors - dark for readability */
    --text-primary: #111111;
    --text-secondary: #222222;
    --text-muted: #222222;
    --white: #ffffff;

    /* Status colors */
    --success-green: #22c55e;
    --error-400: #d92d20;
    --error-red: #ef4444;
}

/* Full Page Chat Layout */
.chat-page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--ink-900);
}

.chat-page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: var(--white);
    border-bottom: 1px solid var(--ink-600);
}

.chat-page-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
}

.chat-page-title .icon {
    font-size: 1.5rem;
}

.chat-page-nav {
    display: flex;
    gap: 1rem;
    align-items: center;
}

.chat-page-nav a {
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    transition: all 0.2s ease;
}

.chat-page-nav a:hover {
    background: var(--ink-700);
    color: var(--primary-400);
}

.chat-page-body {
    flex: 1;
    display: flex;
    flex-direction: row;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
    overflow: hidden;
    gap: 1rem;
}

/* Sidebar */
.chat-sidebar {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
}

.chat-sidebar-section {
    background: var(--white);
    border-radius: 12px;
    border: 1px solid var(--ink-600);
    padding: 1rem;
}

.chat-sidebar-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
    letter-spacing: 0.5px;
}

.chat-sidebar-field {
    margin-bottom: 1rem;
}

.chat-sidebar-field:last-child {
    margin-bottom: 0;
}

.chat-sidebar-field label {
    display: block;
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin-bottom: 0.5rem;
}

.chat-sidebar-field select,
.chat-sidebar-field input[type="range"],
.chat-sidebar-field input[type="text"],
.chat-sidebar-field input[type="password"] {
    width: 100%;
}

.chat-sidebar-field select,
.chat-sidebar-field input[type="text"],
.chat-sidebar-field input[type="password"] {
    padding: 0.5rem;
    border: 1px solid var(--ink-600);
    border-radius: 6px;
    background: var(--white);
    font-size: 0.85rem;
    color: var(--text-primary);
}

.chat-sidebar-field select:focus,
.chat-sidebar-field input[type="text"]:focus,
.chat-sidebar-field input[type="password"]:focus {
    outline: none;
    border-color: var(--primary-400);
}

.chat-sidebar-field input[type="password"] {
    font-family: monospace;
}

/* Toggle switch for MCP - simple checkbox style */
.toggle-container {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.toggle-label {
    font-size: 0.85rem;
    color: var(--text-secondary);
}

.toggle-checkbox {
    width: 18px;
    height: 18px;
    accent-color: var(--primary-400);
    cursor: pointer;
}

.toggle-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
}

.chat-page-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--white);
    border-radius: 12px;
    border: 1px solid var(--ink-600);
    overflow: hidden;
    min-width: 0;
}

/* Chat Config Panel - deprecated, kept for embedded mode */
.chat-config {
    padding: 12px 16px;
    background: var(--ink-700);
    border-bottom: 1px solid var(--ink-600);
}

.chat-config summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 0.85rem;
    user-select: none;
}

.chat-config summary:hover {
    color: var(--text-primary);
}

.chat-config-content {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
}

.chat-config-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.chat-config-field label {
    font-size: 0.75rem;
    color: var(--text-muted);
}

.chat-config-field select,
.chat-config-field input {
    padding: 6px 10px;
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 0.85rem;
}

.chat-config-field select:focus,
.chat-config-field input:focus {
    outline: none;
    border-color: var(--primary-400);
}

/* Chat Messages Container */
.chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--ink-900);
}

.chat-messages::-webkit-scrollbar {
    width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
    background: var(--ink-700);
}

.chat-messages::-webkit-scrollbar-thumb {
    background: var(--ink-500);
    border-radius: 3px;
}

/* Chat Message Bubbles */
.chat-message {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 0.9rem;
    line-height: 1.4;
    word-wrap: break-word;
}

.chat-message.user {
    align-self: flex-end;
    background: var(--primary-400);
    color: white;
    border-bottom-right-radius: 4px;
}

.chat-message.assistant {
    align-self: flex-start;
    background: var(--white);
    color: var(--text-primary);
    border: 1px solid var(--ink-600);
    border-bottom-left-radius: 4px;
    white-space: pre-wrap;
}

.chat-message.tool {
    align-self: flex-start;
    background: var(--ink-750);
    border: 1px solid var(--ink-600);
    border-left: 3px solid var(--primary-400);
    color: var(--text-secondary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 0.85rem;
    max-width: 95%;
    padding: 10px 12px;
}

.chat-message.tool .tool-name {
    color: var(--primary-400);
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 6px;
}

.chat-message.tool .tool-args {
    color: var(--text-muted);
    font-size: 0.8rem;
    font-family: monospace;
    background: var(--ink-700);
    padding: 6px 8px;
    border-radius: 4px;
    margin-bottom: 8px;
    white-space: pre-wrap;
    word-break: break-word;
}

.chat-message.tool .tool-result {
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-family: monospace;
    border-top: 1px solid var(--ink-600);
    padding-top: 8px;
    margin-top: 4px;
    word-break: break-word;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    background: var(--ink-700);
    padding: 8px;
    border-radius: 4px;
}

.chat-message.tool .tool-result::-webkit-scrollbar {
    width: 4px;
}

.chat-message.tool .tool-result::-webkit-scrollbar-track {
    background: var(--ink-600);
}

.chat-message.tool .tool-result::-webkit-scrollbar-thumb {
    background: var(--ink-500);
    border-radius: 2px;
}

.chat-message.tool .tool-error {
    color: var(--error-red);
    font-size: 0.85rem;
    border-top: 1px solid var(--ink-600);
    padding-top: 8px;
    margin-top: 4px;
}

/* Markdown styles for assistant messages */
.chat-message.assistant {
    white-space: normal;
}

.chat-message.assistant p {
    margin: 0 0 8px 0;
}

.chat-message.assistant p:last-child {
    margin-bottom: 0;
}

.chat-message.assistant code {
    background: var(--ink-700);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.85em;
}

.chat-message.assistant pre {
    background: var(--ink-700);
    padding: 10px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
}

.chat-message.assistant pre code {
    background: none;
    padding: 0;
}

.chat-message.assistant ul,
.chat-message.assistant ol {
    margin: 8px 0;
    padding-left: 20px;
}

.chat-message.assistant li {
    margin: 4px 0;
}

.chat-message.assistant strong {
    font-weight: 600;
}

.chat-message.assistant h1,
.chat-message.assistant h2,
.chat-message.assistant h3 {
    margin: 12px 0 8px 0;
    font-weight: 600;
}

.chat-message.assistant h1 { font-size: 1.2em; }
.chat-message.assistant h2 { font-size: 1.1em; }
.chat-message.assistant h3 { font-size: 1em; }

/* Typing Indicator */
.chat-typing {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 12px 16px;
    background: var(--white);
    border: 1px solid var(--ink-600);
    border-radius: 12px;
    border-bottom-left-radius: 4px;
}

.chat-typing span {
    width: 8px;
    height: 8px;
    background: var(--text-muted);
    border-radius: 50%;
    animation: typing 1.4s infinite ease-in-out both;
}

.chat-typing span:nth-child(1) { animation-delay: 0s; }
.chat-typing span:nth-child(2) { animation-delay: 0.2s; }
.chat-typing span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
    40% { transform: scale(1); opacity: 1; }
}

/* Chat Input Area */
.chat-input-area {
    padding: 12px 16px;
    background: var(--white);
    border-top: 1px solid var(--ink-600);
}

.chat-input-form {
    display: flex;
    flex-direction: row;
    gap: 8px;
    align-items: center;
    width: 100%;
}

.chat-input-area input.chat-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    padding: 10px 14px;
    background: var(--ink-700);
    border: 1px solid var(--ink-600);
    border-radius: 20px;
    color: var(--text-primary);
    font-size: 0.9rem;
    line-height: 1.4;
}

.chat-input-area input.chat-input:focus {
    outline: none;
    border-color: var(--primary-400);
    box-shadow: 0 0 0 3px rgba(223, 83, 37, 0.15);
}

.chat-input-area input.chat-input::placeholder {
    color: var(--text-muted);
}

.chat-input-area button.chat-send-btn {
    flex: 0 0 40px;
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    max-width: 40px;
    max-height: 40px;
    padding: 0;
    border-radius: 50%;
    background: var(--primary-400);
    color: white;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: all 0.2s ease;
}

.chat-input-area button.chat-send-btn:hover {
    background: var(--primary-500);
    transform: scale(1.05);
}

.chat-input-area button.chat-send-btn:disabled {
    background: var(--ink-600);
    cursor: not-allowed;
    transform: none;
}

/* Empty State */
.chat-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    text-align: center;
    padding: 24px;
}

.chat-empty .icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.5;
}

.chat-empty p {
    margin: 0;
    font-size: 0.9rem;
}

.chat-empty .hint {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 8px;
}

/* Status indicators */
.chat-status {
    padding: 8px 16px;
    background: var(--ink-700);
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    border-bottom: 1px solid var(--ink-600);
}

.chat-status.error {
    background: rgba(217, 45, 32, 0.1);
    color: var(--error-400);
}

.chat-status.connected {
    color: var(--success-green);
}
""")


# =============================================================================
# Chat UI Components
# =============================================================================


def render_chat_button(is_open: bool = False) -> Div:
    """Render the floating chat toggle button."""
    return Div(
        Button(
            "💬" if not is_open else "✕",
            cls=f"chat-toggle-btn {'active' if is_open else ''}",
            hx_get="/chat/toggle",
            hx_target="#chat-container",
            hx_swap="innerHTML",
            title="Toggle Chat Assistant",
        ),
        id="chat-button",
    )


def render_chat_config(
    current_model: str = "google/gemini-2.5-flash",
    current_temp: float = 0.7,
) -> Details:
    """Render the collapsible chat configuration panel (for embedded mode)."""
    model_options = [
        Option(model, value=model, selected=(model == current_model))
        for model in AVAILABLE_MODELS
    ]

    return Details(
        Summary("Settings"),
        Div(cls="chat-config-content")(
            Div(cls="chat-config-field")(
                Label("Model", fr="chat-model"),
                Select(
                    *model_options,
                    name="chat_model",
                    id="chat-model",
                    hx_post="/chat/config",
                    hx_trigger="change",
                    hx_swap="none",
                ),
            ),
            Div(cls="chat-config-field")(
                Label("Temperature", fr="chat-temp"),
                Input(
                    type="range",
                    name="chat_temp",
                    id="chat-temp",
                    min="0",
                    max="1",
                    step="0.1",
                    value=str(current_temp),
                    hx_post="/chat/config",
                    hx_trigger="change",
                    hx_swap="none",
                ),
            ),
        ),
        cls="chat-config",
    )


def render_chat_sidebar(
    current_model: str = "google/gemini-2.5-flash",
    current_temp: float = 0.7,
    use_mcp: bool = False,
    customer_api_key: str = "",
) -> Div:
    """Render the chat sidebar with settings."""
    model_options = [
        Option(model, value=model, selected=(model == current_model))
        for model in AVAILABLE_MODELS
    ]

    return Div(cls="chat-sidebar")(
        # API Settings Section
        Div(cls="chat-sidebar-section")(
            Div("API Settings", cls="chat-sidebar-title"),
            Div(cls="chat-sidebar-field")(
                Label("Customer API Key", fr="customer-api-key"),
                Input(
                    type="password",
                    name="customer_api_key",
                    id="customer-api-key",
                    value=customer_api_key,
                    placeholder="orq-...",
                    hx_post="/chat/config",
                    hx_trigger="change",
                    hx_swap="none",
                ),
                Div(
                    "Required for SDK tools to manage your workspace",
                    cls="toggle-hint",
                ),
            ),
        ),
        # Model Settings Section
        Div(cls="chat-sidebar-section")(
            Div("Model Settings", cls="chat-sidebar-title"),
            Div(cls="chat-sidebar-field")(
                Label("Model", fr="chat-model"),
                Select(
                    *model_options,
                    name="chat_model",
                    id="chat-model",
                    hx_post="/chat/config",
                    hx_trigger="change",
                    hx_swap="none",
                ),
            ),
            Div(cls="chat-sidebar-field")(
                Label(f"Temperature: {current_temp}", fr="chat-temp", id="temp-label"),
                Input(
                    type="range",
                    name="chat_temp",
                    id="chat-temp",
                    min="0",
                    max="1",
                    step="0.1",
                    value=str(current_temp),
                    hx_post="/chat/config",
                    hx_trigger="change",
                    hx_swap="none",
                    oninput="document.getElementById('temp-label').textContent = 'Temperature: ' + this.value",
                ),
            ),
        ),
        # Tools Section
        Div(cls="chat-sidebar-section")(
            Div("Tools", cls="chat-sidebar-title"),
            Div(cls="chat-sidebar-field")(
                Div(cls="toggle-container")(
                    Input(
                        type="checkbox",
                        name="use_mcp",
                        id="use-mcp",
                        checked=use_mcp,
                        hx_post="/chat/config",
                        hx_trigger="change",
                        hx_swap="none",
                        cls="toggle-checkbox",
                    ),
                    Label("Use MCP", fr="use-mcp", cls="toggle-label"),
                ),
                Div(
                    "MCP uses TypeScript server tools instead of SDK",
                    cls="toggle-hint",
                ),
            ),
        ),
    )


def render_chat_message(message: Dict[str, Any]) -> Div:
    """Render a single chat message."""
    role = message.get("role", "assistant")
    content = message.get("content", "")

    if role == "user":
        return Div(content, cls="chat-message user")

    elif role == "assistant":
        return Div(content, cls="chat-message assistant")

    elif role == "tool":
        tool_name = message.get("tool_name", "Unknown Tool")
        tool_args = message.get("tool_args", {})
        tool_result = message.get("tool_result", "")
        tool_error = message.get("tool_error")

        # Format arguments nicely (truncate args for display, but keep full result)
        if tool_args:
            args_parts = []
            for k, v in tool_args.items():
                v_str = str(v)
                # Only truncate argument display, not results
                if len(v_str) > 100:
                    v_str = v_str[:100] + "..."
                args_parts.append(f"{k}: {v_str}")
            args_str = "\n".join(args_parts)
        else:
            args_str = ""

        # Build result section - full output with scrollable container
        result_section = None
        if tool_error:
            result_section = Div(f"❌ Error: {tool_error}", cls="tool-error")
        elif tool_result:
            result_section = Div(tool_result, cls="tool-result")

        return Div(cls="chat-message tool")(
            Div(f"🔧 {tool_name}", cls="tool-name"),
            Div(args_str, cls="tool-args") if args_str else None,
            result_section,
        )

    return Div(content, cls="chat-message assistant")


def render_chat_messages(messages: List[Dict[str, Any]]) -> Div:
    """Render the chat messages container."""
    if not messages:
        return Div(cls="chat-messages", id="chat-messages")(
            Div(cls="chat-empty")(
                render_orq_logo("48px"),
                P("Chat with the Workspace Assistant"),
                P(
                    "I can help you create datasets, prompts, and manage your workspace.",
                    cls="hint",
                ),
            )
        )

    return Div(
        *[render_chat_message(msg) for msg in messages],
        cls="chat-messages",
        id="chat-messages",
    )


def render_typing_indicator() -> Div:
    """Render the typing indicator."""
    return Div(cls="chat-typing", id="chat-typing")(
        Span(),
        Span(),
        Span(),
    )


def render_chat_input() -> Div:
    """Render the chat input area with proper SSE handling."""
    # JavaScript to handle chat submission with SSE
    chat_submit_script = Script("""
    // Helper to escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function submitChatMessage(event) {
        event.preventDefault();
        const form = event.target;
        const input = form.querySelector('input[name="message"]');
        const message = input.value.trim();
        if (!message) return;

        const messagesContainer = document.getElementById('chat-messages');
        const sendBtn = form.querySelector('.chat-send-btn');

        // Immediately show user message and clear input
        const userMsgHtml = '<div class="chat-message user">' + escapeHtml(message) + '</div>';
        messagesContainer.insertAdjacentHTML('beforeend', userMsgHtml);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        // Clear input immediately for better UX
        const formData = new FormData(form);
        input.value = '';

        // Only disable send button - allow typing next message while waiting
        sendBtn.disabled = true;

        fetch('/chat/send', {
            method: 'POST',
            body: formData,
            credentials: 'include',  // Important: include session cookie
        }).then(response => {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentEvent = 'message';
            let currentData = [];

            function processEvent(eventType, dataLines) {
                // SSE sends multi-line data as multiple "data:" lines
                // Join with newlines to reconstruct original content
                // Also trim leading space after "data: "
                const data = dataLines.map(line => line.startsWith(' ') ? line.substring(1) : line).join('\\n');
                if (!data.trim()) return;

                if (eventType === 'typing') {
                    const existing = document.getElementById('chat-typing');
                    if (!existing) {
                        messagesContainer.insertAdjacentHTML('beforeend', data);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }
                } else if (eventType === 'typing_done') {
                    const typing = document.getElementById('chat-typing');
                    if (typing) typing.remove();
                } else if (eventType === 'user_message') {
                    // Skip - we already added user message immediately on submit
                } else if (eventType === 'tool_message') {
                    // Show tool calls as intermediate steps
                    const typing = document.getElementById('chat-typing');
                    if (typing) typing.remove();
                    messagesContainer.insertAdjacentHTML('beforeend', data);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    // Re-add typing indicator after tool message (agent still processing)
                    if (!document.getElementById('chat-typing')) {
                        const typingHtml = '<div class="chat-typing" id="chat-typing"><span></span><span></span><span></span></div>';
                        messagesContainer.insertAdjacentHTML('beforeend', typingHtml);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }
                } else if (eventType === 'assistant_message') {
                    const typing = document.getElementById('chat-typing');
                    if (typing) typing.remove();
                    messagesContainer.insertAdjacentHTML('beforeend', data);
                    // Render markdown in the newly added assistant message
                    const assistantMsgs = messagesContainer.querySelectorAll('.chat-message.assistant');
                    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                    if (lastMsg && typeof marked !== 'undefined') {
                        const rawText = lastMsg.textContent;
                        lastMsg.innerHTML = marked.parse(rawText);
                    }
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                } else if (eventType === 'error') {
                    const typing = document.getElementById('chat-typing');
                    if (typing) typing.remove();
                    messagesContainer.insertAdjacentHTML('beforeend', data);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                } else if (eventType === 'done') {
                    const typing = document.getElementById('chat-typing');
                    if (typing) typing.remove();
                }
            }

            function processStream() {
                return reader.read().then(({ done, value }) => {
                    if (done) {
                        // Process any remaining event
                        if (currentData.length > 0) {
                            processEvent(currentEvent, currentData);
                        }
                        // Re-enable send button (input was never disabled)
                        sendBtn.disabled = false;
                        // Only focus if input is empty (don't interrupt typing)
                        if (!input.value.trim()) {
                            input.focus();
                        }
                        return;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('event:')) {
                            // New event starting - process previous if exists
                            if (currentData.length > 0) {
                                processEvent(currentEvent, currentData);
                                currentData = [];
                            }
                            currentEvent = line.substring(6).trim();
                        } else if (line.startsWith('data:')) {
                            // Accumulate data lines (SSE sends multi-line as multiple data: lines)
                            currentData.push(line.substring(5));
                        } else if (line === '') {
                            // Empty line marks end of event
                            if (currentData.length > 0) {
                                processEvent(currentEvent, currentData);
                                currentData = [];
                                currentEvent = 'message';
                            }
                        }
                    }

                    return processStream();
                });
            }

            return processStream();
        }).catch(error => {
            console.error('Chat error:', error);
            sendBtn.disabled = false;
            const typing = document.getElementById('chat-typing');
            if (typing) typing.remove();
        });
    }
    """)

    return Div(cls="chat-input-area")(
        chat_submit_script,
        Form(
            cls="chat-input-form",
            onsubmit="submitChatMessage(event)",
        )(
            Input(
                type="text",
                name="message",
                placeholder="Type a message...",
                cls="chat-input",
                autocomplete="off",
                required=True,
            ),
            Button("➤", type="submit", cls="chat-send-btn"),
        ),
    )


def render_chat_panel(
    messages: Optional[List[Dict[str, Any]]] = None,
    chat_id: Optional[str] = None,
    model: str = "google/gemini-2.5-flash",
    temperature: float = 0.7,
    is_open: bool = True,
    status: Optional[str] = None,
    error: Optional[str] = None,
) -> Div:
    """Render the complete chat panel."""
    messages = messages or []

    status_div = None
    if error:
        status_div = Div(f"Error: {error}", cls="chat-status error")
    elif status:
        status_div = Div(status, cls="chat-status connected")

    return Div(cls=f"chat-panel {'hidden' if not is_open else ''}", id="chat-panel")(
        # Header
        Div(cls="chat-header")(
            Div(cls="chat-header-title")(
                render_orq_logo("24px"),
                Span("Workspace Assistant"),
            ),
            Button(
                "✕",
                cls="chat-close-btn",
                hx_get="/chat/toggle",
                hx_target="#chat-container",
                hx_swap="innerHTML",
            ),
        ),
        # Status (if any)
        status_div,
        # Config
        render_chat_config(model, temperature),
        # Messages
        render_chat_messages(messages),
        # Input
        render_chat_input(),
        # Hidden chat ID
        Input(type="hidden", name="chat_id", value=chat_id or "", id="chat-id"),
    )


def render_chat_container(is_open: bool = False, **panel_kwargs) -> Div:
    """Render the complete chat container with button and panel."""
    return Div(id="chat-container")(
        CHAT_STYLES,
        render_chat_panel(is_open=is_open, **panel_kwargs) if is_open else None,
        render_chat_button(is_open=is_open),
    )


# =============================================================================
# SSE Message Helpers
# =============================================================================


def chat_message_html(message: Dict[str, Any]) -> str:
    """Generate HTML string for a chat message (for SSE)."""
    return to_xml(render_chat_message(message))


def chat_typing_html() -> str:
    """Generate HTML string for typing indicator (for SSE)."""
    return to_xml(render_typing_indicator())


# =============================================================================
# Full Page Chat Layout
# =============================================================================


def render_chat_page(
    messages: Optional[List[Dict[str, Any]]] = None,
    chat_id: Optional[str] = None,
    model: str = "google/gemini-2.5-flash",
    temperature: float = 0.7,
    use_mcp: bool = False,
    customer_api_key: str = "",
    error: Optional[str] = None,
):
    """Render a full-page chat interface with sidebar."""
    messages = messages or []

    # Marked.js for markdown rendering
    marked_script = Script(src="https://cdn.jsdelivr.net/npm/marked/marked.min.js")

    # Script to render markdown for existing messages on page load
    markdown_init_script = Script("""
    document.addEventListener('DOMContentLoaded', function() {
        if (typeof marked !== 'undefined') {
            const assistantMsgs = document.querySelectorAll('.chat-message.assistant');
            assistantMsgs.forEach(function(msg) {
                const rawText = msg.textContent;
                msg.innerHTML = marked.parse(rawText);
            });
        }
    });
    """)

    # Base reset styles
    base_styles = Style("""
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    """)

    status_div = None
    if error:
        status_div = Div(f"Error: {error}", cls="chat-status error")

    return Div(cls="chat-page")(
        # Styles first
        CHAT_STYLES,
        base_styles,
        marked_script,
        markdown_init_script,
        # Header with navigation
        Div(cls="chat-page-header")(
            Div(cls="chat-page-title")(
                render_orq_logo("28px"),
                Span("Workspace Assistant"),
            ),
            Div(cls="chat-page-nav")(
                A("← Back to Setup", href="/"),
            ),
        ),
        # Main chat body with sidebar
        Div(cls="chat-page-body")(
            # Sidebar with settings
            render_chat_sidebar(model, temperature, use_mcp, customer_api_key),
            # Main chat panel
            Div(cls="chat-page-panel")(
                # Status (if any)
                status_div,
                # Messages
                render_chat_messages(messages),
                # Input
                render_chat_input(),
                # Hidden chat ID
                Input(type="hidden", name="chat_id", value=chat_id or "", id="chat-id"),
            ),
        ),
    )
