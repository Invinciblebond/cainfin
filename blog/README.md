# Cain Finance Blog — how to post

The blog is fully static. A post is just one Markdown file. To publish, add the
file, regenerate the manifest, and push.

## Add a new post (3 steps)

1. **Create a Markdown file** in `blog/posts/`. Name it with the URL slug you
   want, e.g. `q3-protocol-update.md` → the post lives at
   `/blog/post.html?slug=q3-protocol-update`.

   Start the file with this frontmatter block, then write the body in Markdown:

   ```markdown
   ---
   title: Q3 Protocol Update
   subtitle: What shipped this quarter and what's next.
   author: Cain Finance
   date: 2026-09-30
   categories: [Updates, Protocol]
   thumbnail: https://i.postimg.cc/your-image.png
   ---

   Your article body here. Use **bold**, _italic_, [links](https://cain.finance),
   ## headings, lists, > quotes, `code`, tables — all standard Markdown.
   ```

   | Field      | Required | Notes                                              |
   |------------|----------|----------------------------------------------------|
   | title      | yes      | Post headline.                                     |
   | subtitle   | no       | One-line summary (shown on card + under title).     |
   | author     | no       | Byline.                                            |
   | date       | no       | `YYYY-MM-DD`. Posts sort newest-first by this.      |
   | categories | no       | `[A, B]`. Become filter chips on the index.        |
   | thumbnail  | no       | Image URL. Shown as card image + article cover.     |

2. **Regenerate the manifest** from the repo root:

   ```bash
   node build-blog.js
   ```

   This rewrites `blog/posts.json` (the list the index reads). It prints the
   posts it found so you can confirm.

3. **Commit and push:**

   ```bash
   git add blog/ blog.html build-blog.js
   git commit -m "blog: add Q3 protocol update"
   git push
   ```

   Cloudflare serves the new files. Done.

## Editing or deleting a post

- **Edit:** change the `.md` file, re-run `node build-blog.js`, commit, push.
- **Delete:** remove the `.md` file, re-run `node build-blog.js`, commit, push.

## Notes

- Thumbnails are loaded by URL (e.g. a postimg/imgur/CDN link). If the link
  breaks, the card falls back to a styled gold placeholder automatically.
- `blog/posts.json` is generated — don't hand-edit it; just run the script.
- No build server is required; the script just rewrites one JSON file locally.
