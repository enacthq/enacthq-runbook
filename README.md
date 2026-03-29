# Enacthq Runbook

Documentation site built with [Kitfly](https://github.com/3leaps/kitfly) (standalone mode).

## Prerequisites

### Install Bun

This site uses [Bun](https://bun.sh) as its JavaScript runtime.

**macOS/Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows:**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

For other installation methods, see: https://bun.sh/docs/installation

### Install Dependencies

```bash
bun install
```

## Development

```bash
# Preview locally with hot reload
bun run dev

# Build static site to dist/
bun run build

# Create offline bundle (single HTML file)
bun run bundle
```

## Structure

```
enacthq-runbook/
├── site.yaml          # Site configuration
├── theme.yaml         # Theme customization (optional)
├── index.md           # Home page
├── content/           # Documentation content
├── assets/            # Static assets (images, brand files)
├── scripts/           # Build scripts (standalone)
│   ├── dev.ts         # Development server
│   ├── build.ts       # Static site generator
│   └── bundle.ts      # Single-file bundler
└── src/               # Site engine (standalone)
    ├── shared.ts      # Shared utilities
    ├── engine.ts      # Engine paths
    ├── theme.ts       # Theme system
    └── site/          # HTML template & styles
```

## Customization

- Edit `site.yaml` to configure sections and branding
- Add a `theme.yaml` for color/typography customization
- Replace files in `assets/brand/` with your logo and favicon

## Standalone Mode

This site was created with `--standalone` flag, meaning all build tooling is included.
No external kitfly installation is required.

See `.kitfly/provenance.json` for version tracking.

---
© 2026 Enacthq Runbook
