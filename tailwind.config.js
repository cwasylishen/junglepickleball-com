/** @type {import('tailwindcss').Config} */
module.exports = {
  // Every file that puts a Tailwind class on the page is listed here, so the
  // purge can never drop a class that some page uses (the 45f50c9 homepage
  // regression investigation, 2026-10-05). Rules:
  //   - every .html the site serves with assets/styles.css (the glob below
  //     picks up a new page on its own; portal/ has its own build and its own
  //     config, tailwind.portal.config.js, and is excluded here);
  //   - inline <script> blocks live inside those .html files, so they are
  //     scanned with them (the homepage event cards are built by one);
  //   - src/worker.js, in case it ever renders HTML with classes;
  //   - any assets/**/*.js a page loads.
  content: [
    "./*.html",
    "./admin/**/*.html",
    "./glow/**/*.html",
    "./src/worker.js",
    "./assets/**/*.js",
  ],
  // Classes that exist only in data and in no scanned file would go here.
  // Checked 2026-10-05 with a read-only GET of the production KV key `events`
  // (8 events): the data holds plain text, image paths and links, no class
  // names and no markup, so nothing needs a safelist today. If KV-edited
  // content ever carries markup, list its classes here with where they come from.
  safelist: [],
  theme: {
    extend: {},
  },
  plugins: [],
};
