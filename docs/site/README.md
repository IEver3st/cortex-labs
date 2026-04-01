# site

This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

Open http://localhost:3000 with your browser to see the result.

## Explore

In the project, you can see:

- `lib/source.ts`: Code for content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) provides the interface to access your content.
- `lib/layout.shared.tsx`: Shared options for layouts, optional but preferred to keep.

| Route                     | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `app/(home)`              | The route group for your landing page and other pages. |
| `app/docs`                | The documentation layout and pages.                    |
| `app/api/search/route.ts` | The Route Handler for search.                          |
| `app/api/report-bug/route.ts` | Serverless endpoint that creates GitHub issues from the in-app bug form. |

### Fumadocs MDX

A `source.config.ts` config file has been included, you can customise different options like frontmatter schema.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Bug Report Endpoint

The docs site hosts the `POST /api/report-bug` route used by the desktop/web app bug reporter.

Required environment variables:

```bash
GITHUB_TOKEN=github_pat_or_app_token
GITHUB_OWNER=IEver3st
GITHUB_REPO=cortex-labs
BUG_REPORT_ALLOWED_ORIGINS=https://your-app-origin.example.com
BUG_REPORT_LABEL_CREATE=true
```

The app itself must point at this endpoint with:

```bash
VITE_BUG_REPORT_ENDPOINT=https://your-docs-site.example.com/api/report-bug
```

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
