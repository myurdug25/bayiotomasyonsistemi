# Sidebar BOSS Brand Lockup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved BOSS product identity below the existing sidebar logo without affecting navigation or compact layouts.

**Architecture:** Render the lockup as accessible HTML inside the existing home link and style it through the established global sidebar classes. Hide it when the sidebar or viewport cannot provide enough space.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, global CSS, Lucide React.

## Global Constraints

- Preserve the existing Güçsa and PowerSA Filter logo.
- Exact copy is `BOSS` and `Bayi Otomasyon Satış Sistemi`.
- Do not change sidebar navigation behavior.
- Do not add dependencies.

---

### Task 1: Add the responsive BOSS lockup

**Files:**
- Modify: `apps/web/src/components/layout/app-shell.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: existing `collapsed` sidebar state and theme variables.
- Produces: `.app-sidebar-boss-lockup` presentation inside the existing brand link.

- [x] **Step 1: Add semantic lockup markup with exact copy**
- [x] **Step 2: Add gold premium styling and the divider motif**
- [x] **Step 3: Hide the lockup in collapsed, narrow, and low-height layouts**
- [x] **Step 4: Run targeted frontend lint and production build**
