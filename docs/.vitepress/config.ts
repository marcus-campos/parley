import { defineConfig } from "vitepress";

export default defineConfig({
  title: "parley",
  description: "A coordination bus for concurrent agent sessions working in one repository.",
  // A project page, served from https://marcus-campos.github.io/parley/
  base: "/parley/",
  cleanUrls: true,
  lastUpdated: true,
  // Specs and plans are working documents. They live in the repository and they
  // do not publish.
  srcExclude: ["superpowers/**", "**/README.md"],
  ignoreDeadLinks: false,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-it-is" },
      { text: "Concepts", link: "/concepts/shapes" },
      { text: "Reference", link: "/PROTOCOL" },
      { text: "GitHub", link: "https://github.com/marcus-campos/parley" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What it is", link: "/guide/what-it-is" },
          { text: "Where it fits", link: "/guide/where-it-fits" },
          { text: "Install", link: "/guide/install" },
          { text: "Set up a repository", link: "/guide/setup" },
          { text: "The panel", link: "/guide/panel" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Shapes", link: "/concepts/shapes" },
          { text: "Territory", link: "/concepts/territory" },
          { text: "Permission", link: "/concepts/permission" },
          { text: "The work pool", link: "/concepts/work-pool" },
          // Capacity is deliberately absent: the feature it would describe
          // (src/spawn/birth.ts) is not on this branch, and a sidebar entry
          // pointing at a page nobody wrote is a 404 on every page of the
          // site. VitePress does not check nav or sidebar links — only links
          // inside rendered markdown — so nothing but the test in
          // tests/docs/site-build.test.ts stands between a typo here and a
          // published dead link. Add the entry back with the page, not before.
          { text: "Notes and recall", link: "/concepts/recall" },
          { text: "Presence", link: "/concepts/presence" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Commands", link: "/reference/commands" },
          { text: "Protocol", link: "/PROTOCOL" },
          { text: "Architecture", link: "/ARCHITECTURE" },
          { text: "Compatibility", link: "/reference/compatibility" },
        ],
      },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/marcus-campos/parley/edit/main/docs/:path",
    },
    footer: { message: "MIT", copyright: "parley" },
  },
});
