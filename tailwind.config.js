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
  // Keep the prior production Glow banner rules while the stale banner is
  // retired from the page. This preserves the rollback CSS contract until the
  // old production version is no longer the rollback target.
  safelist: [
    "bottom-6", "ml-auto", "aspect-square", "h-1", "h-[72px]", "w-[72px]",
    "gap-5", "bg-lime-400", "from-lime-400", "via-pink-500", "to-cyan-400",
    "font-extrabold", "text-cyan-300", "text-lime-300", "text-slate-200",
    "underline-offset-2", "shadow-[0_0_16px_rgba(163,230,53,0.4)]", "ring-1",
    "ring-white/10", "hover:scale-110", "hover:bg-lime-300", "hover:text-cyan-200",
    "group-hover:block", "sm:flex", "sm:hidden", "sm:h-24", "sm:w-24", "sm:gap-5",
    "sm:py-4", "sm:text-sm", "sm:text-xl", "md:p-6",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
