/** @type {import('tailwindcss').Config} */
// Separate Tailwind build for the portal (PIN-17/A3). This never touches
// the site's own tailwind.config.js or its compiled assets/styles.css --
// npm run build:portal writes only portal/portal.css.
module.exports = {
  content: ["./portal/**/*.html", "./portal/js/**/*.js"],
  theme: {
    extend: {
      colors: {
        jpteal: "#0f393b",
        jpyellow: "#EAB308",
      },
      fontFamily: {
        heading: ["Oswald", "sans-serif"],
        body: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
