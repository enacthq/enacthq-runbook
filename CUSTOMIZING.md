---
template: runbook
template_version: 1
created: 2026-03-29
---

# Customizing Enacthq Runbook

This guide helps you (and AI assistants) understand how to customize this runbook.

## Site Structure

```
enacthq-runbook/
├── site.yaml              # Site configuration (sections, branding)
├── theme.yaml             # Theme customization (create if needed)
├── index.md               # Home page with quick links
├── CUSTOMIZING.md         # This file
├── content/
│   ├── procedures/        # Step-by-step operational tasks
│   ├── troubleshooting/   # Problem → solution guides
│   ├── reference/         # Supporting materials
│   │   ├── interfaces/    # API specs, protocol docs
│   │   ├── contacts/      # Team and vendor contacts
│   │   ├── checklists/    # Verification checklists
│   │   └── analytics/     # Dashboards, KPIs, SLAs
│   └── incidents/         # Emergency response
└── assets/
    └── brand/             # Logo, favicon
```

## Configuration Files

### site.yaml - Site Configuration

```yaml
title: "Enacthq Runbook"

brand:
  name: "Enacthq Runbook"     # Shown in header
  url: "/"                              # Logo link destination

sections:
  - name: "Procedures"
    path: "content/procedures"
  # Add or modify sections here
```

### theme.yaml - Visual Customization (optional)

Create `theme.yaml` to customize colors and typography:

```yaml
colors:
  primary: "#2563eb"
  background: "#ffffff"
  text: "#1f2937"

footer:
  text: "© 2026 Enacthq Runbook"
```

## Header and Footer

- **Header**: Brand name/logo from `site.yaml` + section navigation
- **Footer**: Auto-generated copyright, customizable via `theme.yaml`

## Brand Assets

| Asset | Location | Recommended Size |
|-------|----------|------------------|
| Logo | `assets/brand/logo.png` | 200x50px (or SVG) |
| Logo (dark) | `assets/brand/logo-dark.png` | Same as logo, for dark backgrounds |
| Favicon | `assets/brand/favicon.ico` | 32x32px |
| Footer logo | `assets/brand/footer-logo.png` | Max height 20px |

### Header Logo

Single logo — kitfly auto-adjusts brightness in dark mode:

```yaml
brand:
  logo: "assets/brand/logo.png"
```

Light + dark variants — no automatic filters applied:

```yaml
brand:
  logo: "assets/brand/logo.png"
  logoDark: "assets/brand/logo-dark.png"
```

### Footer Logo

Add a separate logo to the footer ribbon (e.g. a parent company or client logo):

```yaml
footer:
  logo: "assets/brand/footer-logo.png"
  logoUrl: "https://example.com"       # optional link
  logoAlt: "Company Name"              # optional alt text
  logoHeight: 20                        # optional max height in px
  logoDark: "assets/brand/footer-logo-dark.png"  # optional dark variant
```

## Adding Content

### New Procedure

1. Create file in `content/procedures/`:
   ```
   content/procedures/my-procedure.md
   ```

2. Use the procedure format:
   ```markdown
   ---
   title: Procedure Name
   ---

   # Procedure Name

   ## Objective
   What this accomplishes.

   ## Prerequisites
   - [ ] Required item

   ## Steps
   1. First step
   2. Second step

   ## Verification
   How to confirm success.

   ## Rollback
   How to revert if needed.
   ```

### New Troubleshooting Guide

Follow the pattern: Symptoms → Causes → Resolution → Escalation

### New Interface/API Doc

Copy `content/reference/interfaces/api-template.md` and customize.

### New Section

1. Create folder: `content/newsection/`
2. Add to `site.yaml`:
   ```yaml
   sections:
     - name: "New Section"
       path: "content/newsection"
   ```
3. Add at least one markdown file

## Linking and References

### Internal Links

```markdown
See [Deployment](/content/procedures/deployment) procedure.
```

### External Links

```markdown
See [Vendor Documentation](https://vendor.com/docs).
```

### Images

```markdown
![Architecture](/assets/images/architecture.png)
```

## Important Limitations

- **Content must be inside this folder** - kitfly cannot include external files
- **External resources**: Link via URL rather than copying
- **Binary files** (PDFs): Place in `assets/` and link to them
- **No dynamic includes**: This generates static HTML

## Document Conventions

### Procedures

- Start with Objective (what/why)
- List Prerequisites as checkboxes
- Number steps explicitly
- Include expected outputs
- Always have Rollback section

### Troubleshooting

- Lead with Symptoms (what user sees)
- List Possible Causes
- Provide step-by-step Resolution
- Include Escalation path

### Checklists

- Use checkbox format: `- [ ] Item`
- Group by phase or category
- Include Go/No-Go decision point

## Getting Help

- [Kitfly Documentation](https://github.com/3leaps/kitfly)
- [Markdown Guide](https://www.markdownguide.org/)
